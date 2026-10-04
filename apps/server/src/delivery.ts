import { randomUUID } from 'node:crypto';
import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import { db } from './db';
import { redis, rateLimit, tenantSlot } from './queue';
import { config } from './config';
import { decrypt, signature } from './crypto';
import { sendWebhook, UnsafeDestination } from './destination';
import { backoff, classify, retryAfterMs } from './policy';
import { deliveryAttempts, latency, logger } from './observability';
export type DeliveryJob = { deliveryId: string; generation: number };
export async function processDelivery(job: DeliveryJob) {
  const event = await db.delivery.findUnique({
    where: { id: job.deliveryId },
    select: { event: { select: { traceContext: true } } },
  });
  const parent = propagation.extract(context.active(), event?.event.traceContext ?? {});
  return context.with(parent, () =>
    trace.getTracer('relay').startActiveSpan('webhook.deliver', async (span) => {
      span.setAttributes({ 'delivery.id': job.deliveryId, 'delivery.generation': job.generation });
      try {
        await runDelivery(job);
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}
async function runDelivery(job: DeliveryJob) {
  const leaseToken = randomUUID();
  const claimed = await db.delivery.updateMany({
    where: {
      id: job.deliveryId,
      generation: job.generation,
      status: { in: ['pending', 'retrying', 'throttled', 'processing'] },
      nextAttemptAt: { lte: new Date() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: {
      status: 'processing',
      leaseToken,
      leaseUntil: new Date(Date.now() + config.DELIVERY_TIMEOUT_MS + 15000),
    },
  });
  if (!claimed.count) return;
  const delivery = await db.delivery.findUniqueOrThrow({
    where: { id: job.deliveryId },
    include: { event: true, endpoint: true },
  });
  const organizationId = delivery.event.organizationId;
  let slot = false;
  const finalize = async (
    data: {
      status: string;
      lastError?: string | null;
      failureCount?: number;
      attemptCount?: number;
      deliveredAt?: Date;
      delay?: number;
    },
    attempt?: {
      statusCode?: number;
      durationMs: number;
      responseSnippet?: string;
      error?: string;
      outcome: string;
    },
  ) => {
    await db.$transaction(async (tx) => {
      const changed = await tx.delivery.updateMany({
        where: { id: delivery.id, generation: job.generation, leaseToken },
        data: {
          status: data.status,
          lastError: data.lastError,
          failureCount: data.failureCount,
          attemptCount: data.attemptCount,
          deliveredAt: data.deliveredAt,
          leaseUntil: null,
          leaseToken: null,
          ...(data.delay !== undefined
            ? { nextAttemptAt: new Date(Date.now() + data.delay), scheduleCount: { increment: 1 } }
            : {}),
        },
      });
      if (!changed.count) return; // A newer generation or expired lease owns the record now.
      if (attempt)
        await tx.attempt.create({
          data: {
            ...attempt,
            deliveryId: delivery.id,
            number: delivery.attemptCount + 1,
            generation: job.generation,
          },
        });
      if (data.delay !== undefined) {
        const updated = await tx.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
        await tx.outbox.create({
          data: {
            deliveryId: delivery.id,
            generation: job.generation,
            sequence: updated.scheduleCount,
            availableAt: updated.nextAttemptAt,
          },
        });
      }
    });
  };
  try {
    if (!delivery.endpoint.enabled) {
      await finalize({ status: 'failed', lastError: 'Endpoint disabled' });
      return;
    }
    if (Date.now() - delivery.createdAt.getTime() >= config.MAX_DELIVERY_AGE_MS) {
      await finalize({ status: 'failed', lastError: 'Delivery exceeded maximum retry age' });
      return;
    }
    const cooldown = await redis.pttl(`cooldown:${delivery.endpointId}`);
    if (cooldown > 0) {
      await finalize({ status: 'throttled', delay: cooldown });
      return;
    }
    slot = await tenantSlot(organizationId, leaseToken);
    if (!slot) {
      await finalize({ status: 'pending', delay: 500 });
      return;
    }
    const delay = await rateLimit(`delivery:{${organizationId}}`, config.TENANT_DELIVERY_RPS);
    if (delay > 0) {
      await finalize({ status: 'throttled', delay });
      return;
    }
    const body = JSON.stringify({
      id: delivery.event.id,
      type: delivery.event.type,
      createdAt: delivery.event.createdAt.toISOString(),
      data: delivery.event.payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signatures = [
      signature(decrypt(delivery.endpoint.secretEncrypted), delivery.event.id, timestamp, body),
    ];
    if (
      delivery.endpoint.previousSecretEncrypted &&
      delivery.endpoint.previousSecretUntil &&
      delivery.endpoint.previousSecretUntil > new Date()
    )
      signatures.push(
        signature(
          decrypt(delivery.endpoint.previousSecretEncrypted),
          delivery.event.id,
          timestamp,
          body,
        ),
      );
    const headers = {
      'webhook-id': delivery.event.id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signatures.map((s) => `v1=${s}`).join(','),
      'webhook-delivery-id': delivery.id,
      'webhook-attempt': String(delivery.attemptCount + 1),
      'user-agent': 'Relay/0.1',
    };
    const started = Date.now();
    let statusCode: number | undefined;
    let responseSnippet: string | undefined;
    let error: string | undefined;
    let outcome: string;
    let requestedDelay: number | undefined;
    try {
      const result = await sendWebhook(delivery.endpoint.url, body, headers);
      statusCode = result.statusCode;
      responseSnippet = result.body;
      outcome = classify(statusCode);
      requestedDelay = retryAfterMs(result.retryAfter);
      if (outcome !== 'delivered') error = `Endpoint responded HTTP ${statusCode}`;
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
      outcome = err instanceof UnsafeDestination ? 'failed' : 'retry';
    }
    const durationMs = Date.now() - started;
    deliveryAttempts.inc({ outcome });
    latency.observe(durationMs / 1000);
    logger.info(
      {
        eventId: delivery.event.id,
        deliveryId: delivery.id,
        generation: job.generation,
        statusCode,
        outcome,
        durationMs,
      },
      'Delivery attempted',
    );
    const attempt = { statusCode, responseSnippet, durationMs, error, outcome };
    const attemptCount = delivery.attemptCount + 1;
    if (outcome === 'delivered') {
      await finalize(
        { status: 'delivered', attemptCount, deliveredAt: new Date(), lastError: null },
        attempt,
      );
      return;
    }
    if (outcome === 'throttled') {
      const delay = requestedDelay ?? 5000;
      await redis.set(`cooldown:${delivery.endpointId}`, '1', 'PX', delay);
      await finalize({ status: 'throttled', attemptCount, lastError: error, delay }, attempt);
      return;
    }
    const failures = delivery.failureCount + 1;
    if (outcome === 'failed' || failures >= config.MAX_ATTEMPTS) {
      await finalize(
        { status: 'failed', failureCount: failures, attemptCount, lastError: error },
        attempt,
      );
      return;
    }
    await finalize(
      {
        status: 'retrying',
        failureCount: failures,
        attemptCount,
        lastError: error,
        delay: requestedDelay ?? backoff(failures, config.RETRY_BASE_MS),
      },
      attempt,
    );
  } finally {
    if (slot) await redis.zrem(`active:{${organizationId}}`, leaseToken).catch(() => {});
  }
}
