import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  GoneException,
} from '@nestjs/common';
import { db } from './db';
import { hash } from './crypto';
import type { Prisma } from './generated/prisma/client';

type Tx = Prisma.TransactionClient;
export async function resetDelivery(tx: Tx, deliveryId: string, generation: number) {
  await tx.outbox.updateMany({
    where: { deliveryId, completedAt: null },
    data: { completedAt: new Date() },
  });
  return tx.delivery.update({
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
      finishedAt: null,
      lastError: null,
      createdAt: new Date(),
      outbox: { create: { generation, sequence: 0 } },
    },
  });
}
export async function createReplayBatch(
  organizationId: string,
  actor: string,
  key: string,
  ids: string[],
) {
  const deliveryIds = [...new Set(ids)].sort();
  const requestHash = hash(JSON.stringify(deliveryIds));
  const existing = await db.replayBatch.findUnique({
    where: {
      organizationId_idempotencyKey: { organizationId, idempotencyKey: key },
    },
  });
  const check = (batch: { id: string; requestHash: string }) => {
    if (batch.requestHash !== requestHash)
      throw new ConflictException('Idempotency key already used with different deliveries');
    return { id: batch.id };
  };
  if (existing) return check(existing);
  try {
    return await db.$transaction(async (tx) => {
      const deliveries = await tx.delivery.findMany({
        where: { id: { in: deliveryIds }, event: { organizationId } },
      });
      if (deliveries.length !== deliveryIds.length)
        throw new NotFoundException('One or more deliveries were not found');
      if (deliveries.some((d) => d.status !== 'failed'))
        throw new BadRequestException('Bulk replay accepts failed deliveries only');
      const batch = await tx.replayBatch.create({
        data: {
          organizationId,
          actor,
          idempotencyKey: key,
          requestHash,
          items: {
            create: deliveries.map((d) => ({
              deliveryId: d.id,
              originalDeliveryId: d.id,
              expectedGeneration: d.generation,
            })),
          },
        },
      });
      await tx.auditLog.create({
        data: { organizationId, actor, action: 'replay_batch.created', resourceId: batch.id },
      });
      return { id: batch.id };
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2003')
      throw new GoneException('One or more deliveries expired under the retention policy');
    if ((err as { code?: string }).code === 'P2002') {
      const batch = await db.replayBatch.findUnique({
        where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: key } },
      });
      if (batch) return check(batch);
    }
    throw err;
  }
}
export async function processReplayBatches() {
  // A small durable chunk runs in the dispatcher, independent of Redis availability.
  // Locks and item state make retries after a dispatcher crash safe.
  const count = await db.$transaction(
    async (tx) => {
      const items = await tx.$queryRaw<
        { id: string; batchId: string; deliveryId: string | null; expectedGeneration: number }[]
      >`
      SELECT i.* FROM "ReplayItem" i JOIN "ReplayBatch" b ON b.id = i."batchId"
      WHERE i.status = 'queued' ORDER BY b."createdAt", i.id LIMIT 25 FOR UPDATE OF i SKIP LOCKED`;
      // Consistent delivery lock order also supports overlapping replay batches.
      for (const item of items.sort((a, b) =>
        (a.deliveryId ?? '').localeCompare(b.deliveryId ?? ''),
      )) {
        if (!item.deliveryId) {
          await tx.replayItem.update({
            where: { id: item.id },
            data: { status: 'skipped', error: 'Delivery expired' },
          });
          continue;
        }
        await tx.$queryRaw`SELECT id FROM "Delivery" WHERE id = ${item.deliveryId} FOR UPDATE`;
        const delivery = await tx.delivery.findUniqueOrThrow({
          where: { id: item.deliveryId },
          include: { endpoint: true },
        });
        let error: string | undefined;
        if (delivery.generation !== item.expectedGeneration || delivery.status !== 'failed')
          error = 'Delivery changed since the batch was created';
        else if (!delivery.endpoint.enabled) error = 'Endpoint disabled';
        if (error) {
          await tx.replayItem.update({
            where: { id: item.id },
            data: { status: 'skipped', error },
          });
          continue;
        }
        const generation = delivery.generation + 1;
        await resetDelivery(tx, delivery.id, generation);
        await tx.replayItem.update({
          where: { id: item.id },
          data: { status: 'replayed', replayGeneration: generation },
        });
        const batch = await tx.replayBatch.findUniqueOrThrow({ where: { id: item.batchId } });
        await tx.auditLog.create({
          data: {
            organizationId: batch.organizationId,
            actor: batch.actor,
            action: 'delivery.replayed',
            resourceId: delivery.id,
          },
        });
      }
      return items.length;
    },
    { timeout: 10000 },
  );
  await db.replayBatch.updateMany({
    where: { completedAt: null, items: { none: { status: 'queued' } } },
    data: { completedAt: new Date() },
  });
  return count;
}
export async function replayBatchSummary(organizationId: string, batchId: string) {
  const batch = await db.replayBatch.findFirst({
    where: { id: batchId, organizationId },
    include: { items: { include: { delivery: { select: { status: true, generation: true } } } } },
  });
  if (!batch) throw new NotFoundException('Replay batch not found');
  const counts = { queued: 0, replayed: 0, skipped: 0 };
  const outcomes: Record<string, number> = {};
  for (const item of batch.items) {
    counts[item.status as keyof typeof counts]++;
    if (item.status === 'replayed') {
      const status = !item.delivery
        ? 'expired'
        : item.delivery.generation === item.replayGeneration
          ? item.delivery.status
          : 'superseded';
      outcomes[status] = (outcomes[status] ?? 0) + 1;
    }
  }
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
    status: counts.queued ? 'processing' : 'completed',
    total: batch.items.length,
    ...counts,
    outcomes,
    items: batch.items.map(({ delivery, ...item }) => ({
      ...item,
      deliveryId: item.originalDeliveryId,
      deliveryStatus: !delivery
        ? 'expired'
        : item.replayGeneration !== null && delivery.generation !== item.replayGeneration
          ? 'superseded'
          : delivery.status,
    })),
  };
}
