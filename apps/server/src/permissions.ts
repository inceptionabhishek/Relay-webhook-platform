import { ForbiddenException } from '@nestjs/common';
import type { AuthRequest } from './auth';
export const API_SCOPES = [
  'events:publish',
  'events:read',
  'endpoints:read',
  'deliveries:replay',
  'testing:write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export function requireScope(req: AuthRequest, scope: ApiScope) {
  if (req.principal.role === 'api_key' && !req.principal.scopes?.includes(scope))
    throw new ForbiddenException(`API key requires ${scope} permission`);
}
export function requireEventType(req: AuthRequest, type: string) {
  if (
    req.principal.role === 'api_key' &&
    req.principal.eventTypes?.length &&
    !req.principal.eventTypes.includes(type)
  )
    throw new ForbiddenException('API key cannot publish this event type');
}
