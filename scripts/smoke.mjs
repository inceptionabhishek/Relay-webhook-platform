import assert from 'node:assert/strict';
process.loadEnvFile('.env');
const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const health = await fetch(`${base}/health`).then((r) => r.json());
assert.equal(health.status, 'ok');
const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Origin: origin },
  body: JSON.stringify({ email: process.env.SEED_EMAIL, password: process.env.SEED_PASSWORD }),
});
assert.equal(login.status, 201);
const cookie = login.headers.get('set-cookie').split(';')[0];
const me = await fetch(`${base}/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
const headers = {
  Cookie: cookie,
  Origin: origin,
  'X-Organization-Id': me.organizations[0].id,
  'content-type': 'application/json',
};
const published = await fetch(`${base}/events`, {
  method: 'POST',
  headers: { ...headers, 'Idempotency-Key': `smoke-${Date.now()}` },
  body: JSON.stringify({ type: 'smoke.test', payload: { source: 'local-stack-verification' } }),
});
assert.equal(published.status, 201);
const event = await published.json();
assert.ok(event.deliveries.length > 0);
let delivered = false;
for (let attempt = 0; attempt < 30; attempt++) {
  const detail = await fetch(`${base}/events/${event.id}`, { headers }).then((r) => r.json());
  if (detail.deliveries.every((d) => d.status === 'delivered')) {
    delivered = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.ok(delivered, 'Smoke event was not delivered');
console.log('API readiness, demo login, durable publication, and asynchronous delivery passed.');
for (const [name, url] of [
  ['Grafana', 'http://localhost:3001/api/health'],
  ['Prometheus', 'http://localhost:9090/-/ready'],
  ['Jaeger', 'http://localhost:16686/'],
]) {
  const response = await fetch(url);
  assert.ok(response.ok, `${name} is unavailable`);
  console.log(`${name} is ready.`);
}
await new Promise((resolve) => setTimeout(resolve, 12000));
const targets = await fetch('http://localhost:9090/api/v1/targets').then((r) => r.json());
assert.equal(targets.data.activeTargets.length, 3);
assert.ok(targets.data.activeTargets.every((target) => target.health === 'up'));
console.log('All three application metric targets are being scraped.');
const traces = await fetch('http://localhost:16686/api/traces?service=relay-worker&limit=5').then(
  (r) => r.json(),
);
assert.ok(traces.data.length > 0, 'No worker traces exported');
console.log('Worker traces are visible in Jaeger.');
