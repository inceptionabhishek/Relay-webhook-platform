import { db } from './db';
import { deliveryQueue } from './queue';
import { backlog, oldest, scheduleDelay } from './observability';
import { config } from './config';
export async function dispatchBatch() {
  return db.$transaction(
    async (tx) => {
      // Serialize dispatch admission, not HTTP execution. The transaction-scoped lock is
      // released on crashes and ensures multiple dispatchers share one global queue budget.
      const [lock] = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(72401931) AS locked`;
      if (!lock.locked) return 0;
      const [inFlight] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM "Outbox" o JOIN "Delivery" d ON d.id = o."deliveryId"
      WHERE o."dispatchedAt" IS NOT NULL AND o."completedAt" IS NULL
      AND o.generation = d.generation AND d.status IN ('pending','processing','retrying','throttled','paused')`;
      const budget = Math.min(50, config.SCHEDULER_MAX_IN_FLIGHT - Number(inFlight.count));
      let dispatched = 0;
      while (dispatched < budget) {
        // Oldest-served tenant first, one job per turn. Persistent service timestamps
        // prevent a tenant with an old backlog from winning every dispatcher sweep.
        const [tenant] = await tx.$queryRaw<{ id: string }[]>`
        SELECT org.id FROM "Organization" org
        WHERE EXISTS (
          SELECT 1 FROM "Outbox" o JOIN "Delivery" d ON d.id = o."deliveryId" JOIN "Event" e ON e.id = d."eventId"
          WHERE e."organizationId" = org.id AND o."dispatchedAt" IS NULL AND o."completedAt" IS NULL AND o."availableAt" <= now()
          AND o.generation = d.generation AND d.status IN ('pending','processing','retrying','throttled','paused')
        ) AND (
          SELECT count(*) FROM "Outbox" o JOIN "Delivery" d ON d.id = o."deliveryId" JOIN "Event" e ON e.id = d."eventId"
          WHERE e."organizationId" = org.id AND o."dispatchedAt" IS NOT NULL AND o."completedAt" IS NULL
          AND o.generation = d.generation AND d.status IN ('pending','processing','retrying','throttled','paused')
        ) < ${config.SCHEDULER_TENANT_IN_FLIGHT}
        ORDER BY org."lastScheduledAt", org.id LIMIT 1 FOR UPDATE OF org SKIP LOCKED`;
        if (!tenant) break;
        const [row] = await tx.$queryRaw<
          { id: string; deliveryId: string; generation: number; availableAt: Date }[]
        >`
        SELECT o.id, o."deliveryId", o.generation, o."availableAt" FROM "Outbox" o
        JOIN "Delivery" d ON d.id = o."deliveryId" JOIN "Event" e ON e.id = d."eventId"
        WHERE e."organizationId" = ${tenant.id} AND o."dispatchedAt" IS NULL AND o."completedAt" IS NULL AND o."availableAt" <= now()
        AND o.generation = d.generation AND d.status IN ('pending','processing','retrying','throttled','paused')
        ORDER BY o."availableAt", o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`;
        if (!row) break;
        await deliveryQueue.add(
          'deliver',
          { deliveryId: row.deliveryId, generation: row.generation, outboxId: row.id },
          { jobId: row.id },
        );
        await tx.outbox.update({ where: { id: row.id }, data: { dispatchedAt: new Date() } });
        await tx.$executeRaw`UPDATE "Organization" SET "lastScheduledAt" = clock_timestamp() WHERE id = ${tenant.id}`;
        scheduleDelay.observe(Math.max(0, Date.now() - row.availableAt.getTime()) / 1000);
        dispatched++;
      }
      return dispatched;
    },
    { timeout: 10000 },
  );
}
export async function reconcile() {
  // PostgreSQL remains authoritative even if Redis loses an acknowledged job.
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; generation: number; scheduleCount: number }[]>`
      SELECT d.id, d.generation, d."scheduleCount" FROM "Delivery" d
      WHERE d.status IN ('pending', 'retrying', 'throttled', 'processing', 'paused')
      AND d."nextAttemptAt" < now() - interval '30 seconds'
      AND (d."leaseUntil" IS NULL OR d."leaseUntil" < now())
      AND NOT EXISTS (SELECT 1 FROM "Outbox" o WHERE o."deliveryId" = d.id AND o.generation = d.generation AND (o."completedAt" IS NULL AND ((o."dispatchedAt" IS NULL AND o."availableAt" <= now()) OR o."dispatchedAt" > now() - interval '30 seconds')))
      LIMIT 100 FOR UPDATE OF d SKIP LOCKED`;
    for (const row of rows) {
      await tx.outbox.updateMany({
        where: {
          deliveryId: row.id,
          generation: row.generation,
          dispatchedAt: { not: null },
          completedAt: null,
        },
        data: { completedAt: new Date() },
      });
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
  const where = { status: { in: ['pending', 'processing', 'retrying', 'throttled', 'paused'] } };
  const [count, first] = await Promise.all([
    db.delivery.count({ where }),
    db.delivery.findFirst({ where, orderBy: { createdAt: 'asc' } }),
  ]);
  backlog.set(count);
  oldest.set(first ? (Date.now() - first.createdAt.getTime()) / 1000 : 0);
}
