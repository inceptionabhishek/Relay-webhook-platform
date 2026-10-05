import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { execFileSync } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
let postgres: StartedPostgreSqlContainer,
  redisContainer: StartedTestContainer,
  receiver: Server,
  app: INestApplication;
let db: typeof import('../src/db').db,
  redis: typeof import('../src/queue').redis,
  queue: typeof import('../src/queue').deliveryQueue;
let processDelivery: typeof import('../src/delivery').processDelivery,
  dispatchBatch: typeof import('../src/outbox').dispatchBatch,
  reconcile: typeof import('../src/outbox').reconcile;
let cookie: string,
  org = '',
  receiverUrl: string;
const calls = new Map<string, number>();
const captured: { body: string; headers: any }[] = [];
const origin = 'http://localhost:3000';
function auth(method: 'get' | 'post' | 'patch' | 'delete', path: string, organizationId = org) {
  return request(app.getHttpServer())
    [method](path)
    .set('Cookie', cookie)
    .set('Origin', origin)
    .set('X-Organization-Id', organizationId);
}
async function freshWorkspace() {
  const result = await auth('post', '/auth/workspaces').send({ name: `Test ${randomUUID()}` });
  expect(result.status).toBe(201);
  org = result.body.id;
}
async function publish(mode = 'success') {
  const endpoint = await auth('post', '/endpoints').send({
    name: mode,
    url: `${receiverUrl}/${mode}`,
  });
  expect(endpoint.status).toBe(201);
  const result = await auth('post', '/events')
    .set('Idempotency-Key', randomUUID())
    .send({ type: 'order.created', payload: { orderId: '123' } });
  expect(result.status).toBe(201);
  return { event: result.body, delivery: result.body.deliveries[0], secret: endpoint.body.secret };
}
beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);
  Object.assign(process.env, {
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`,
    ENCRYPTION_KEY: '11'.repeat(32),
    NODE_ENV: 'test',
    ALLOWED_DEVELOPMENT_HOSTS: '127.0.0.1',
    WEB_ORIGIN: origin,
    DELIVERY_TIMEOUT_MS: '150',
    RETRY_BASE_MS: '100',
    MAX_ATTEMPTS: '3',
    MAX_DELIVERY_AGE_MS: '10000',
    TENANT_DELIVERY_RPS: '100',
    CIRCUIT_FAILURE_THRESHOLD: '3',
    CIRCUIT_COOLDOWN_MS: '100',
    CIRCUIT_MAX_COOLDOWN_MS: '1000',
  });
  execFileSync(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { env: process.env, stdio: 'pipe' },
  );
  receiver = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    captured.push({ body, headers: req.headers });
    const key = `${req.url}:${req.headers['webhook-id']}`;
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 400);
      return;
    }
    if (req.url === '/reject') {
      res.writeHead(400);
      res.end('rejected');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://169.254.169.254/' });
      res.end();
      return;
    }
    if (req.url === '/fail' || (req.url === '/flaky' && count < 2)) {
      res.writeHead(503);
      res.end('unavailable');
      return;
    }
    if (req.url === '/throttle' && count === 1) {
      res.writeHead(429, { 'Retry-After': '1' });
      res.end('throttle');
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as any).port}`;
  ({ db } = await import('../src/db'));
  ({ redis, deliveryQueue: queue } = await import('../src/queue'));
  await queue.waitUntilReady();
  ({ processDelivery } = await import('../src/delivery'));
  ({ dispatchBatch, reconcile } = await import('../src/outbox'));
  const { createApp } = await import('../src/app');
  app = await createApp();
  await app.init();
  const result = await request(app.getHttpServer())
    .post('/auth/register')
    .set('Origin', origin)
    .send({
      email: 'owner@test.local',
      name: 'Owner',
      workspace: 'Initial',
      password: 'a-secure-test-password',
    });
  expect(result.status).toBe(201);
  cookie = (result.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
}, 120000);
beforeEach(async () => {
  await freshWorkspace();
});
afterAll(async () => {
  if (app) await app.close();
  if (queue) await queue.close();
  if (redis) redis.disconnect();
  if (db) await db.$disconnect();
  if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
});
test('event acceptance, fanout and outbox are atomic; concurrent duplicate keys produce one event', async () => {
  const endpoint = await auth('post', '/endpoints').send({
    name: 'orders',
    url: `${receiverUrl}/success`,
    eventTypes: ['order.created'],
  });
  expect(endpoint.status).toBe(201);
  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      auth('post', '/events')
        .set('Idempotency-Key', key)
        .send({ type: 'order.created', payload: { id: 1 } }),
    ),
  );
  results.forEach((result) => expect(result.status).toBe(201));
  expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
  const eventId = results[0].body.id;
  expect(await db.delivery.count({ where: { eventId } })).toBe(1);
  expect(await db.outbox.count({ where: { delivery: { eventId } } })).toBe(1);
  const conflict = await auth('post', '/events')
    .set('Idempotency-Key', key)
    .send({ type: 'order.created', payload: { id: 2 } });
  expect(conflict.status).toBe(409);
  const skipped = await auth('post', '/events')
    .set('Idempotency-Key', randomUUID())
    .send({ type: 'user.created', payload: {} });
  expect(skipped.body.deliveries).toHaveLength(0);
});
test('signed delivery succeeds and concurrent processing sends once', async () => {
  const { delivery, event, secret } = await publish();
  await Promise.all([
    processDelivery({ deliveryId: delivery.id, generation: 0 }),
    processDelivery({ deliveryId: delivery.id, generation: 0 }),
  ]);
  const stored = await db.delivery.findUniqueOrThrow({
    where: { id: delivery.id },
    include: { attempts: true },
  });
  expect(stored.status).toBe('delivered');
  expect(stored.attempts).toHaveLength(1);
  const { signature } = await import('../src/crypto');
  const capture = captured.find((c) => c.headers['webhook-id'] === event.id)!;
  expect(capture.headers['webhook-signature']).toBe(
    `v1=${signature(secret, event.id, capture.headers['webhook-timestamp'], capture.body)}`,
  );
});
test('transient failure reschedules durably and recovers', async () => {
  const { delivery } = await publish('flaky');
  await processDelivery({ deliveryId: delivery.id, generation: 0 });
  const first = await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
  expect(first.status).toBe('retrying');
  expect(first.failureCount).toBe(1);
  expect(await db.outbox.count({ where: { deliveryId: delivery.id } })).toBe(2);
  await db.delivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
  await processDelivery({ deliveryId: delivery.id, generation: 0 });
  expect((await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe(
    'delivered',
  );
});
test('429 honors Retry-After without spending failure budget', async () => {
  const { delivery } = await publish('throttle');
  await processDelivery({ deliveryId: delivery.id, generation: 0 });
  const stored = await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
  expect(stored.status).toBe('throttled');
  expect(stored.failureCount).toBe(0);
  expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 500);
  await redis.del(`cooldown:${stored.endpointId}`);
  await db.delivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
  await processDelivery({ deliveryId: delivery.id, generation: 0 });
  expect((await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe(
    'delivered',
  );
});
test.each(['reject', 'redirect'])('%s is terminal and never follows redirects', async (mode) => {
  const { delivery } = await publish(mode);
  await processDelivery({ deliveryId: delivery.id, generation: 0 });
  expect((await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe(
    'failed',
  );
});
test('timeouts and repeated failures exhaust bounded failure budget', async () => {
  const { delivery } = await publish('slow');
  for (let i = 0; i < 3; i++) {
    await db.delivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
    await processDelivery({ deliveryId: delivery.id, generation: 0 });
  }
  const stored = await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
  expect(stored.status).toBe('failed');
  expect(stored.attemptCount).toBe(3);
  expect(stored.lastError).toContain('timed out');
});
test('replay rejects active deliveries, preserves attempts, and ignores obsolete jobs', async () => {
  const { delivery } = await publish();
  expect((await auth('post', `/deliveries/${delivery.id}/replay`).send({})).status).toBe(409);
  await processDelivery({ deliveryId: delivery.id, generation: 0 });
  const replay = await auth('post', `/deliveries/${delivery.id}/replay`).send({});
  expect(replay.status).toBe(201);
  expect(replay.body.generation).toBe(1);
  await processDelivery({ deliveryId: delivery.id, generation: 0 });
  expect((await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe(
    'pending',
  );
  await processDelivery({ deliveryId: delivery.id, generation: 1 });
  expect(await db.attempt.count({ where: { deliveryId: delivery.id } })).toBe(2);
});
test('tenant isolation, CSRF protection and restricted API key scopes', async () => {
  const { event, delivery } = await publish();
  const firstOrg = org;
  const key = await auth('post', '/keys').send({ name: 'app' });
  expect(key.status).toBe(201);
  expect(
    (
      await request(app.getHttpServer())
        .post('/events')
        .set('Authorization', `Bearer ${key.body.secret}`)
        .set('Idempotency-Key', randomUUID())
        .send({ type: 'app.event', payload: {} })
    ).status,
  ).toBe(201);
  expect(
    (
      await request(app.getHttpServer())
        .get('/endpoints')
        .set('Authorization', `Bearer ${key.body.secret}`)
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app.getHttpServer())
        .post('/keys')
        .set('Cookie', cookie)
        .set('X-Organization-Id', firstOrg)
        .send({ name: 'csrf' })
    ).status,
  ).toBe(403);
  await freshWorkspace();
  expect((await auth('get', `/events/${event.id}`)).status).toBe(404);
  expect((await auth('post', `/deliveries/${delivery.id}/replay`).send({})).status).toBe(404);
  expect((await auth('get', '/keys')).body).toHaveLength(0);
  expect((await auth('get', '/events')).body.items).toHaveLength(0);
  const rotated = await auth('post', `/keys/${key.body.id}/rotate`, firstOrg).send({});
  expect(rotated.status).toBe(201);
  expect(
    (
      await request(app.getHttpServer())
        .post('/events')
        .set('Authorization', `Bearer ${key.body.secret}`)
        .set('Idempotency-Key', randomUUID())
        .send({ type: 'app.event', payload: {} })
    ).status,
  ).toBe(401);
});
test('secret rotation sends both signatures during grace period', async () => {
  const { delivery, event, secret } = await publish();
  const rotated = await auth('post', `/endpoints/${delivery.endpointId}/rotate-secret`).send({});
  expect(rotated.status).toBe(201);
  await processDelivery({ deliveryId: delivery.id, generation: 0 });
  const capture = captured.find((c) => c.headers['webhook-id'] === event.id)!;
  const { signature } = await import('../src/crypto');
  expect(capture.headers['webhook-signature']).toContain(
    signature(secret, event.id, capture.headers['webhook-timestamp'], capture.body),
  );
  expect(capture.headers['webhook-signature']).toContain(
    signature(rotated.body.secret, event.id, capture.headers['webhook-timestamp'], capture.body),
  );
  expect(JSON.stringify((await auth('get', '/endpoints')).body)).not.toContain('secretEncrypted');
});
test('dispatcher queues committed outbox work; reconciler recovers lost queue work and expired leases', async () => {
  const { delivery } = await publish();
  await db.outbox.updateMany({
    where: { deliveryId: delivery.id },
    data: { availableAt: new Date(0) },
  });
  await dispatchBatch();
  const outbox = await db.outbox.findFirstOrThrow({ where: { deliveryId: delivery.id } });
  expect(outbox.dispatchedAt).not.toBeNull();
  expect(await queue.getJob(outbox.id)).not.toBeNull();
  await (await queue.getJob(outbox.id))!.remove();
  await db.outbox.update({ where: { id: outbox.id }, data: { dispatchedAt: new Date(0) } });
  await db.delivery.update({
    where: { id: delivery.id },
    data: {
      status: 'processing',
      nextAttemptAt: new Date(0),
      leaseUntil: new Date(0),
      leaseToken: 'dead-worker',
    },
  });
  await reconcile();
  expect(await db.outbox.count({ where: { deliveryId: delivery.id, dispatchedAt: null } })).toBe(1);
  expect(
    (await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).leaseToken,
  ).toBeNull();
});
test('queue failure rolls back dispatch acknowledgement and leaves work recoverable', async () => {
  const { delivery } = await publish();
  const spy = jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('Redis unavailable'));
  await expect(dispatchBatch()).rejects.toThrow('Redis unavailable');
  spy.mockRestore();
  expect(await db.outbox.count({ where: { deliveryId: delivery.id, dispatchedAt: null } })).toBe(1);
  await dispatchBatch();
  expect(await db.outbox.count({ where: { deliveryId: delivery.id, dispatchedAt: null } })).toBe(0);
});
test('Redis limits are atomic and tenant HTTP concurrency is bounded', async () => {
  const { rateLimit, tenantSlot } = await import('../src/queue');
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 15 }, () => rateLimit(key, 0.01, 5)));
  expect(results.filter((v) => v === 0)).toHaveLength(5);
  const slots = await Promise.all(Array.from({ length: 10 }, () => tenantSlot(key, randomUUID())));
  expect(slots.filter(Boolean)).toHaveLength(3);
});
test('disabled endpoints stop delivery; expired throttling is bounded by delivery age', async () => {
  const { delivery } = await publish();
  await auth('patch', `/endpoints/${delivery.endpointId}`).send({ enabled: false });
  await processDelivery({ deliveryId: delivery.id, generation: 0 });
  expect((await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe(
    'failed',
  );
  await freshWorkspace();
  const next = await publish();
  await db.delivery.update({ where: { id: next.delivery.id }, data: { createdAt: new Date(0) } });
  await processDelivery({ deliveryId: next.delivery.id, generation: 0 });
  expect(
    (await db.delivery.findUniqueOrThrow({ where: { id: next.delivery.id } })).lastError,
  ).toContain('maximum retry age');
});
test('invitation acceptance grants member access without owner privileges', async () => {
  const invite = await auth('post', '/invitations').send({ email: 'member@test.local' });
  expect(invite.status).toBe(201);
  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .set('Origin', origin)
    .send({
      email: 'member@test.local',
      name: 'Member',
      workspace: 'Personal',
      password: 'a-secure-test-password',
    });
  expect(registered.status).toBe(201);
  const memberCookie = (registered.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const accepted = await request(app.getHttpServer())
    .post('/auth/invitations/accept')
    .set('Origin', origin)
    .set('Cookie', memberCookie)
    .send({ token: invite.body.token });
  expect(accepted.status).toBe(201);
  expect(
    (
      await request(app.getHttpServer())
        .get('/events')
        .set('Cookie', memberCookie)
        .set('X-Organization-Id', org)
    ).status,
  ).toBe(200);
  expect(
    (
      await request(app.getHttpServer())
        .post('/keys')
        .set('Origin', origin)
        .set('Cookie', memberCookie)
        .set('X-Organization-Id', org)
        .send({ name: 'unauthorized' })
    ).status,
  ).toBe(403);
});

async function endpointEvents(mode: string, count: number) {
  const endpoint = await auth('post', '/endpoints').send({
    name: mode,
    url: `${receiverUrl}/${mode}`,
  });
  expect(endpoint.status).toBe(201);
  const deliveries = [];
  for (let i = 0; i < count; i++) {
    const result = await auth('post', '/events')
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'operations.test', payload: { i } });
    expect(result.status).toBe(201);
    deliveries.push(result.body.deliveries[0]);
  }
  return { endpoint: endpoint.body, deliveries };
}
test('circuit breaker pauses without HTTP attempts and recovers with one fenced probe', async () => {
  const { acquireCircuit, finishCircuit, circuitStates } = await import('../src/circuit');
  const { endpoint, deliveries } = await endpointEvents('fail', 4);
  for (const delivery of deliveries.slice(0, 3))
    await processDelivery({ deliveryId: delivery.id, generation: 0 });
  expect((await circuitStates([endpoint.id]))[endpoint.id].state).toBe('open');
  const paused = deliveries[3];
  await processDelivery({ deliveryId: paused.id, generation: 0 });
  const record = await db.delivery.findUniqueOrThrow({ where: { id: paused.id } });
  expect(record.status).toBe('paused');
  expect(record.attemptCount).toBe(0);
  expect(await db.attempt.count({ where: { deliveryId: paused.id } })).toBe(0);
  await redis.hset(`circuit:{${endpoint.id}}`, 'nextProbeAt', '0');
  const permits = await Promise.all(Array.from({ length: 10 }, () => acquireCircuit(endpoint.id)));
  expect(permits.filter((p) => p.allowed)).toHaveLength(1);
  const probe = permits.find((p) => p.allowed)!;
  await redis.hset(`circuit:{${endpoint.id}}`, 'probeUntil', '0');
  // A late success after probe expiry must not close the newly opened circuit.
  await finishCircuit(endpoint.id, probe, 'delivered');
  expect((await circuitStates([endpoint.id]))[endpoint.id].state).toBe('open');
  await auth('patch', `/endpoints/${endpoint.id}`).send({ url: `${receiverUrl}/success` });
  const requestProbe = await auth('post', `/endpoints/${endpoint.id}/probe`).send({});
  expect(requestProbe.status).toBe(201);
  await processDelivery({ deliveryId: paused.id, generation: 0 });
  expect((await db.delivery.findUniqueOrThrow({ where: { id: paused.id } })).status).toBe(
    'delivered',
  );
  expect((await circuitStates([endpoint.id]))[endpoint.id].state).toBe('closed');
  const history = await auth('get', `/endpoints/${endpoint.id}/circuit-history`);
  expect(history.body.some((h: any) => h.toState === 'half-open')).toBe(true);
  expect(history.body.some((h: any) => h.toState === 'closed')).toBe(true);
  await freshWorkspace();
  expect((await auth('post', `/endpoints/${endpoint.id}/probe`).send({})).status).toBe(404);
  expect((await auth('get', `/endpoints/${endpoint.id}/circuit-history`)).status).toBe(404);
});
test('old circuit responses cannot overwrite new state; 429 does not trip the closed circuit', async () => {
  const { acquireCircuit, finishCircuit, circuitStates } = await import('../src/circuit');
  const { endpoint } = await endpointEvents('success', 0);
  const stale = await acquireCircuit(endpoint.id);
  for (let i = 0; i < 3; i++)
    await finishCircuit(endpoint.id, await acquireCircuit(endpoint.id), 'retry');
  await finishCircuit(endpoint.id, stale, 'delivered');
  expect((await circuitStates([endpoint.id]))[endpoint.id].state).toBe('open');
  await redis.hset(`circuit:{${endpoint.id}}`, 'nextProbeAt', '0');
  await finishCircuit(endpoint.id, await acquireCircuit(endpoint.id), 'delivered');
  for (let i = 0; i < 5; i++)
    await finishCircuit(endpoint.id, await acquireCircuit(endpoint.id), 'throttled');
  expect((await circuitStates([endpoint.id]))[endpoint.id].state).toBe('closed');
});
test('paused circuit deliveries still expire at the maximum delivery age', async () => {
  const { endpoint, deliveries } = await endpointEvents('success', 1);
  await redis.hset(
    `circuit:{${endpoint.id}}`,
    'state',
    'open',
    'nextProbeAt',
    String(Date.now() + 60000),
  );
  await db.delivery.update({ where: { id: deliveries[0].id }, data: { createdAt: new Date(0) } });
  await processDelivery({ deliveryId: deliveries[0].id, generation: 0 });
  const expired = await db.delivery.findUniqueOrThrow({ where: { id: deliveries[0].id } });
  expect(expired.status).toBe('failed');
  expect(expired.attemptCount).toBe(0);
  expect(expired.lastError).toContain('maximum retry age');
});
