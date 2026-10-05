import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Req,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiHeader, ApiOperation, ApiBody } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthGuard, type AuthRequest, browserOnly, ownerOnly } from './auth';
import { requireScope, requireEventType } from './permissions';
import { db } from './db';
import { retentionPreview, cleanupWorkspace } from './retention';
import { acceptEvent } from './events';
import { EVENT_TEMPLATES, verifyWebhook } from './testing';
const uuid = (value: string) => z.string().uuid().parse(value);
const days = z.number().int().min(1).max(3650).nullable();
async function audit(req: AuthRequest, action: string, resourceId: string) {
  await db.auditLog.create({
    data: {
      organizationId: req.principal.organizationId,
      actor: req.principal.actor,
      action,
      resourceId,
    },
  });
}
@ApiTags('Retention')
@UseGuards(AuthGuard)
@Controller('settings/retention')
export class RetentionController {
  @Get()
  async policy(@Req() req: AuthRequest) {
    browserOnly(req);
    return retentionPreview(req.principal.organizationId);
  }
  @Patch()
  @ApiBody({
    schema: {
      type: 'object',
      required: ['eventRetentionDays', 'attemptRetentionDays'],
      properties: {
        eventRetentionDays: { type: 'integer', minimum: 1, maximum: 3650, nullable: true },
        attemptRetentionDays: { type: 'integer', minimum: 1, maximum: 3650, nullable: true },
      },
    },
  })
  async update(@Req() req: AuthRequest, @Body() body: unknown) {
    ownerOnly(req);
    const data = z
      .object({ eventRetentionDays: days, attemptRetentionDays: days })
      .refine(
        (v) =>
          !v.eventRetentionDays ||
          !v.attemptRetentionDays ||
          v.attemptRetentionDays <= v.eventRetentionDays,
        'Attempt retention must not exceed event retention',
      )
      .parse(body);
    await db.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: req.principal.organizationId }, data });
      await tx.auditLog.create({
        data: {
          organizationId: req.principal.organizationId,
          actor: req.principal.actor,
          action: 'retention.updated',
          resourceId: req.principal.organizationId,
        },
      });
    });
    return retentionPreview(req.principal.organizationId);
  }
  @Post('run')
  @ApiOperation({ summary: 'Run one bounded cleanup batch under the configured policy' })
  async run(@Req() req: AuthRequest) {
    ownerOnly(req);
    return cleanupWorkspace(req.principal.organizationId);
  }
}
const ruleFields = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  endpointId: z.string().uuid().nullable(),
  notificationEndpointId: z.string().uuid().nullable(),
  threshold: z.number().int().min(1).max(1000),
  windowMinutes: z.number().int().min(1).max(1440),
  cooldownMinutes: z.number().int().min(1).max(1440),
};
const alertRuleSchema = {
  type: 'object' as const,
  properties: {
    name: { type: 'string' as const, maxLength: 100 },
    enabled: { type: 'boolean' as const, default: true },
    endpointId: { type: 'string' as const, format: 'uuid', nullable: true },
    notificationEndpointId: { type: 'string' as const, format: 'uuid', nullable: true },
    threshold: { type: 'integer' as const, minimum: 1, maximum: 1000, default: 3 },
    windowMinutes: { type: 'integer' as const, minimum: 1, maximum: 1440, default: 15 },
    cooldownMinutes: { type: 'integer' as const, minimum: 1, maximum: 1440, default: 30 },
  },
};
@ApiTags('Alerts')
@UseGuards(AuthGuard)
@Controller()
export class AlertsController {
  private async endpoints(req: AuthRequest, values: (string | null | undefined)[]) {
    const ids = [...new Set(values.filter((v): v is string => !!v))];
    if (
      (await db.endpoint.count({
        where: { id: { in: ids }, organizationId: req.principal.organizationId },
      })) !== ids.length
    )
      throw new NotFoundException('Endpoint not found');
  }
  @Get('alert-rules')
  async rules(@Req() req: AuthRequest) {
    browserOnly(req);
    return db.alertRule.findMany({
      where: { organizationId: req.principal.organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }
  @Post('alert-rules')
  @ApiBody({ schema: { ...alertRuleSchema, required: ['name'] } })
  async create(@Req() req: AuthRequest, @Body() body: unknown) {
    ownerOnly(req);
    const data = z
      .object({
        ...ruleFields,
        enabled: ruleFields.enabled.default(true),
        endpointId: ruleFields.endpointId.default(null),
        notificationEndpointId: ruleFields.notificationEndpointId.default(null),
        threshold: ruleFields.threshold.default(3),
        windowMinutes: ruleFields.windowMinutes.default(15),
        cooldownMinutes: ruleFields.cooldownMinutes.default(30),
      })
      .parse(body);
    await this.endpoints(req, [data.endpointId, data.notificationEndpointId]);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${req.principal.organizationId} FOR UPDATE`;
      if (
        (await tx.alertRule.count({ where: { organizationId: req.principal.organizationId } })) >=
        20
      )
        throw new BadRequestException('A workspace supports up to 20 alert rules');
      const rule = await tx.alertRule.create({
        data: { ...data, organizationId: req.principal.organizationId },
      });
      await tx.auditLog.create({
        data: {
          organizationId: req.principal.organizationId,
          actor: req.principal.actor,
          action: 'alert_rule.created',
          resourceId: rule.id,
        },
      });
      return rule;
    });
  }
  @Patch('alert-rules/:id')
  @ApiBody({ schema: alertRuleSchema })
  async update(@Req() req: AuthRequest, @Param('id') ruleId: string, @Body() body: unknown) {
    ownerOnly(req);
    const data = z
      .object({
        name: ruleFields.name.optional(),
        enabled: ruleFields.enabled.optional(),
        endpointId: ruleFields.endpointId.optional(),
        notificationEndpointId: ruleFields.notificationEndpointId.optional(),
        threshold: ruleFields.threshold.optional(),
        windowMinutes: ruleFields.windowMinutes.optional(),
        cooldownMinutes: ruleFields.cooldownMinutes.optional(),
      })
      .parse(body);
    await this.endpoints(req, [data.endpointId, data.notificationEndpointId]);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AlertRule" WHERE id = ${uuid(ruleId)} AND "organizationId" = ${req.principal.organizationId} FOR UPDATE`;
      const previous = await tx.alertRule.findFirst({
        where: { id: ruleId, organizationId: req.principal.organizationId },
      });
      if (!previous) throw new NotFoundException('Alert rule not found');
      await tx.alertRule.update({ where: { id: ruleId }, data });
      const targetChanged =
        data.endpointId !== undefined && data.endpointId !== previous.endpointId;
      if (data.enabled === false || targetChanged)
        await tx.alert.updateMany({
          where: { ruleId, resolvedAt: null },
          data: {
            activeKey: null,
            resolvedAt: new Date(),
            message: data.enabled === false ? 'Alert rule disabled' : 'Alert rule target changed',
          },
        });
      await tx.auditLog.create({
        data: {
          organizationId: req.principal.organizationId,
          actor: req.principal.actor,
          action: 'alert_rule.updated',
          resourceId: ruleId,
        },
      });
    });
    return { ok: true };
  }
  @Get('alerts')
  async alerts(@Req() req: AuthRequest, @Query() query: Record<string, string>) {
    browserOnly(req);
    const status = z
      .enum(['open', 'resolved'])
      .optional()
      .parse(query.status || undefined);
    const cursor = query.cursor ? uuid(query.cursor) : undefined;
    if (
      cursor &&
      !(await db.alert.findFirst({
        where: { id: cursor, organizationId: req.principal.organizationId },
      }))
    )
      throw new BadRequestException('Invalid cursor');
    const rows = await db.alert.findMany({
      where: {
        organizationId: req.principal.organizationId,
        ...(status === 'open'
          ? { resolvedAt: null }
          : status === 'resolved'
            ? { resolvedAt: { not: null } }
            : {}),
      },
      take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        rule: { select: { name: true } },
        endpoint: { select: { id: true, name: true } },
        notifications: {
          include: {
            event: {
              select: { id: true, deliveries: { select: { status: true, lastError: true } } },
            },
          },
        },
      },
    });
    return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null };
  }
  @Post('alerts/:id/acknowledge')
  async acknowledge(@Req() req: AuthRequest, @Param('id') alertId: string) {
    browserOnly(req);
    const changed = await db.alert.updateMany({
      where: {
        id: uuid(alertId),
        organizationId: req.principal.organizationId,
        acknowledgedAt: null,
      },
      data: { acknowledgedAt: new Date() },
    });
    if (
      !changed.count &&
      !(await db.alert.findFirst({
        where: { id: alertId, organizationId: req.principal.organizationId },
      }))
    )
      throw new NotFoundException('Alert not found');
    if (changed.count) await audit(req, 'alert.acknowledged', alertId);
    return { ok: true };
  }
}
@ApiTags('Webhook testing')
@UseGuards(AuthGuard)
@Controller('testing')
export class TestingController {
  @Get('templates')
  templates(@Req() req: AuthRequest) {
    requireScope(req, 'testing:write');
    return EVENT_TEMPLATES;
  }
  @Post('events')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Send a real signed test webhook to one enabled endpoint' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['endpointId', 'type', 'payload'],
      properties: {
        endpointId: { type: 'string', format: 'uuid' },
        type: { type: 'string', example: 'order.created' },
        payload: { type: 'object', additionalProperties: true, example: { orderId: 'ord_demo' } },
      },
    },
  })
  async send(@Req() req: AuthRequest, @Body() body: unknown) {
    requireScope(req, 'testing:write');
    const data = z
      .object({
        endpointId: z.string().uuid(),
        type: z
          .string()
          .regex(/^[a-zA-Z0-9_.-]+$/)
          .max(100),
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(body);
    requireEventType(req, data.type);
    return acceptEvent({
      ...data,
      source: 'test',
      organizationId: req.principal.organizationId,
      actor: req.principal.actor,
      idempotencyKey: z.string().min(1).max(200).parse(req.headers['idempotency-key']),
    });
  }
  @Get('events')
  async events(@Req() req: AuthRequest) {
    requireScope(req, 'testing:write');
    return db.event.findMany({
      where: { organizationId: req.principal.organizationId, source: 'test' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        deliveries: { include: { endpoint: { select: { id: true, name: true, url: true } } } },
      },
    });
  }
  @Get('events/:id')
  async event(@Req() req: AuthRequest, @Param('id') eventId: string) {
    requireScope(req, 'testing:write');
    const event = await db.event.findFirst({
      where: { id: uuid(eventId), organizationId: req.principal.organizationId, source: 'test' },
      include: {
        deliveries: {
          include: {
            endpoint: { select: { id: true, name: true, url: true } },
            attempts: { orderBy: { createdAt: 'desc' }, take: 100 },
          },
        },
      },
    });
    if (!event) throw new NotFoundException('Test event not found');
    return event;
  }
  @Post('verify-signature')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['endpointId', 'eventId', 'timestamp', 'signature', 'rawBody'],
      properties: {
        endpointId: { type: 'string', format: 'uuid' },
        eventId: { type: 'string' },
        timestamp: { type: 'string' },
        signature: { type: 'string', description: 'Comma-separated v1=<hex> signatures' },
        rawBody: { type: 'string', description: 'Exact unmodified HTTP request body' },
      },
    },
  })
  async verify(@Req() req: AuthRequest, @Body() body: unknown) {
    requireScope(req, 'testing:write');
    const data = z
      .object({
        endpointId: z.string().uuid(),
        eventId: z.string().min(1).max(200),
        timestamp: z.string().max(30),
        signature: z.string().max(1024),
        rawBody: z.string().max(262144),
      })
      .parse(body);
    const endpoint = await db.endpoint.findFirst({
      where: { id: data.endpointId, organizationId: req.principal.organizationId },
    });
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    return verifyWebhook(data, endpoint);
  }
}
