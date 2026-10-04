export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export async function api<T = any>(
  path: string,
  organizationId?: string,
  method = 'GET',
  body?: unknown,
  extra?: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? `Request failed (${response.status})`);
  return data;
}
export const time = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export type Endpoint = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  eventTypes: string[];
  createdAt: string;
};
export type Delivery = {
  id: string;
  status: string;
  attemptCount: number;
  failureCount: number;
  generation: number;
  nextAttemptAt: string;
  lastError?: string;
  endpoint: { name: string; url: string };
  attempts?: {
    id: string;
    number: number;
    generation: number;
    statusCode?: number;
    durationMs: number;
    error?: string;
    responseSnippet?: string;
    outcome: string;
    createdAt: string;
  }[];
};
export type Event = {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
  deliveries: Delivery[];
};
export type Stats = {
  events: number;
  endpoints: number;
  counts: Record<string, number>;
  p95: number;
  attempts: number;
  hourly: { hour: string; delivered: number; failed: number }[];
};
