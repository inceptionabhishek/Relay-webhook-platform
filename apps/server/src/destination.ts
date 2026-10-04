import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';
import { config } from './config';
export class UnsafeDestination extends Error {}
export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export async function resolveDestination(input: string) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new UnsafeDestination('Only HTTP(S) URLs without credentials or fragments are allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const allowed =
    config.NODE_ENV !== 'production' &&
    config.ALLOWED_DEVELOPMENT_HOSTS.split(',').includes(hostname);
  if (config.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new UnsafeDestination('Production destinations require HTTPS');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true }).catch(() => {
        throw new UnsafeDestination('Destination hostname could not be resolved');
      });
  if (!addresses.length || (!allowed && addresses.some((a) => !isPublicAddress(a.address))))
    throw new UnsafeDestination(
      'Private, loopback, link-local and reserved destinations are blocked',
    );
  return { url, address: addresses.find((address) => address.family === 4) ?? addresses[0] };
}
export type HttpResult = { statusCode: number; body: string; retryAfter?: string };
export async function sendWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<HttpResult> {
  // Re-resolve every attempt, validate all addresses, and pin the chosen address in the HTTP lookup.
  const destination = await resolveDestination(url);
  return new Promise((resolve, reject) => {
    const request = (destination.url.protocol === 'https:' ? httpsRequest : httpRequest)(
      destination.url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
        },
        lookup: ((_host: string, options: any, callback: any) => {
          if (options?.all) callback(null, [destination.address]);
          else callback(null, destination.address.address, destination.address.family);
        }) as any,
      },
      (response) => {
        let size = 0;
        let snippet = '';
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 65536) {
            response.destroy();
            request.destroy(new Error('Response exceeds 64 KiB'));
            return;
          }
          if (snippet.length < 2000) snippet += chunk.toString().slice(0, 2000 - snippet.length);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            body: snippet,
            retryAfter: Array.isArray(response.headers['retry-after'])
              ? response.headers['retry-after'][0]
              : response.headers['retry-after'],
          }),
        );
      },
    );
    // A wall-clock deadline also covers a server that keeps dripping response bytes.
    const timer = setTimeout(
      () => request.destroy(new Error('Delivery timed out')),
      config.DELIVERY_TIMEOUT_MS,
    );
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(body);
  });
}
