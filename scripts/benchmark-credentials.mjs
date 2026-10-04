import { mkdirSync, writeFileSync } from 'node:fs';
process.loadEnvFile('.env');
const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Origin: origin },
  body: JSON.stringify({ email: process.env.SEED_EMAIL, password: process.env.SEED_PASSWORD }),
});
if (!login.ok) throw new Error('Demo login failed');
const cookie = login.headers.get('set-cookie').split(';')[0];
const me = await fetch(`${base}/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
const key = await fetch(`${base}/keys`, {
  method: 'POST',
  headers: {
    Cookie: cookie,
    Origin: origin,
    'X-Organization-Id': me.organizations[0].id,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ name: 'Local synthetic benchmark' }),
}).then((r) => r.json());
if (!key.secret) throw new Error('Key creation failed');
mkdirSync('work', { recursive: true });
writeFileSync(
  'work/k6.env',
  `API_KEY=${key.secret}\nRATE=10\nDURATION=10s\nRUN_ID=${Date.now()}\n`,
  { mode: 0o600 },
);
writeFileSync(
  'work/benchmark-key.json',
  JSON.stringify({ keyId: key.id, organizationId: me.organizations[0].id }),
  { mode: 0o600 },
);
console.log('Prepared a local synthetic benchmark credential in ignored work/k6.env.');
