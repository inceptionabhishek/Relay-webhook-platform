import { readFileSync } from 'node:fs';
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
const key = JSON.parse(readFileSync('work/benchmark-key.json', 'utf8'));
const response = await fetch(`${base}/keys/${key.keyId}`, {
  method: 'DELETE',
  headers: { Cookie: cookie, Origin: origin, 'X-Organization-Id': key.organizationId },
});
if (!response.ok) throw new Error('Key revocation failed');
console.log('Revoked the temporary benchmark key.');
