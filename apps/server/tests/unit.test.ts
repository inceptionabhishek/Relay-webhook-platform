process.env.ENCRYPTION_KEY = '11'.repeat(32);
process.env.DATABASE_URL = 'postgresql://unused';
process.env.REDIS_URL = 'redis://unused';
process.env.NODE_ENV = 'test';
process.env.ALLOWED_DEVELOPMENT_HOSTS = 'localhost';
import { encrypt, decrypt, signature, passwordHash, verifyPassword } from '../src/crypto';
import { classify, retryAfterMs, backoff } from '../src/policy';
import { isPublicAddress, resolveDestination } from '../src/destination';
describe('Delivery policies and security', () => {
  test('encrypts secrets with authenticated encryption', () => {
    const value = encrypt('whsec_test');
    expect(value).not.toContain('whsec_test');
    expect(decrypt(value)).toBe('whsec_test');
    const parts = value.split('.');
    parts[1] = Buffer.alloc(16).toString('base64');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });
  test('verifies password hashes', async () => {
    const value = await passwordHash('strong-password');
    expect(await verifyPassword('strong-password', value)).toBe(true);
    expect(await verifyPassword('wrong', value)).toBe(false);
  });
  test('signatures cover ID, timestamp and exact body', () => {
    const value = signature('secret', 'event', '123', '{}');
    expect(value).toHaveLength(64);
    expect(signature('secret', 'event', '123', '{ }')).not.toBe(value);
    expect(signature('secret', 'other', '123', '{}')).not.toBe(value);
  });
  test.each([
    [200, 'delivered'],
    [204, 'delivered'],
    [429, 'throttled'],
    [503, 'retry'],
    [408, 'retry'],
    [400, 'failed'],
    [302, 'failed'],
  ])('classifies HTTP %s', (status, outcome) => expect(classify(Number(status))).toBe(outcome));
  test('supports numeric and date Retry-After, and caps delays', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('bad')).toBeUndefined();
    expect(retryAfterMs('999999')).toBe(86400000);
    expect(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000)).toBe(4000);
  });
  test('backoff grows and includes bounded jitter', () => {
    expect(backoff(1, 1000, () => 0.5)).toBe(1000);
    expect(backoff(3, 1000, () => 0.5)).toBe(4000);
    expect(backoff(1, 1000, () => 0)).toBe(750);
  });
  test.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.2',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '100.64.0.1',
    '0.0.0.0',
  ])('blocks nonpublic destination %s', (address) => expect(isPublicAddress(address)).toBe(false));
  test('permits public addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  test('rejects unsupported URL schemes and embedded credentials', async () => {
    await expect(resolveDestination('file:///etc/passwd')).rejects.toThrow();
    await expect(resolveDestination('http://user:pass@localhost/')).rejects.toThrow();
    await expect(resolveDestination('http://169.254.169.254/latest')).rejects.toThrow();
  });
});
