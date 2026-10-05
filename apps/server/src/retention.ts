import { db } from './db';
const DAY = 86400000;
export async function retentionPreview(organizationId: string, now = new Date()) {
  const policy = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const terminal = (days: number) => ({
    status: { in: ['delivered', 'failed'] },
    finishedAt: { lt: new Date(now.getTime() - days * DAY) },
    OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    replayItems: { none: { status: 'queued' } },
  });
  const [events, attempts, runs] = await Promise.all([
    policy.eventRetentionDays
      ? db.event.count({
          where: {
            organizationId,
            createdAt: { lt: new Date(now.getTime() - policy.eventRetentionDays * DAY) },
            deliveries: { every: terminal(policy.eventRetentionDays) },
          },
        })
      : 0,
    policy.attemptRetentionDays
      ? db.attempt.count({
          where: {
            createdAt: { lt: new Date(now.getTime() - policy.attemptRetentionDays * DAY) },
            delivery: { ...terminal(policy.attemptRetentionDays), event: { organizationId } },
          },
        })
      : 0,
    db.retentionRun.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);
  return {
    eventRetentionDays: policy.eventRetentionDays,
    attemptRetentionDays: policy.attemptRetentionDays,
    lastRunAt: policy.retentionLastRunAt,
    eligibleEvents: events,
    eligibleAttempts: attempts,
    runs,
  };
}
export async function cleanupWorkspace(organizationId: string, now = new Date()) {
  return db.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtextextended(${organizationId}, 9813)) AS locked`;
      if (!lock.locked) return { busy: true, eventsDeleted: 0, attemptsDeleted: 0 };
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
      const policy = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
      let eventsDeleted = 0,
        attemptsDeleted = 0;
      if (policy.eventRetentionDays) {
        const cutoff = new Date(now.getTime() - policy.eventRetentionDays * DAY);
        const events = await tx.$queryRaw<
          { id: string; idempotencyKey: string; requestHash: string }[]
        >`
        SELECT e.id, e."idempotencyKey", e."requestHash" FROM "Event" e WHERE e."organizationId" = ${organizationId} AND e."createdAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "Delivery" d WHERE d."eventId" = e.id AND (d.status NOT IN ('delivered','failed') OR d."finishedAt" IS NULL OR d."finishedAt" >= ${cutoff} OR d."leaseUntil" >= ${now}))
        AND NOT EXISTS (SELECT 1 FROM "ReplayItem" i JOIN "Delivery" d ON d.id = i."deliveryId" WHERE d."eventId" = e.id AND i.status = 'queued')
        ORDER BY e."createdAt", e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED`;
        for (const event of events) {
          // Skip claimed deliveries rather than waiting behind a replay or worker. Recheck
          // after locking: a delivery could have changed since the candidate query.
          const deliveries = await tx.$queryRaw<
            { id: string; status: string; finishedAt: Date | null; leaseUntil: Date | null }[]
          >`
          SELECT id, status, "finishedAt", "leaseUntil" FROM "Delivery" WHERE "eventId" = ${event.id} ORDER BY id FOR UPDATE SKIP LOCKED`;
          if (deliveries.length !== (await tx.delivery.count({ where: { eventId: event.id } })))
            continue;
          if (
            deliveries.some(
              (d) =>
                !['failed', 'delivered'].includes(d.status) ||
                !d.finishedAt ||
                d.finishedAt >= cutoff ||
                (d.leaseUntil && d.leaseUntil >= now),
            )
          )
            continue;
          if (
            await tx.replayItem.count({
              where: { status: 'queued', delivery: { eventId: event.id } },
            })
          )
            continue;
          const [receiptLock] = await tx.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(hashtextextended(${organizationId + ':' + event.idempotencyKey}, 22419)) AS locked`;
          if (!receiptLock.locked) continue;
          const removedAttempts = await tx.attempt.count({
            where: { delivery: { eventId: event.id } },
          });
          await tx.expiredEvent.create({
            data: {
              organizationId,
              eventId: event.id,
              idempotencyKey: event.idempotencyKey,
              requestHash: event.requestHash,
            },
          });
          await tx.event.delete({ where: { id: event.id } });
          eventsDeleted++;
          attemptsDeleted += removedAttempts;
        }
      }
      if (policy.attemptRetentionDays) {
        const cutoff = new Date(now.getTime() - policy.attemptRetentionDays * DAY);
        const deliveries = await tx.$queryRaw<{ id: string }[]>`
        SELECT d.id FROM "Delivery" d JOIN "Event" e ON e.id = d."eventId" WHERE e."organizationId" = ${organizationId}
        AND d.status IN ('failed','delivered') AND d."finishedAt" < ${cutoff} AND (d."leaseUntil" IS NULL OR d."leaseUntil" < ${now})
        AND EXISTS (SELECT 1 FROM "Attempt" a WHERE a."deliveryId" = d.id AND a."createdAt" < ${cutoff})
        AND NOT EXISTS (SELECT 1 FROM "ReplayItem" i WHERE i."deliveryId" = d.id AND i.status = 'queued')
        ORDER BY d."finishedAt", d.id LIMIT 25 FOR UPDATE OF d SKIP LOCKED`;
        let remaining = 500;
        for (const delivery of deliveries) {
          if (!remaining) break;
          const rows = await tx.attempt.findMany({
            where: { deliveryId: delivery.id, createdAt: { lt: cutoff } },
            orderBy: { createdAt: 'asc' },
            take: remaining,
            select: { id: true },
          });
          const removed = await tx.attempt.deleteMany({
            where: { id: { in: rows.map((r) => r.id) } },
          });
          remaining -= removed.count;
          attemptsDeleted += removed.count;
        }
      }
      await tx.organization.update({
        where: { id: organizationId },
        data: { retentionLastRunAt: now },
      });
      await tx.retentionRun.create({ data: { organizationId, eventsDeleted, attemptsDeleted } });
      if (eventsDeleted || attemptsDeleted)
        await tx.auditLog.create({
          data: {
            organizationId,
            actor: 'retention-worker',
            action: 'retention.cleaned',
            resourceId: organizationId,
          },
        });
      return { busy: false, eventsDeleted, attemptsDeleted };
    },
    { timeout: 10000 },
  );
}
export async function sweepRetention() {
  const workspaces = await db.organization.findMany({
    where: {
      AND: [
        { OR: [{ eventRetentionDays: { not: null } }, { attemptRetentionDays: { not: null } }] },
        {
          OR: [
            { retentionLastRunAt: null },
            { retentionLastRunAt: { lt: new Date(Date.now() - 60000) } },
          ],
        },
      ],
    },
    orderBy: [{ retentionLastRunAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: 5,
  });
  for (const workspace of workspaces) await cleanupWorkspace(workspace.id);
}
