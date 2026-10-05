import { timingSafeEqual } from 'node:crypto';
import { decrypt, signature } from './crypto';
export const EVENT_TEMPLATES = [
  {
    id: 'order',
    name: 'Order created',
    type: 'order.created',
    payload: { orderId: 'ord_demo', amount: 2499, currency: 'INR' },
  },
  {
    id: 'subscription',
    name: 'Subscription updated',
    type: 'subscription.updated',
    payload: { customerId: 'cus_demo', plan: 'pro', status: 'active' },
  },
  {
    id: 'job',
    name: 'Report completed',
    type: 'report.completed',
    payload: {
      jobId: 'job_demo',
      status: 'completed',
      downloadUrl: 'https://example.com/report.csv',
    },
  },
];
export function verifyWebhook(
  input: { eventId: string; timestamp: string; rawBody: string; signature: string },
  endpoint: {
    secretEncrypted: string;
    previousSecretEncrypted: string | null;
    previousSecretUntil: Date | null;
  },
  now = Date.now(),
) {
  const secrets = [decrypt(endpoint.secretEncrypted)];
  if (
    endpoint.previousSecretEncrypted &&
    endpoint.previousSecretUntil &&
    endpoint.previousSecretUntil.getTime() > now
  )
    secrets.push(decrypt(endpoint.previousSecretEncrypted));
  const candidates = input.signature
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^v1=[a-f0-9]{64}$/i.test(v))
    .map((v) => Buffer.from(v.slice(3), 'hex'));
  const signatureValid = secrets.some((secret) => {
    const expected = Buffer.from(
      signature(secret, input.eventId, input.timestamp, input.rawBody),
      'hex',
    );
    return candidates.some(
      (value) => value.length === expected.length && timingSafeEqual(value, expected),
    );
  });
  const timestampValid =
    /^\d+$/.test(input.timestamp) && Math.abs(now / 1000 - Number(input.timestamp)) <= 300;
  return { valid: signatureValid && timestampValid, signatureValid, timestampValid };
}
