export function retryAfterMs(value: string | undefined, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, Math.min(delay, 86400000)) : undefined;
}
export function classify(status: number) {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 429) return 'throttled';
  if (status === 408 || status === 425 || status >= 500) return 'retry';
  return 'failed'; // Includes redirects: following them could bypass destination validation.
}
export function backoff(failures: number, base: number, random = Math.random) {
  return Math.min(3600000, base * 2 ** Math.min(failures - 1, 12)) * (0.75 + random() * 0.5);
}
