import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config';
import { promisify } from 'node:util';
const deriveKey = promisify(scrypt);
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = (prefix = '') => prefix + randomBytes(32).toString('base64url');
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${((await deriveKey(password, salt, 64)) as Buffer).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, digest] = stored.split(':');
  const expected = Buffer.from(digest, 'hex');
  const actual = (await deriveKey(password, salt, 64)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.ENCRYPTION_KEY, 'hex'), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
export function decrypt(value: string) {
  const [iv, tag, data] = value.split('.').map((v) => Buffer.from(v, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(config.ENCRYPTION_KEY, 'hex'), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
export function signature(secret: string, eventId: string, timestamp: string, body: string) {
  return createHmac('sha256', secret).update(`${eventId}.${timestamp}.${body}`).digest('hex');
}
