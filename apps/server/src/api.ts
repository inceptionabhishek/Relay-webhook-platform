import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  Sse,
  MessageEvent,
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiHeader, ApiBody, ApiOperation } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { interval, from, concat, exhaustMap, map, takeWhile } from 'rxjs';
import { db } from './db';
import { context, propagation } from '@opentelemetry/api';
import { Prisma } from './generated/prisma/client';
import { token, hash, passwordHash, verifyPassword, encrypt } from './crypto';
import { AuthGuard, AuthRequest, browserOnly, ownerOnly, sessionUser } from './auth';
import { config } from './config';
import { resolveDestination } from './destination';
import { rateLimit } from './queue';
const email = z
  .string()
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
const name = z.string().trim().min(1).max(100);
const id = (value: string) => z.string().uuid().parse(value);
async function audit(req: AuthRequest, action: string, resourceId?: string) {
  return db.auditLog.create({
    data: {
      organizationId: req.principal.organizationId,
      actor: req.principal.actor,
      action,
      resourceId,
    },
  });
}
const publicEndpoint = (e: any) => {
  const { secretEncrypted, previousSecretEncrypted, previousSecretUntil, ...rest } = e;
  return rest;
};
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  private async loginQuota(req: Request) {
    let delay;
    try {
      delay = await rateLimit(`login:${req.ip}`, 0.2, 10);
    } catch {
      throw new ServiceUnavailableException('Authentication temporarily unavailable');
    }
    if (delay > 0) throw new HttpException('Too many authentication attempts', 429);
    if (req.headers.origin !== config.WEB_ORIGIN)
      throw new BadRequestException('Invalid request origin');
  }
  private async cookie(userId: string, res: Response) {
    const secret = token();
    await db.session.create({
      data: { userId, tokenHash: hash(secret), expiresAt: new Date(Date.now() + 7 * 86400000) },
    });
    res.cookie('relay_session', secret, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 86400000,
      path: '/',
    });
  }
  @Post('register')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'password', 'name', 'workspace'],
      properties: {
        email: { type: 'string' },
        password: { type: 'string', minLength: 12 },
        name: { type: 'string' },
        workspace: { type: 'string' },
      },
    },
  })
  async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.loginQuota(req);
    const data = z
      .object({ email, password: z.string().min(12).max(128), name, workspace: name })
      .parse(body);
    const user = await db.user.create({
      data: {
        email: data.email,
        name: data.name,
        passwordHash: await passwordHash(data.password),
        memberships: {
          create: { role: 'owner', organization: { create: { name: data.workspace } } },
        },
      },
    });
    await this.cookie(user.id, res);
    return { id: user.id, name: user.name, email: user.email };
  }
  @Post('login')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'password'],
      properties: { email: { type: 'string' }, password: { type: 'string' } },
    },
  })
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.loginQuota(req);
    const data = z.object({ email, password: z.string().min(1).max(128) }).parse(body);
    const user = await db.user.findUnique({ where: { email: data.email } });
    // Perform the KDF for missing accounts too.
    const valid = await verifyPassword(
      data.password,
      user?.passwordHash ?? `00000000000000000000000000000000:${'00'.repeat(64)}`,
    );
    if (!user || !valid) throw new UnauthorizedException('Invalid email or password');
    await this.cookie(user.id, res);
    return { id: user.id, name: user.name, email: user.email };
  }
  @Get('me')
  async me(@Req() req: Request) {
    const user = await sessionUser(req);
    const memberships = await db.membership.findMany({
      where: { userId: user.id },
      include: { organization: true },
    });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      organizations: memberships.map((m) => ({ ...m.organization, role: m.role })),
    };
  }
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await sessionUser(req, true);
    await db.session.deleteMany({ where: { tokenHash: hash(req.cookies.relay_session) } });
    res.clearCookie('relay_session', { path: '/' });
    return { ok: true };
  }
  @Post('workspaces')
  async workspace(@Body() body: unknown, @Req() req: Request) {
    const user = await sessionUser(req, true);
    const data = z.object({ name }).parse(body);
    return db.organization.create({
      data: { name: data.name, memberships: { create: { userId: user.id, role: 'owner' } } },
    });
  }
  @Post('invitations/accept')
  async accept(@Body() body: unknown, @Req() req: Request) {
    const user = await sessionUser(req, true);
    const data = z.object({ token: z.string().min(20).max(200) }).parse(body);
    return db.$transaction(async (tx) => {
      const invite = await tx.invitation.findUnique({ where: { tokenHash: hash(data.token) } });
      if (
        !invite ||
        invite.email !== user.email ||
        invite.expiresAt <= new Date() ||
        invite.acceptedAt
      )
        throw new BadRequestException('Invitation is invalid or expired');
      const claimed = await tx.invitation.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (!claimed.count) throw new ConflictException('Invitation already accepted');
      await tx.membership.upsert({
        where: {
          userId_organizationId: { userId: user.id, organizationId: invite.organizationId },
        },
        create: { userId: user.id, organizationId: invite.organizationId, role: 'member' },
        update: {},
      });
      await tx.auditLog.create({
        data: {
          organizationId: invite.organizationId,
          actor: user.id,
          action: 'invitation.accepted',
          resourceId: invite.id,
        },
      });
      return { organizationId: invite.organizationId };
    });
  }
}
@ApiTags('Platform')
@ApiBearerAuth()
@ApiHeader({
  name: 'X-Organization-Id',
  description: 'Required for browser session authentication',
})
@UseGuards(AuthGuard)
@Controller()
export class PlatformController {
  @Get('endpoints')
  async endpoints(@Req() req: AuthRequest) {
    browserOnly(req);
    return (
      await db.endpoint.findMany({
        where: { organizationId: req.principal.organizationId },
        orderBy: { createdAt: 'desc' },
      })
    ).map(publicEndpoint);
  }
  @Post('endpoints')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'url'],
      properties: {
        name: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        eventTypes: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  async createEndpoint(@Body() body: unknown, @Req() req: AuthRequest) {
    ownerOnly(req);
    const data = z
      .object({
        name,
        url: z.string().url().max(2048),
        eventTypes: z.array(z.string().min(1).max(100)).max(50).default([]),
      })
      .parse(body);
    await resolveDestination(data.url);
    const secret = token('whsec_');
    const endpoint = await db.endpoint.create({
      data: {
        ...data,
        organizationId: req.principal.organizationId,
        secretEncrypted: encrypt(secret),
      },
    });
    await audit(req, 'endpoint.created', endpoint.id);
    return { ...publicEndpoint(endpoint), secret };
  }
  @Patch('endpoints/:id')
  async updateEndpoint(
    @Param('id') endpointId: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    ownerOnly(req);
    const data = z
      .object({
        name: name.optional(),
        url: z.string().url().max(2048).optional(),
        enabled: z.boolean().optional(),
        eventTypes: z.array(z.string().min(1).max(100)).max(50).optional(),
      })
      .parse(body);
    if (data.url) await resolveDestination(data.url);
    const result = await db.endpoint.updateMany({
      where: { id: id(endpointId), organizationId: req.principal.organizationId },
      data,
    });
    if (!result.count) throw new NotFoundException('Endpoint not found');
    await audit(req, 'endpoint.updated', endpointId);
    return { ok: true };
  }
  @Post('endpoints/:id/rotate-secret')
  async rotateSecret(@Param('id') endpointId: string, @Req() req: AuthRequest) {
    ownerOnly(req);
    const secret = token('whsec_');
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Endpoint" WHERE id = ${id(endpointId)} FOR UPDATE`;
      const endpoint = await tx.endpoint.findFirst({
        where: { id: endpointId, organizationId: req.principal.organizationId },
      });
      if (!endpoint) throw new NotFoundException('Endpoint not found');
      await tx.endpoint.update({
        where: { id: endpointId },
        data: {
          secretEncrypted: encrypt(secret),
          previousSecretEncrypted: endpoint.secretEncrypted,
          previousSecretUntil: new Date(Date.now() + 86400000),
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: req.principal.organizationId,
          actor: req.principal.actor,
          action: 'endpoint.secret_rotated',
          resourceId: endpointId,
        },
      });
    });
    return { secret, previousSecretValidForSeconds: 86400 };
  }
  @Get('keys')
  async keys(@Req() req: AuthRequest) {
    ownerOnly(req);
    return db.apiKey.findMany({
      where: { organizationId: req.principal.organizationId },
      select: { id: true, name: true, prefix: true, createdAt: true, revokedAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }
  @Post('keys')
  async createKey(@Body() body: unknown, @Req() req: AuthRequest) {
    ownerOnly(req);
    const data = z.object({ name }).parse(body);
    const secret = token('rk_live_');
    const key = await db.apiKey.create({
      data: {
        name: data.name,
        organizationId: req.principal.organizationId,
        prefix: secret.slice(0, 16),
        tokenHash: hash(secret),
      },
    });
    await audit(req, 'key.created', key.id);
    return { id: key.id, secret, prefix: key.prefix };
  }
  @Delete('keys/:id')
  async revokeKey(@Param('id') keyId: string, @Req() req: AuthRequest) {
    ownerOnly(req);
    const changed = await db.apiKey.updateMany({
      where: { id: id(keyId), organizationId: req.principal.organizationId },
      data: { revokedAt: new Date() },
    });
    if (!changed.count) throw new NotFoundException('API key not found');
    await audit(req, 'key.revoked', keyId);
    return { ok: true };
  }
  @Post('keys/:id/rotate')
  async rotateKey(@Param('id') keyId: string, @Req() req: AuthRequest) {
    ownerOnly(req);
    const secret = token('rk_live_');
    const result = await db.$transaction(async (tx) => {
      const key = await tx.apiKey.findFirst({
        where: { id: id(keyId), organizationId: req.principal.organizationId, revokedAt: null },
      });
      if (!key) throw new NotFoundException('Active API key not found');
      await tx.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
      const next = await tx.apiKey.create({
        data: {
          name: key.name,
          organizationId: key.organizationId,
          prefix: secret.slice(0, 16),
          tokenHash: hash(secret),
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: key.organizationId,
          actor: req.principal.actor,
          action: 'key.rotated',
          resourceId: next.id,
        },
      });
      return { id: next.id, prefix: next.prefix, secret };
    });
    return result;
  }
  @Post('events')
  @ApiOperation({
    summary: 'Durably accept an event; retries with the same key return the original event',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type', 'payload'],
      properties: {
        type: { type: 'string', example: 'order.created' },
        payload: { type: 'object', additionalProperties: true },
      },
    },
  })
  async publish(@Body() body: unknown, @Req() req: AuthRequest) {
    const data = z
      .object({
        type: z
          .string()
          .regex(/^[a-zA-Z0-9_.-]+$/)
          .max(100),
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(body);
    const idempotencyKey = z.string().min(1).max(200).parse(req.headers['idempotency-key']);
    const requestHash = hash(JSON.stringify(data));
    const traceContext: Record<string, string> = {};
    propagation.inject(context.active(), traceContext);
    const organizationId = req.principal.organizationId;
    const existing = () =>
      db.event.findUnique({
        where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
        include: { deliveries: true },
      });
    const check = (event: any) => {
      if (event.requestHash !== requestHash)
        throw new ConflictException('Idempotency key already used with a different request');
      return event;
    };
    const previous = await existing();
    if (previous) return check(previous);
    try {
      return await db.$transaction(async (tx) => {
        const endpoints = await tx.endpoint.findMany({
          where: {
            organizationId,
            enabled: true,
            OR: [{ eventTypes: { isEmpty: true } }, { eventTypes: { has: data.type } }],
          },
        });
        const event = await tx.event.create({
          data: {
            organizationId,
            idempotencyKey,
            requestHash,
            traceContext,
            type: data.type,
            payload: data.payload as Prisma.InputJsonValue,
          },
        });
        for (const endpoint of endpoints) {
          await tx.delivery.create({
            data: {
              eventId: event.id,
              endpointId: endpoint.id,
              outbox: { create: { generation: 0, sequence: 0 } },
            },
          });
        }
        await tx.auditLog.create({
          data: {
            organizationId,
            actor: req.principal.actor,
            action: 'event.published',
            resourceId: event.id,
          },
        });
        return tx.event.findUniqueOrThrow({
          where: { id: event.id },
          include: { deliveries: true },
        });
      });
    } catch (error) {
      if ((error as any).code === 'P2002') {
        const event = await existing();
        if (event) return check(event);
      }
      throw error;
    }
  }
  @Get('events')
  async events(@Req() req: AuthRequest, @Query() query: Record<string, string>) {
    browserOnly(req);
    const limit = z.coerce.number().int().min(1).max(100).default(25).parse(query.limit);
    const status = z
      .enum(['pending', 'processing', 'retrying', 'throttled', 'delivered', 'failed'])
      .optional()
      .parse(query.status || undefined);
    const cursor = query.cursor ? id(query.cursor) : undefined;
    if (
      cursor &&
      !(await db.event.findFirst({
        where: { id: cursor, organizationId: req.principal.organizationId },
      }))
    )
      throw new BadRequestException('Invalid cursor');
    const rows = await db.event.findMany({
      where: {
        organizationId: req.principal.organizationId,
        ...(query.search
          ? { type: { contains: query.search.slice(0, 100), mode: 'insensitive' as const } }
          : {}),
        ...(status ? { deliveries: { some: { status } } } : {}),
      },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { deliveries: { include: { endpoint: { select: { name: true, url: true } } } } },
    });
    return {
      items: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }
  @Get('events/:id')
  async event(@Param('id') eventId: string, @Req() req: AuthRequest) {
    browserOnly(req);
    const event = await db.event.findFirst({
      where: { id: id(eventId), organizationId: req.principal.organizationId },
      include: {
        deliveries: {
          include: {
            endpoint: { select: { id: true, name: true, url: true } },
            attempts: { orderBy: { createdAt: 'desc' }, take: 100 },
          },
        },
      },
    });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }
  @Post('deliveries/:id/replay')
  async replay(@Param('id') deliveryId: string, @Req() req: AuthRequest) {
    browserOnly(req);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Delivery" WHERE id = ${id(deliveryId)} FOR UPDATE`;
      const delivery = await tx.delivery.findFirst({
        where: { id: deliveryId, event: { organizationId: req.principal.organizationId } },
        include: { endpoint: true },
      });
      if (!delivery) throw new NotFoundException('Delivery not found');
      if (!['delivered', 'failed'].includes(delivery.status))
        throw new ConflictException('Wait until the delivery is terminal before replaying');
      if (!delivery.endpoint.enabled)
        throw new BadRequestException('Enable the endpoint before replaying');
      const generation = delivery.generation + 1;
      await tx.delivery.update({
        where: { id: deliveryId },
        data: {
          generation,
          failureCount: 0,
          scheduleCount: 0,
          status: 'pending',
          nextAttemptAt: new Date(),
          leaseUntil: null,
          leaseToken: null,
          deliveredAt: null,
          lastError: null,
          createdAt: new Date(),
          outbox: { create: { generation, sequence: 0 } },
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: req.principal.organizationId,
          actor: req.principal.actor,
          action: 'delivery.replayed',
          resourceId: deliveryId,
        },
      });
      return { ok: true, generation };
    });
  }
  @Get('stats')
  async stats(@Req() req: AuthRequest) {
    browserOnly(req);
    const organizationId = req.principal.organizationId;
    const since = new Date(Date.now() - 86400000);
    const [events, endpoints, groups, performance, hourly] = await Promise.all([
      db.event.count({ where: { organizationId, createdAt: { gte: since } } }),
      db.endpoint.count({ where: { organizationId, enabled: true } }),
      db.delivery.groupBy({ by: ['status'], where: { event: { organizationId } }, _count: true }),
      db.$queryRaw<
        { p95: number | null; attempts: bigint }[]
      >`SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY a."durationMs") AS p95, count(*) AS attempts FROM "Attempt" a JOIN "Delivery" d ON d.id = a."deliveryId" JOIN "Event" e ON e.id = d."eventId" WHERE e."organizationId" = ${organizationId} AND a."createdAt" >= ${since}`,
      db.$queryRaw<
        { hour: Date; delivered: bigint; failed: bigint }[]
      >`SELECT date_trunc('hour', a."createdAt") AS hour, count(*) FILTER (WHERE a.outcome = 'delivered') AS delivered, count(*) FILTER (WHERE a.outcome != 'delivered') AS failed FROM "Attempt" a JOIN "Delivery" d ON d.id = a."deliveryId" JOIN "Event" e ON e.id = d."eventId" WHERE e."organizationId" = ${organizationId} AND a."createdAt" >= ${since} GROUP BY 1 ORDER BY 1`,
    ]);
    const counts = Object.fromEntries(groups.map((g) => [g.status, g._count]));
    return {
      events,
      endpoints,
      counts,
      p95: Math.round(performance[0]?.p95 ?? 0),
      attempts: Number(performance[0]?.attempts ?? 0),
      hourly: hourly.map((h) => ({
        hour: h.hour,
        delivered: Number(h.delivered),
        failed: Number(h.failed),
      })),
    };
  }
  @Sse('stream')
  stream(@Req() req: AuthRequest) {
    browserOnly(req);
    return concat(from([0]), interval(2000)).pipe(
      takeWhile(() => !req.principal.expiresAt || req.principal.expiresAt > new Date()),
      exhaustMap(() => from(this.stats(req))),
      map((stats) => ({ data: stats, type: 'update' }) as MessageEvent),
    );
  }
  @Get('audit')
  async audits(@Req() req: AuthRequest) {
    browserOnly(req);
    return db.auditLog.findMany({
      where: { organizationId: req.principal.organizationId },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
  }
  @Get('members')
  async members(@Req() req: AuthRequest) {
    browserOnly(req);
    return db.membership.findMany({
      where: { organizationId: req.principal.organizationId },
      select: { role: true, user: { select: { id: true, name: true, email: true } } },
    });
  }
  @Post('invitations')
  async invite(@Body() body: unknown, @Req() req: AuthRequest) {
    ownerOnly(req);
    const data = z.object({ email }).parse(body);
    const secret = token('invite_');
    const invite = await db.invitation.create({
      data: {
        organizationId: req.principal.organizationId,
        email: data.email,
        tokenHash: hash(secret),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
    await audit(req, 'invitation.created', invite.id);
    return {
      token: secret,
      url: `${config.WEB_ORIGIN}/?invite=${encodeURIComponent(secret)}`,
      email: data.email,
      expiresAt: invite.expiresAt,
    };
  }
}
