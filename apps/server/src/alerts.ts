import { db } from './db';
import { hash } from './crypto';
import type { Prisma } from './generated/prisma/client';
import { alertChanges } from './observability';
async function notify(
  tx: Prisma.TransactionClient,
  alert: {
    id: string;
    organizationId: string;
    endpointId: string;
    message: string;
    failureCount: number;
  },
  destinationId: string | null,
  phase: string,
) {
  if (!destinationId) return;
  const destination = await tx.endpoint.findFirst({
    where: { id: destinationId, organizationId: alert.organizationId },
  });
  if (!destination) return;
  // Explicit channel selection delivers only here, independently of ordinary subscriptions.
  // The worker reports disabled destinations and applies the same signatures/retry safeguards.
  const payload = {
    alertId: alert.id,
    endpointId: alert.endpointId,
    status: phase,
    message: alert.message,
    failureCount: alert.failureCount,
  };
  const type = `relay.alert.${phase}`;
  const event = await tx.event.create({
    data: {
      organizationId: alert.organizationId,
      type,
      payload,
      source: 'alert',
      idempotencyKey: `alert:${alert.id}:${phase}`,
      requestHash: hash(JSON.stringify({ type, payload })),
      deliveries: { create: { endpointId: destination.id, outbox: { create: { generation: 0 } } } },
    },
  });
  await tx.alertNotification.create({ data: { alertId: alert.id, phase, eventId: event.id } });
}
export async function evaluateAlertRule(ruleId: string, now = new Date()) {
  return db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "AlertRule" WHERE id = ${ruleId} FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return;
      const rule = await tx.alertRule.findUniqueOrThrow({ where: { id: ruleId } });
      if (!rule.enabled) return;
      const since = new Date(now.getTime() - rule.windowMinutes * 60000);
      const health = await tx.$queryRaw<
        { endpointId: string; failures: bigint; lastSuccess: Date | null }[]
      >`
      SELECT ep.id AS "endpointId", count(DISTINCT a."deliveryId") FILTER (WHERE a.outcome IN ('retry','failed') AND a."createdAt" > COALESCE(s.success, '1970-01-01'::timestamp)) AS failures,
      s.success AS "lastSuccess" FROM "Endpoint" ep
      LEFT JOIN LATERAL (SELECT max(at."createdAt") AS success FROM "Attempt" at JOIN "Delivery" d ON d.id = at."deliveryId" JOIN "Event" e ON e.id = d."eventId"
        WHERE d."endpointId" = ep.id AND e.source = 'production' AND at.outcome = 'delivered' AND at."createdAt" <= ${now}) s ON true
      LEFT JOIN "Delivery" d ON d."endpointId" = ep.id LEFT JOIN "Event" e ON e.id = d."eventId" AND e.source = 'production'
      LEFT JOIN "Attempt" a ON a."deliveryId" = d.id AND e.id IS NOT NULL AND a."createdAt" >= ${since} AND a."createdAt" <= ${now}
      WHERE ep."organizationId" = ${rule.organizationId} AND (${rule.endpointId}::text IS NULL OR ep.id = ${rule.endpointId})
      GROUP BY ep.id, s.success ORDER BY ep.id`;
      for (const item of health) {
        const activeKey = `${rule.id}:${item.endpointId}`;
        const active = await tx.alert.findUnique({ where: { activeKey } });
        const count = Number(item.failures);
        if (active) {
          if (count === 0) {
            const resolved = await tx.alert.update({
              where: { id: active.id },
              data: {
                activeKey: null,
                resolvedAt: now,
                message:
                  item.lastSuccess && item.lastSuccess >= since
                    ? 'Endpoint recovered'
                    : 'Failure window cleared',
              },
            });
            await notify(tx, resolved, rule.notificationEndpointId, 'resolved');
            await tx.auditLog.create({
              data: {
                organizationId: rule.organizationId,
                actor: 'alert-monitor',
                action: 'alert.resolved',
                resourceId: active.id,
              },
            });
            alertChanges.inc({ state: 'resolved' });
          } else await tx.alert.update({ where: { id: active.id }, data: { failureCount: count } });
          continue;
        }
        if (count < rule.threshold) continue;
        const recent = await tx.alert.findFirst({
          where: {
            ruleId,
            endpointId: item.endpointId,
            createdAt: { gt: new Date(now.getTime() - rule.cooldownMinutes * 60000) },
          },
        });
        if (recent) continue;
        const opened = await tx.alert.create({
          data: {
            organizationId: rule.organizationId,
            ruleId,
            endpointId: item.endpointId,
            activeKey,
            failureCount: count,
            message: `${count} distinct deliveries failed since the latest success within ${rule.windowMinutes} minutes`,
          },
        });
        await notify(tx, opened, rule.notificationEndpointId, 'opened');
        await tx.auditLog.create({
          data: {
            organizationId: rule.organizationId,
            actor: 'alert-monitor',
            action: 'alert.opened',
            resourceId: opened.id,
          },
        });
        alertChanges.inc({ state: 'opened' });
      }
      await tx.alertRule.update({ where: { id: ruleId }, data: { lastEvaluatedAt: now } });
    },
    { timeout: 10000 },
  );
}
export async function sweepAlerts() {
  const rules = await db.alertRule.findMany({
    where: { enabled: true, lastEvaluatedAt: { lt: new Date(Date.now() - 10000) } },
    orderBy: [{ lastEvaluatedAt: 'asc' }, { id: 'asc' }],
    take: 20,
  });
  for (const rule of rules) await evaluateAlertRule(rule.id);
}
