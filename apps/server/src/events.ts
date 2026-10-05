import {
  ConflictException,
  GoneException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';
import { db } from './db';
import { hash } from './crypto';
import { Prisma } from './generated/prisma/client';
export async function acceptEvent(input: {
  organizationId: string;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  source?: 'production' | 'test';
  endpointId?: string;
}) {
  const { organizationId, actor, type, payload, idempotencyKey, endpointId } = input;
  const source = input.source ?? 'production';
  const requestHash = hash(
    JSON.stringify(
      source === 'production' ? { type, payload } : { type, payload, source, endpointId },
    ),
  );
  const existing = () =>
    db.event.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
      include: { deliveries: true },
    });
  const check = (event: { requestHash: string }) => {
    if (event.requestHash !== requestHash)
      throw new ConflictException('Idempotency key already used with a different request');
    return event;
  };
  const expired = async () => {
    const record = await db.expiredEvent.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    });
    if (record) {
      check(record);
      throw new GoneException(
        'Event expired under the workspace retention policy; use a new key only for a new business event',
      );
    }
  };
  const previous = await existing();
  if (previous) {
    check(previous);
    return previous;
  }
  await expired();
  const traceContext: Record<string, string> = {};
  propagation.inject(context.active(), traceContext);
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId + ':' + idempotencyKey}, 22419))::text`;
      const stored = await tx.event.findUnique({
        where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
        include: { deliveries: true },
      });
      if (stored) {
        check(stored);
        return stored;
      }
      const receipt = await tx.expiredEvent.findUnique({
        where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
      });
      if (receipt) {
        check(receipt);
        throw new GoneException('Event expired under the workspace retention policy');
      }

      const endpoints = endpointId
        ? await tx.endpoint.findMany({ where: { id: endpointId, organizationId } })
        : await tx.endpoint.findMany({
            where: {
              organizationId,
              enabled: true,
              OR: [{ eventTypes: { isEmpty: true } }, { eventTypes: { has: type } }],
            },
          });
      if (endpointId && !endpoints.length) throw new NotFoundException('Endpoint not found');
      if (endpointId && !endpoints[0].enabled)
        throw new BadRequestException('Enable the endpoint before sending a test');
      const event = await tx.event.create({
        data: {
          organizationId,
          idempotencyKey,
          requestHash,
          traceContext,
          type,
          payload: payload as Prisma.InputJsonValue,
          source,
        },
      });
      for (const endpoint of endpoints)
        await tx.delivery.create({
          data: {
            eventId: event.id,
            endpointId: endpoint.id,
            outbox: { create: { generation: 0, sequence: 0 } },
          },
        });
      await tx.auditLog.create({
        data: {
          organizationId,
          actor,
          action: source === 'test' ? 'test_event.published' : 'event.published',
          resourceId: event.id,
        },
      });
      return tx.event.findUniqueOrThrow({ where: { id: event.id }, include: { deliveries: true } });
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      const event = await existing();
      if (event) {
        check(event);
        return event;
      }
      await expired();
    }
    throw err;
  }
}
