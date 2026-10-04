import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const path = new URL('../.env', import.meta.url);
if (existsSync(path)) {
  console.log('.env already exists; keeping your configuration.');
} else {
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
    .replace('ENCRYPTION_KEY=\n', `ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`)
    .replace('SEED_PASSWORD=\n', `SEED_PASSWORD=${randomBytes(12).toString('base64url')}\n`);
  writeFileSync(path, text, { mode: 0o600 });
  console.log('Created .env. Your demo login is SEED_EMAIL / SEED_PASSWORD in this file.');
}
