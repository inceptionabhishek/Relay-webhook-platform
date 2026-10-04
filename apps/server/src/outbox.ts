import { db } from './db';
import { deliveryQueue } from './queue';
import { backlog, oldest } from './observability';
export async function dispatchBatch() {
  return db.$transaction(
    async (tx) => {
      // Pick a bounded batch per tenant before locking. Multiple dispatchers safely skip claimed rows.
      const rows = await tx.$queryRaw<{ id: string; deliveryId: string; generation: number }[]>`
      SELECT o.id, o."deliveryId", o.generation FROM "Outbox" o
      WHERE o.id IN (
        SELECT ranked.id FROM (
          SELECT ob.id, row_number() OVER (PARTITION BY e."organizationId" ORDER BY ob."availableAt", ob.id) AS position
          FROM "Outbox" ob JOIN "Delivery" d ON d.id = ob."deliveryId" JOIN "Event" e ON e.id = d."eventId"
          WHERE ob."dispatchedAt" IS NULL AND ob."availableAt" <= now()
        ) ranked WHERE position <= 5
      ) ORDER BY o."availableAt", o.id LIMIT 50 FOR UPDATE OF o SKIP LOCKED`;
      for (const row of rows) {
        await deliveryQueue.add(
          'deliver',
          { deliveryId: row.deliveryId, generation: row.generation },
          { jobId: row.id },
        );
        await tx.outbox.update({ where: { id: row.id }, data: { dispatchedAt: new Date() } });
      }
      return rows.length;
    },
    { timeout: 10000 },
  );
}
export async function reconcile() {
  // PostgreSQL remains authoritative even if Redis loses an acknowledged job.
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; generation: number; scheduleCount: number }[]>`
      SELECT d.id, d.generation, d."scheduleCount" FROM "Delivery" d
      WHERE d.status IN ('pending', 'retrying', 'throttled', 'processing')
      AND d."nextAttemptAt" < now() - interval '30 seconds'
      AND (d."leaseUntil" IS NULL OR d."leaseUntil" < now())
      AND NOT EXISTS (SELECT 1 FROM "Outbox" o WHERE o."deliveryId" = d.id AND o.generation = d.generation AND (o."dispatchedAt" IS NULL OR o."dispatchedAt" > now() - interval '30 seconds'))
      LIMIT 100 FOR UPDATE OF d SKIP LOCKED`;
    for (const row of rows) {
      await tx.delivery.update({
        where: { id: row.id },
        data: {
          status: 'pending',
          leaseUntil: null,
          leaseToken: null,
          scheduleCount: { increment: 1 },
        },
      });
      await tx.outbox.create({
        data: { deliveryId: row.id, generation: row.generation, sequence: row.scheduleCount + 1 },
      });
    }
  });
  const where = { status: { in: ['pending', 'processing', 'retrying', 'throttled'] } };
  const [count, first] = await Promise.all([
    db.delivery.count({ where }),
    db.delivery.findFirst({ where, orderBy: { createdAt: 'asc' } }),
  ]);
  backlog.set(count);
  oldest.set(first ? (Date.now() - first.createdAt.getTime()) / 1000 : 0);
}
