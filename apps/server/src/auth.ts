import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { db } from './db';
import { hash } from './crypto';
import { config } from './config';
import { rateLimit } from './queue';
export type Principal = {
  organizationId: string;
  actor: string;
  role: string;
  userId?: string;
  expiresAt?: Date;
};
export type AuthRequest = Request & { principal: Principal };
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer) {
      const key = await db.apiKey.findUnique({ where: { tokenHash: hash(bearer) } });
      if (!key || key.revokedAt) throw new UnauthorizedException('Invalid API key');
      req.principal = {
        organizationId: key.organizationId,
        actor: `key:${key.id}`,
        role: 'ingest',
      };
    } else {
      const session =
        req.cookies?.relay_session &&
        (await db.session.findUnique({ where: { tokenHash: hash(req.cookies.relay_session) } }));
      if (!session || session.expiresAt <= new Date())
        throw new UnauthorizedException('Please sign in');
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.headers.origin !== config.WEB_ORIGIN
      )
        throw new ForbiddenException('Invalid request origin');
      const organizationId = String(req.headers['x-organization-id'] ?? '');
      const membership = await db.membership.findUnique({
        where: { userId_organizationId: { userId: session.userId, organizationId } },
      });
      if (!membership) throw new ForbiddenException('Workspace access denied');
      req.principal = {
        organizationId,
        actor: session.userId,
        userId: session.userId,
        role: membership.role,
        expiresAt: session.expiresAt,
      };
    }
    if (req.method !== 'GET') {
      let delay: number;
      try {
        delay = await rateLimit(`api:{${req.principal.organizationId}}`, 30, 60);
      } catch {
        throw new ServiceUnavailableException('Rate limiter unavailable; retry later');
      }
      if (delay > 0) {
        context
          .switchToHttp()
          .getResponse()
          .setHeader('Retry-After', Math.ceil(delay / 1000));
        const { HttpException } = await import('@nestjs/common');
        throw new HttpException('Workspace request quota exceeded', 429);
      }
    }
    return true;
  }
}
export function browserOnly(req: AuthRequest) {
  if (req.principal.role === 'ingest')
    throw new ForbiddenException('This API key can only publish events');
}
export function ownerOnly(req: AuthRequest) {
  if (req.principal.role !== 'owner')
    throw new ForbiddenException('Workspace owner permission required');
}
export async function sessionUser(req: Request, mutation = false) {
  if (mutation && req.headers.origin !== config.WEB_ORIGIN)
    throw new ForbiddenException('Invalid request origin');
  const session =
    req.cookies?.relay_session &&
    (await db.session.findUnique({
      where: { tokenHash: hash(req.cookies.relay_session) },
      include: { user: true },
    }));
  if (!session || session.expiresAt <= new Date())
    throw new UnauthorizedException('Please sign in');
  return session.user;
}
