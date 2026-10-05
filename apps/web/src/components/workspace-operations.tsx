'use client';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, time, type Endpoint, type Event } from '@/lib/api';
import { Button, Badge, Modal } from './ui';
function ErrorText({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="my-3 rounded-lg bg-red-50 p-3 text-sm text-red-600">
      {(error as Error).message || String(error)}
    </p>
  ) : null;
}
export function RetentionSettings({ org, owner }: { org: string; owner: boolean }) {
  const qc = useQueryClient();
  const policy = useQuery<any>({
    queryKey: ['retention', org],
    queryFn: () => api('/settings/retention', org),
    refetchInterval: 10000,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError('');
    setResult('');
    try {
      await api('/settings/retention', org, 'PATCH', {
        eventRetentionDays: values.events ? Number(values.events) : null,
        attemptRetentionDays: values.attempts ? Number(values.attempts) : null,
      });
      await qc.invalidateQueries({ queryKey: ['retention', org] });
      setResult('Policy saved. Automatic cleanup runs in bounded batches.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function clean() {
    setBusy(true);
    setError('');
    try {
      const r = await api<any>('/settings/retention/run', org, 'POST');
      setResult(
        r.busy
          ? 'Another cleanup is running.'
          : `Removed ${r.eventsDeleted} events and ${r.attemptsDeleted} attempts.`,
      );
      setConfirm(false);
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <ErrorText error={error || policy.error} />
      <section className="card p-5">
        <h2 className="font-semibold">Data retention</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Leave a field empty to retain that data. Only old, terminal deliveries are eligible;
          active deliveries, live leases, and queued replays are protected. Event deletion also
          removes its delivery and attempt history.
        </p>
        {policy.data && (
          <form
            key={`${org}:${policy.data.eventRetentionDays}:${policy.data.attemptRetentionDays}`}
            onSubmit={save}
            className="mt-5 max-w-md"
          >
            <label className="label" htmlFor="retention-events">
              Event retention (days)
            </label>
            <input
              id="retention-events"
              name="events"
              type="number"
              min="1"
              max="3650"
              className="field"
              defaultValue={policy.data.eventRetentionDays ?? ''}
              disabled={!owner}
              placeholder="Keep indefinitely"
            />
            <label className="label" htmlFor="retention-attempts">
              Attempt retention (days)
            </label>
            <input
              id="retention-attempts"
              name="attempts"
              type="number"
              min="1"
              max="3650"
              className="field"
              defaultValue={policy.data.attemptRetentionDays ?? ''}
              disabled={!owner}
              placeholder="Keep indefinitely"
            />
            <p className="my-4 text-xs text-slate-500">
              Saving enables automatic deletion under this policy. Payloads cannot be recovered
              after cleanup. Minimal idempotency records remain to prevent duplicate publishing.
            </p>
            {owner && <Button disabled={busy}>Save retention policy</Button>}
          </form>
        )}
        {result && (
          <p role="status" className="mt-4 text-sm text-emerald-700">
            {result}
          </p>
        )}
      </section>
      <section className="card p-5">
        <h2 className="font-semibold">Expiry preview</h2>
        <p className="mt-3 text-sm">
          {policy.data?.eligibleEvents ?? 0} eligible events · {policy.data?.eligibleAttempts ?? 0}{' '}
          eligible attempts under the attempt policy
        </p>
        <p className="mt-2 text-xs text-slate-500">
          One run removes at most 100 events and 500 standalone attempts. Related history is removed
          with each event.
        </p>
        {owner && (
          <Button
            className="mt-4"
            variant="danger"
            disabled={
              busy || (!policy.data?.eventRetentionDays && !policy.data?.attemptRetentionDays)
            }
            onClick={() => setConfirm(true)}
          >
            Run cleanup now
          </Button>
        )}
        <div className="mt-5 space-y-2">
          {policy.data?.runs.map((r: any) => (
            <p key={r.id} className="text-xs text-slate-500">
              {time(r.createdAt)} · {r.eventsDeleted} events · {r.attemptsDeleted} attempts removed
            </p>
          ))}
        </div>
      </section>
      <Modal
        open={confirm}
        close={() => setConfirm(false)}
        title="Run retention cleanup"
        description="Deletion is permanent. Active delivery work remains protected."
      >
        <p className="my-5 text-sm">Remove one batch of data eligible under the saved policy?</p>
        <Button variant="danger" disabled={busy} onClick={() => void clean()}>
          Confirm cleanup
        </Button>
      </Modal>
    </div>
  );
}
type AlertRule = {
  id: string;
  name: string;
  enabled: boolean;
  endpointId: string | null;
  notificationEndpointId: string | null;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
};
export function AlertsConsole({
  org,
  owner,
  endpoints,
}: {
  org: string;
  owner: boolean;
  endpoints: Endpoint[];
}) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const rules = useQuery<AlertRule[]>({
    queryKey: ['alert-rules', org],
    queryFn: () => api('/alert-rules', org),
  });
  const alerts = useQuery<any>({
    queryKey: ['alerts', org, status, cursor],
    queryFn: () =>
      api(`/alerts?${new URLSearchParams({ status, ...(cursor ? { cursor } : {}) })}`, org),
    refetchInterval: 5000,
  });
  async function action(fn: () => Promise<any>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    await action(async () => {
      await api(
        editing ? `/alert-rules/${editing.id}` : '/alert-rules',
        org,
        editing ? 'PATCH' : 'POST',
        {
          name: v.name,
          endpointId: v.endpointId || null,
          notificationEndpointId: v.notificationEndpointId || null,
          threshold: Number(v.threshold),
          windowMinutes: Number(v.windowMinutes),
          cooldownMinutes: Number(v.cooldownMinutes),
        },
      );
      setModal(false);
      setEditing(null);
    });
  }
  return (
    <div className="space-y-5">
      <ErrorText error={error || rules.error || alerts.error} />
      <section className="card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Delivery alert rules</h2>
          {owner && (
            <Button
              onClick={() => {
                setEditing(null);
                setModal(true);
              }}
            >
              Add alert rule
            </Button>
          )}
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Watch distinct production deliveries with failures since the endpoint's latest successful
          response. Test traffic and alert notifications are excluded. Each rule opens one incident
          per endpoint and sends an optional signed webhook on opening and recovery.
        </p>
        <div className="mt-5 space-y-3">
          {rules.data?.map((r) => (
            <div key={r.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap justify-between gap-3">
                <span className="font-medium">{r.name}</span>
                <Badge status={r.enabled ? 'enabled' : 'disabled'} />
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {r.threshold} failed deliveries · {r.windowMinutes}-minute window ·{' '}
                {r.cooldownMinutes}-minute incident cooldown
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Watching {endpoints.find((e) => e.id === r.endpointId)?.name ?? 'all endpoints'} ·
                Notify{' '}
                {endpoints.find((e) => e.id === r.notificationEndpointId)?.name ?? 'in app only'}
              </p>
              {owner && (
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditing(r);
                      setModal(true);
                    }}
                  >
                    Edit rule
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        api(`/alert-rules/${r.id}`, org, 'PATCH', { enabled: !r.enabled }),
                      )
                    }
                  >
                    {r.enabled ? 'Disable rule' : 'Enable rule'}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
        {!rules.data?.length && (
          <p className="mt-5 text-sm text-slate-400">No alert rules configured.</p>
        )}
      </section>
      <section className="card p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <h2 className="font-semibold">Incidents</h2>
          <select
            className="field w-auto"
            aria-label="Alert status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursor('');
            }}
          >
            <option value="">All incidents</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        <div className="mt-4 space-y-3">
          {alerts.data?.items.map((a: any) => (
            <article key={a.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-medium">
                  {a.endpoint.name} · {a.rule.name}
                </h3>
                <Badge status={a.resolvedAt ? 'resolved' : 'open'} />
              </div>
              <p className="mt-3 text-sm">{a.message}</p>
              <p className="mt-2 text-xs text-slate-400">
                {time(a.createdAt)}
                {a.acknowledgedAt ? ' · Acknowledged' : ''}
              </p>
              {!a.acknowledgedAt && (
                <Button
                  variant="secondary"
                  className="mt-3"
                  disabled={busy}
                  onClick={() => void action(() => api(`/alerts/${a.id}/acknowledge`, org, 'POST'))}
                >
                  Acknowledge
                </Button>
              )}
              {a.notifications.map((n: any) => (
                <p key={n.id} className="mt-3 text-xs text-slate-500">
                  {n.phase} notification: {n.event?.deliveries[0]?.status ?? 'expired'}
                  {n.event?.deliveries[0]?.lastError && ` · ${n.event.deliveries[0].lastError}`}
                </p>
              ))}
            </article>
          ))}
        </div>
        {!alerts.data?.items.length && (
          <p className="mt-5 text-sm text-slate-400">No incidents match this filter.</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {cursor && (
            <Button variant="secondary" onClick={() => setCursor('')}>
              First page
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={!alerts.data?.nextCursor}
            onClick={() => setCursor(alerts.data?.nextCursor ?? '')}
          >
            Next page
          </Button>
        </div>
      </section>
      <Modal
        open={modal}
        close={() => setModal(false)}
        title={editing ? 'Edit alert rule' : 'Create alert rule'}
        description="Notifications use the selected endpoint's signing secret and normal delivery safeguards."
      >
        <form onSubmit={save} className="mt-5">
          <label className="label" htmlFor="alert-name">
            Rule name
          </label>
          <input
            className="field"
            id="alert-name"
            name="name"
            required
            maxLength={100}
            defaultValue={editing?.name}
          />
          <label className="label" htmlFor="alert-endpoint">
            Monitored endpoint
          </label>
          <select
            className="field"
            id="alert-endpoint"
            name="endpointId"
            defaultValue={editing?.endpointId ?? ''}
          >
            <option value="">All endpoints</option>
            {endpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <label className="label" htmlFor="alert-notification">
            Notification endpoint
          </label>
          <select
            className="field"
            id="alert-notification"
            name="notificationEndpointId"
            defaultValue={editing?.notificationEndpointId ?? ''}
          >
            <option value="">In app only</option>
            {endpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          {[
            ['threshold', 'Failure threshold', 3, 1000],
            ['windowMinutes', 'Window (minutes)', 15, 1440],
            ['cooldownMinutes', 'Cooldown (minutes)', 30, 1440],
          ].map(([key, label, fallback, max]) => (
            <div key={key}>
              <label className="label" htmlFor={`alert-${key}`}>
                {label}
              </label>
              <input
                className="field"
                id={`alert-${key}`}
                name={String(key)}
                type="number"
                min="1"
                max={Number(max)}
                required
                defaultValue={(editing?.[key as keyof AlertRule] as number) ?? Number(fallback)}
              />
            </div>
          ))}
          <ErrorText error={error} />
          <Button className="mt-5" disabled={busy}>
            Save alert rule
          </Button>
        </form>
      </Modal>
    </div>
  );
}
type Template = { id: string; name: string; type: string; payload: unknown };
export function WebhookTesting({ org, endpoints }: { org: string; endpoints: Endpoint[] }) {
  const qc = useQueryClient();
  const [endpointId, setEndpointId] = useState('');
  const [type, setType] = useState('order.created');
  const [payload, setPayload] = useState('{"orderId":"ord_demo","amount":2499,"currency":"INR"}');
  const [eventId, setEventId] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verification, setVerification] = useState<{
    valid: boolean;
    signatureValid: boolean;
    timestampValid: boolean;
  } | null>(null);
  const templates = useQuery<Template[]>({
    queryKey: ['test-templates', org],
    queryFn: () => api('/testing/templates', org),
  });
  const events = useQuery<Event[]>({
    queryKey: ['test-events', org],
    queryFn: () => api('/testing/events', org),
    refetchInterval: 3000,
  });
  const detail = useQuery<Event>({
    queryKey: ['test-event', org, eventId],
    queryFn: () => api(`/testing/events/${eventId}`, org),
    enabled: !!eventId,
    refetchInterval: 2000,
  });
  function changed() {
    setKey('');
    setVerification(null);
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setVerification(null);
    const requestKey = key || crypto.randomUUID();
    setKey(requestKey);
    try {
      const result = await api<Event>(
        '/testing/events',
        org,
        'POST',
        { endpointId, type, payload: JSON.parse(payload) },
        { 'Idempotency-Key': requestKey },
      );
      setEventId(result.id);
      setKey('');
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError('');
    try {
      setVerification(await api('/testing/verify-signature', org, 'POST', data));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const delivery = detail.data?.deliveries[0];
  const attempt = delivery?.attempts?.[0];
  const headers = attempt?.requestHeaders;
  return (
    <div className="space-y-5">
      <ErrorText error={error || templates.error || events.error || detail.error} />
      <section className="card p-5">
        <h2 className="font-semibold">Send a sample webhook</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Targets one enabled endpoint, independently of its subscriptions. Test requests include
          webhook-test: true. Your receiver should handle that header without business side effects.
          Tests use normal signatures, quotas, retries, and circuit breakers.
        </p>
        <form onSubmit={send} className="mt-5">
          <label className="label" htmlFor="test-endpoint">
            Test endpoint
          </label>
          <select
            className="field"
            id="test-endpoint"
            required
            value={endpointId}
            onChange={(e) => {
              setEndpointId(e.target.value);
              changed();
            }}
          >
            <option value="">Choose an endpoint</option>
            {endpoints
              .filter((e) => e.enabled)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
          <label className="label" htmlFor="test-template">
            Payload template
          </label>
          <select
            className="field"
            id="test-template"
            onChange={(e) => {
              const t = templates.data?.find((t) => t.id === e.target.value);
              if (t) {
                setType(t.type);
                setPayload(JSON.stringify(t.payload, null, 2));
                changed();
              }
            }}
          >
            <option value="">Custom payload</option>
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <label className="label" htmlFor="test-type">
            Test event type
          </label>
          <input
            className="field"
            id="test-type"
            value={type}
            required
            onChange={(e) => {
              setType(e.target.value);
              changed();
            }}
          />
          <label className="label" htmlFor="test-payload">
            Test payload (JSON)
          </label>
          <textarea
            className="field mono min-h-36"
            id="test-payload"
            value={payload}
            required
            onChange={(e) => {
              setPayload(e.target.value);
              changed();
            }}
          />
          <Button className="mt-4" disabled={busy || !endpointId}>
            Send test webhook
          </Button>
        </form>
      </section>
      <section className="card p-5">
        <h2 className="font-semibold">Receiver diagnostics</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {events.data?.map((e) => (
            <Button
              key={e.id}
              variant="secondary"
              onClick={() => {
                setEventId(e.id);
                setVerification(null);
              }}
            >
              {e.type} · {time(e.createdAt)}
            </Button>
          ))}
        </div>
        {delivery && (
          <div className="mt-5">
            <Badge status={delivery.status} />
            <p className="mt-3 text-sm">
              {delivery.endpoint.name} · {delivery.attemptCount} HTTP attempts
            </p>
            {delivery.lastError && (
              <p className="mt-2 text-sm text-red-600">{delivery.lastError}</p>
            )}
            {delivery.attempts?.map((a) => (
              <div key={a.id} className="mt-3 rounded-lg border border-slate-200 p-3">
                <p className="text-sm">
                  HTTP {a.statusCode ?? 'network error'} · {a.durationMs} ms · {a.outcome}
                </p>
                <pre className="mono mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-500">
                  {a.responseSnippet || a.error}
                </pre>
              </div>
            ))}
            {headers && (
              <>
                <p className="mt-5 text-sm font-semibold">Request headers</p>
                <pre className="mono mt-2 overflow-auto rounded-lg bg-slate-50 p-3 text-xs">
                  {JSON.stringify(headers, null, 2)}
                </pre>
              </>
            )}
          </div>
        )}
        {!eventId && (
          <p className="mt-5 text-sm text-slate-400">Send a test or choose a recent test event.</p>
        )}
      </section>
      <section className="card p-5">
        <h2 className="font-semibold">Verify a captured signature</h2>
        <p className="mt-2 text-sm text-slate-500">
          Checks the exact raw body and timestamp against the endpoint's current and valid previous
          signing secrets.
        </p>
        <form key={attempt?.id ?? eventId} onSubmit={verify} className="mt-5">
          <label className="label" htmlFor="verify-endpoint">
            Signing endpoint
          </label>
          <select
            id="verify-endpoint"
            name="endpointId"
            className="field"
            defaultValue={delivery?.endpoint.id ?? endpointId}
            required
          >
            <option value="">Choose an endpoint</option>
            {endpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          {(
            [
              ['eventId', 'Webhook ID', headers?.['webhook-id'] ?? ''],
              ['timestamp', 'Webhook timestamp', headers?.['webhook-timestamp'] ?? ''],
              ['signature', 'Webhook signature', headers?.['webhook-signature'] ?? ''],
            ] as const
          ).map(([name, label, value]) => (
            <div key={name}>
              <label className="label" htmlFor={`verify-${name}`}>
                {label}
              </label>
              <input
                id={`verify-${name}`}
                name={name}
                className="field mono"
                defaultValue={value}
                required
              />
            </div>
          ))}
          <label className="label" htmlFor="verify-body">
            Exact raw request body
          </label>
          <textarea
            id="verify-body"
            name="rawBody"
            className="field mono min-h-32"
            defaultValue={attempt?.requestBody ?? ''}
            required
          />
          <Button className="mt-4" disabled={busy}>
            Verify signature
          </Button>
        </form>
        {verification && (
          <p
            role="status"
            className={`mt-4 text-sm ${verification.valid ? 'text-emerald-700' : 'text-red-600'}`}
          >
            {verification.valid
              ? 'Valid signature and timestamp'
              : `Verification failed: signature ${verification.signatureValid ? 'valid' : 'invalid'}, timestamp ${verification.timestampValid ? 'valid' : 'invalid'}`}
          </p>
        )}
      </section>
    </div>
  );
}
