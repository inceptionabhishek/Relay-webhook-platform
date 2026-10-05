'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Badge, Modal } from './ui';
import { api, time, type Endpoint } from '@/lib/api';

type Failure = {
  id: string;
  eventId: string;
  lastError: string;
  attemptCount: number;
  createdAt: string;
  endpoint: { id: string; name: string; enabled: boolean };
  event: { id: string; type: string };
};
type Batch = {
  id: string;
  status: string;
  total: number;
  queued: number;
  replayed: number;
  skipped: number;
  createdAt: string;
  outcomes: Record<string, number>;
  items: {
    id: string;
    deliveryId: string;
    status: string;
    error?: string;
    deliveryStatus: string;
  }[];
};
export function FailureInbox({
  org,
  endpoints,
  inspect,
}: {
  org: string;
  endpoints: Endpoint[];
  inspect: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [endpointId, setEndpointId] = useState('');
  const [cursor, setCursor] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [batchId, setBatchId] = useState('');
  const [requestKey, setRequestKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const failures = useQuery<{ total: number; items: Failure[]; nextCursor: string | null }>({
    queryKey: ['failures', org, search, endpointId, cursor],
    queryFn: () =>
      api(
        `/failures?${new URLSearchParams({ search, endpointId, ...(cursor ? { cursor } : {}) })}`,
        org,
      ),
    refetchInterval: 3000,
  });
  const batches = useQuery<Batch[]>({
    queryKey: ['replay-batches', org],
    queryFn: () => api('/replay-batches', org),
    refetchInterval: 3000,
  });
  const batch = useQuery<Batch>({
    queryKey: ['replay-batch', org, batchId],
    queryFn: () => api(`/replay-batches/${batchId}`, org),
    enabled: !!batchId,
    refetchInterval: 3000,
  });
  const items = failures.data?.items ?? [];
  function selection(ids: string[]) {
    setSelected(ids);
    setRequestKey('');
    setError('');
  }
  function resetFilters() {
    setCursor('');
    selection([]);
  }
  async function replay() {
    setBusy(true);
    setError('');
    const key = requestKey || crypto.randomUUID();
    setRequestKey(key);
    try {
      const result = await api<Batch>(
        '/replay-batches',
        org,
        'POST',
        { deliveryIds: selected },
        { 'Idempotency-Key': key },
      );
      setBatchId(result.id);
      setConfirm(false);
      selection([]);
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      {(error || failures.error || batches.error || batch.error) && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
          {error || ((failures.error || batches.error || batch.error) as Error).message}
        </p>
      )}
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <input
            className="field min-w-0 flex-1"
            aria-label="Search failed event types"
            placeholder="Search by event type…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetFilters();
            }}
          />
          <select
            className="field w-auto max-w-full"
            aria-label="Filter failed endpoints"
            value={endpointId}
            onChange={(e) => {
              setEndpointId(e.target.value);
              resetFilters();
            }}
          >
            <option value="">All endpoints</option>
            {endpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <Button disabled={!selected.length || busy} onClick={() => setConfirm(true)}>
            Replay selected ({selected.length})
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 p-4 text-xs text-slate-500">
          <span>{failures.data?.total ?? 0} failed deliveries</span>
          <Button
            variant="ghost"
            onClick={() =>
              selection([
                ...new Set([
                  ...selected,
                  ...items.filter((d) => d.endpoint.enabled).map((d) => d.id),
                ]),
              ])
            }
            disabled={!items.length}
          >
            Select this page
          </Button>
          {!!selected.length && (
            <Button variant="ghost" onClick={() => selection([])}>
              Clear selection
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Select</th>
                <th>Event / endpoint</th>
                <th>Last error</th>
                <th>Attempts</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select delivery ${d.id}`}
                      disabled={!d.endpoint.enabled || busy}
                      checked={selected.includes(d.id)}
                      onChange={(e) =>
                        selection(
                          e.target.checked
                            ? [...selected, d.id]
                            : selected.filter((id) => id !== d.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <button className="text-left font-medium" onClick={() => inspect(d.event.id)}>
                      {d.event.type}
                    </button>
                    <p className="mt-1 text-xs text-slate-500">
                      {d.endpoint.name}
                      {!d.endpoint.enabled && ' · Disabled'}
                    </p>
                  </td>
                  <td className="max-w-xs break-words text-xs text-red-600">
                    {d.lastError || 'Delivery failed'}
                  </td>
                  <td>{d.attemptCount}</td>
                  <td className="whitespace-nowrap text-xs">{time(d.createdAt)}</td>
                  <td>
                    <Button variant="ghost" onClick={() => inspect(d.event.id)}>
                      Inspect
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length && (
          <p className="p-8 text-center text-sm text-slate-500">
            {failures.isPending
              ? 'Loading failed deliveries…'
              : 'No failed deliveries match these filters.'}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 p-3">
          {cursor && (
            <Button variant="secondary" onClick={() => setCursor('')}>
              First page
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={!failures.data?.nextCursor}
            onClick={() => setCursor(failures.data?.nextCursor ?? '')}
          >
            Next page
          </Button>
        </div>
      </section>
      <section className="card p-5">
        <h2 className="font-semibold">Replay batches</h2>
        <p className="mt-2 text-xs text-slate-500">
          Batch completion means scheduling finished. Delivery outcomes continue updating below.
        </p>
        {!batches.data?.length && (
          <p className="mt-5 text-sm text-slate-400">No replay batches yet.</p>
        )}
        <div className="mt-4 space-y-3">
          {batches.data?.map((b) => (
            <button
              key={b.id}
              className="block w-full rounded-lg border border-slate-200 p-4 text-left hover:bg-slate-50"
              onClick={() => setBatchId(b.id)}
            >
              <div className="flex flex-wrap justify-between gap-2 text-xs">
                <span className="font-semibold">
                  {b.total} deliveries · {b.status}
                </span>
                <span className="text-slate-400">{time(b.createdAt)}</span>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {b.queued} queued · {b.replayed} requeued · {b.skipped} skipped
              </p>
              <p className="mt-2 text-xs text-slate-500">
                {Object.entries(b.outcomes)
                  .map(([status, count]) => `${count} ${status}`)
                  .join(' · ') || 'Waiting for dispatcher'}
              </p>
            </button>
          ))}
        </div>
      </section>
      <Modal
        open={confirm}
        close={() => {
          if (!busy) setConfirm(false);
        }}
        title="Replay failed deliveries"
        description="This sends the selected events again. Fix the receiver first and keep event-ID deduplication enabled."
      >
        <p className="my-5 text-sm">
          Replay {selected.length} deliveries? Previous attempt history will be preserved. Disabled
          endpoints or deliveries changed since submission are skipped.
        </p>
        {error && (
          <p role="alert" className="mb-4 text-sm text-red-600">
            {error}
          </p>
        )}
        <Button disabled={busy || selected.length > 500} onClick={() => void replay()}>
          {busy ? 'Submitting…' : 'Start replay batch'}
        </Button>
        {selected.length > 500 && (
          <p className="mt-3 text-sm text-red-600">Select up to 500 deliveries per batch.</p>
        )}
      </Modal>
      <Modal
        open={!!batchId}
        close={() => setBatchId('')}
        title="Replay batch progress"
        description="Scheduling and delivery outcomes are tracked separately."
        wide
      >
        {batch.data && (
          <>
            <p className="my-5 text-sm">
              {batch.data.queued} queued · {batch.data.replayed} requeued · {batch.data.skipped}{' '}
              skipped
            </p>
            <div className="space-y-3">
              {batch.data.items.map((item) => (
                <div key={item.id} className="rounded-lg border border-slate-200 p-3">
                  <p className="mono break-all text-xs text-slate-500">{item.deliveryId}</p>
                  <div className="mt-2 flex gap-2">
                    <Badge status={item.status} />
                    {item.status === 'replayed' && <Badge status={item.deliveryStatus} />}
                  </div>
                  {item.error && <p className="mt-2 text-xs text-red-600">{item.error}</p>}
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
export function EndpointCircuit({
  endpoint,
  org,
  owner,
}: {
  endpoint: Endpoint;
  org: string;
  owner: boolean;
}) {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const history = useQuery<
    { id: string; fromState: string; toState: string; reason: string; createdAt: string }[]
  >({
    queryKey: ['circuit-history', org, endpoint.id],
    queryFn: () => api(`/endpoints/${endpoint.id}/circuit-history`, org),
    enabled: show,
    refetchInterval: 5000,
  });
  const circuit = endpoint.circuit;
  async function probe() {
    setBusy(true);
    setError('');
    try {
      await api(`/endpoints/${endpoint.id}/probe`, org, 'POST');
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold">Circuit: {circuit?.state ?? 'closed'}</span>
        <Button variant="ghost" onClick={() => setShow(!show)}>
          {show ? 'Hide circuit history' : 'Circuit history'}
        </Button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {circuit?.state === 'open'
          ? `Temporarily paused. Next probe after ${time(new Date(circuit.nextProbeAt).toISOString())}.`
          : circuit?.state === 'half-open'
            ? 'One recovery probe is in progress.'
            : circuit?.state === 'unavailable'
              ? 'Circuit state is temporarily unavailable.'
              : `${circuit?.failures ?? 0} consecutive transient failures.`}
      </p>
      {owner && endpoint.enabled && circuit?.state === 'open' && (
        <Button variant="secondary" className="mt-3" disabled={busy} onClick={() => void probe()}>
          Probe now
        </Button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
      {show && (
        <div className="mt-3 space-y-2">
          {history.error && (
            <p role="alert" className="text-xs text-red-600">
              {history.error.message}
            </p>
          )}
          {!history.data?.length && (
            <p className="text-xs text-slate-400">No circuit transitions yet.</p>
          )}
          {history.data?.map((h) => (
            <div key={h.id} className="border-t border-slate-200 pt-2 text-xs">
              <p>
                {h.fromState} → {h.toState} · {time(h.createdAt)}
              </p>
              <p className="mt-1 text-slate-500">{h.reason}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
