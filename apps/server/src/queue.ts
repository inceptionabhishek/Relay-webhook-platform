import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { config } from './config';
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
redis.on('error', () => {});
export const queueName = 'relay-deliveries';
export const deliveryQueue = new Queue(queueName, {
  connection: {
    url: config.REDIS_URL,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    commandTimeout: 5000,
  },
  defaultJobOptions: {
    attempts: 20,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600, count: 10000 },
    removeOnFail: { age: 86400, count: 10000 },
  },
});
deliveryQueue.on('error', () => {});
// Redis TIME makes token refill consistent across instances with different local clocks.
export const BUCKET_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local tokens = math.min(capacity, (tonumber(values[1]) or capacity) + math.max(0, now - (tonumber(values[2]) or now)) * rate / 1000)
local delay = 0
if tokens >= 1 then tokens = tokens - 1 else delay = math.ceil((1 - tokens) * 1000 / rate) end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 2000))
return delay
`;
export async function rateLimit(key: string, rate: number, capacity = rate) {
  return Number(await redis.eval(BUCKET_LUA, 1, key, rate, capacity));
}
// Short expiring slots bound one tenant's active HTTP requests. Expiration recovers crashed workers.
export const SLOT_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
return 1
`;
export async function tenantSlot(organizationId: string, lease: string) {
  return (
    Number(
      await redis.eval(
        SLOT_LUA,
        1,
        `active:{${organizationId}}`,
        lease,
        3,
        config.DELIVERY_TIMEOUT_MS + 10000,
      ),
    ) === 1
  );
}
