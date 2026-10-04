import { config as load } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
load({ path: resolve(__dirname, '../../../.env'), quiet: true });
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
  ALLOWED_DEVELOPMENT_HOSTS: z.string().default(''),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  TENANT_DELIVERY_RPS: z.coerce.number().int().min(1).default(10),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  RETRY_BASE_MS: z.coerce.number().int().min(10).default(1000),
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  MAX_DELIVERY_AGE_MS: z.coerce.number().int().min(1000).default(86400000),
});
export const config = schema.parse(process.env);
if (config.NODE_ENV === 'production' && config.ALLOWED_DEVELOPMENT_HOSTS) {
  throw new Error('Development destination allowlists must be empty in production');
}
