'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  Code2,
  Copy,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Users,
  Webhook,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button, Modal, Badge } from '@/components/ui';
import { API, api, time, type Endpoint, type Event, type Stats } from '@/lib/api';
type View =
  'Overview' | 'Events' | 'Endpoints' | 'API keys' | 'Team' | 'Audit log' | 'Documentation';
type Me = {
  name: string;
  email: string;
  organizations: { id: string; name: string; role: string }[];
};
const nav = [
  { name: 'Overview', icon: LayoutDashboard },
  { name: 'Events', icon: Activity },
  { name: 'Endpoints', icon: Webhook },
  { name: 'API keys', icon: KeyRound },
  { name: 'Team', icon: Users },
  { name: 'Audit log', icon: ShieldCheck },
  { name: 'Documentation', icon: BookOpen },
] as const;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 2000 } } });
export default function Page() {
  return (
    <QueryClientProvider client={client}>
      <Platform />
    </QueryClientProvider>
  );
}
function Platform() {
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: () => api('/auth/me') });
  if (me.isPending)
    return (
      <div className="grid min-h-screen place-items-center text-slate-500">
        <span className="flex items-center gap-3">
          <RefreshCw className="animate-spin" size={18} />
          Connecting to Relay…
        </span>
      </div>
    );
  if (!me.data) return <Login />;
  return <Dashboard me={me.data} />;
}
function Login() {
  const qc = useQueryClient();
  const [register, setRegister] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(`/auth/${register ? 'register' : 'login'}`, undefined, 'POST', values);
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="relative flex flex-col justify-between overflow-hidden bg-[#171d29] p-10 text-white lg:p-16">
        <Logo />
        <div className="my-20 max-w-lg">
          <p className="mb-5 text-xs font-semibold tracking-[.2em] text-orange-300">
            DELIVERY YOU CAN DEPEND ON
          </p>
          <h1 className="text-5xl font-semibold leading-[1.15] tracking-tight">
            Every event.
            <br />
            Every attempt.
            <br />
            <span className="text-orange-300">Under control.</span>
          </h1>
          <p className="mt-6 max-w-sm leading-7 text-slate-400">
            Send webhooks with confidence. Follow every delivery, recover from failures, and keep
            your integrations moving.
          </p>
          <div className="mt-10 flex flex-wrap gap-4 text-xs text-slate-300">
            {['Signed payloads', 'Automatic retries', 'Full visibility'].map((t) => (
              <span key={t} className="flex items-center gap-2">
                <Check size={14} className="text-orange-300" />
                {t}
              </span>
            ))}
          </div>
        </div>
        <p className="text-xs text-slate-500">Relay / Webhook delivery platform</p>
      </section>
      <section className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <span className="inline-flex rounded-xl bg-orange-50 p-3 text-orange-600">
            <Webhook size={28} />
          </span>
          <h2 className="mt-6 text-3xl font-semibold tracking-tight">
            {register ? 'Create your workspace' : 'Welcome back'}
          </h2>
          <p className="mt-2 text-slate-500">
            {register
              ? 'Start building reliable integrations.'
              : 'Sign in to your webhook control center.'}
          </p>
          <form onSubmit={submit} className="mt-7">
            {register && (
              <>
                <label className="label" htmlFor="name">
                  Your name
                </label>
                <input id="name" name="name" className="field" required maxLength={100} />
                <label className="label" htmlFor="workspace">
                  Workspace name
                </label>
                <input id="workspace" name="workspace" className="field" required maxLength={100} />
              </>
            )}
            <label className="label" htmlFor="email">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              className="field"
              placeholder="you@company.com"
              required
            />
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={register ? 'new-password' : 'current-password'}
              className="field"
              required
              minLength={register ? 12 : 1}
            />
            {error && (
              <p role="alert" className="mt-4 text-sm text-red-600">
                {error}
              </p>
            )}
            <Button disabled={busy} className="mt-6 w-full">
              {busy ? 'Please wait…' : register ? 'Create workspace' : 'Sign in'}
              <ArrowRight size={15} />
            </Button>
          </form>
          <button
            className="mt-5 w-full text-center text-xs text-slate-500 hover:text-orange-600"
            onClick={() => {
              setRegister(!register);
              setError('');
            }}
          >
            {register ? 'Already have an account? Sign in' : 'New to Relay? Create an account'}
          </button>
        </div>
      </section>
    </main>
  );
}
function Logo() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#ef6b38] text-white">
        <Webhook size={22} />
      </span>
      <span className="text-[24px] font-bold tracking-tight">
        relay<span className="text-orange-400">.</span>
      </span>
    </div>
  );
}
function Dashboard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [org, setOrg] = useState(me.organizations[0]?.id ?? '');
  const [view, setView] = useState<View>('Overview');
  const [modal, setModal] = useState('');
  const [editingEndpoint, setEditingEndpoint] = useState<Endpoint | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [eventId, setEventId] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState('');
  const [live, setLive] = useState(false);
  const owner = me.organizations.find((o) => o.id === org)?.role === 'owner';
  const stats = useQuery<Stats>({
    queryKey: ['stats', org],
    queryFn: () => api('/stats', org),
    enabled: !!org,
    refetchInterval: 10000,
  });
  const endpoints = useQuery<Endpoint[]>({
    queryKey: ['endpoints', org],
    queryFn: () => api('/endpoints', org),
    enabled: !!org,
  });
  const events = useQuery<{ items: Event[]; nextCursor: string | null }>({
    queryKey: ['events', org, search, status, cursor],
    queryFn: () =>
      api(`/events?${new URLSearchParams({ search, status, ...(cursor ? { cursor } : {}) })}`, org),
    enabled: !!org,
    refetchInterval: live ? false : 5000,
  });
  const detail = useQuery<Event>({
    queryKey: ['event', org, eventId],
    queryFn: () => api(`/events/${eventId}`, org),
    enabled: !!eventId,
    refetchInterval: live ? false : 5000,
  });
  const keys = useQuery<any[]>({
    queryKey: ['keys', org],
    queryFn: () => api('/keys', org),
    enabled: view === 'API keys' && owner,
  });
  const members = useQuery<any[]>({
    queryKey: ['members', org],
    queryFn: () => api('/members', org),
    enabled: view === 'Team',
  });
  const audits = useQuery<any[]>({
    queryKey: ['audit', org],
    queryFn: () => api('/audit', org),
    enabled: view === 'Audit log',
  });
  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get('invite');
    if (invite) {
      setModal('accept');
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function connect() {
      try {
        const response = await fetch(`${API}/stream`, {
          credentials: 'include',
          headers: { 'X-Organization-Id': org },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error('Stream unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        setLive(true);
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split('\n\n');
          buffer = messages.pop() ?? '';
          for (const message of messages) {
            const line = message.split('\n').find((l) => l.startsWith('data:'));
            if (line) {
              qc.setQueryData(['stats', org], JSON.parse(line.slice(5)));
              void qc.invalidateQueries({ queryKey: ['events', org] });
              if (eventId) void qc.invalidateQueries({ queryKey: ['event', org, eventId] });
            }
          }
        }
      } catch {
        /* Polling continues if the stream is interrupted. */
      }
      setLive(false);
      if (!controller.signal.aborted) timer = setTimeout(connect, 3000);
    }
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [org, eventId, qc]);
  async function action(fn: () => Promise<any>) {
    setError('');
    setBusy(true);
    try {
      const result = await fn();
      await qc.invalidateQueries();
      return result;
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    const result = await action(async () => {
      if (modal === 'endpoint' || modal === 'edit-endpoint')
        return api(
          modal === 'edit-endpoint' ? `/endpoints/${editingEndpoint?.id}` : '/endpoints',
          org,
          modal === 'edit-endpoint' ? 'PATCH' : 'POST',
          {
            name: data.name,
            url: data.url,
            eventTypes: String(data.eventTypes ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          },
        );
      if (modal === 'event') {
        let payload;
        try {
          payload = JSON.parse(String(data.payload));
        } catch {
          throw new Error('Payload must be valid JSON');
        }
        return api(
          '/events',
          org,
          'POST',
          { type: data.type, payload },
          { 'Idempotency-Key': String(data.idempotencyKey) },
        );
      }
      if (modal === 'key') return api('/keys', org, 'POST', { name: data.name });
      if (modal === 'workspace')
        return api('/auth/workspaces', undefined, 'POST', { name: data.name });
      if (modal === 'invite') return api('/invitations', org, 'POST', { email: data.email });
      if (modal === 'accept')
        return api('/auth/invitations/accept', undefined, 'POST', { token: data.token });
    });
    if (result) {
      if (result.secret)
        setSecret({
          title: modal === 'endpoint' ? 'Endpoint signing secret' : 'API key',
          value: result.secret,
        });
      if (result.url && modal === 'invite')
        setSecret({ title: 'Invitation link', value: result.url });
      if (modal === 'event') {
        setEventId(result.id);
        setView('Events');
      }
      if (modal === 'accept') {
        setOrg(result.organizationId);
        window.history.replaceState({}, '', '/');
      }
      if (modal === 'workspace') setOrg(result.id);
      setModal('');
    }
  }
  const counts = stats.data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const terminal = (counts.delivered ?? 0) + (counts.failed ?? 0);
  const success = terminal ? (((counts.delivered ?? 0) / terminal) * 100).toFixed(1) : '—';
  const pending = total - terminal;
  const queryError =
    stats.error ??
    events.error ??
    endpoints.error ??
    detail.error ??
    keys.error ??
    members.error ??
    audits.error;
  const rows = events.data?.items ?? [];
  function eventTable(items: Event[]) {
    return (
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Delivery status</th>
              <th>Endpoints</th>
              <th>Received</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="cursor-pointer" onClick={() => setEventId(e.id)}>
                <td>
                  <button
                    className="text-left font-medium text-slate-800"
                    onClick={() => setEventId(e.id)}
                  >
                    {e.type}
                    <span className="mono mt-1 block text-[10px] text-slate-400">
                      {e.id.slice(0, 18)}…
                    </span>
                  </button>
                </td>
                <td>
                  {e.deliveries.length ? (
                    <div className="flex flex-wrap gap-1">
                      {[...new Set(e.deliveries.map((d) => d.status))].map((s) => (
                        <Badge key={s} status={s} />
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">No matching endpoints</span>
                  )}
                </td>
                <td className="text-slate-500">{e.deliveries.length}</td>
                <td className="whitespace-nowrap text-xs text-slate-500">{time(e.createdAt)}</td>
                <td>
                  <ArrowUpRight size={15} className="text-slate-400" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <Empty
            icon={<Activity size={25} />}
            title={events.isPending ? 'Loading events…' : 'No events yet'}
            text="Add an endpoint, then publish your first event to follow its delivery."
          />
        )}
      </div>
    );
  }
  return (
    <div className="min-h-screen lg:flex">
      <aside className="flex shrink-0 flex-col bg-[#171d29] px-5 py-7 text-white lg:fixed lg:inset-y-0 lg:w-[230px]">
        <div className="px-3">
          <Logo />
        </div>
        <p className="mb-3 mt-10 px-3 text-[10px] tracking-[.17em] text-slate-500">WORKSPACE</p>
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {nav.map((n) => (
            <button
              key={n.name}
              onClick={() => {
                setView(n.name);
                setError('');
              }}
              className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-3 text-xs transition-colors ${view === n.name ? 'bg-white/8 text-white' : 'text-slate-400 hover:bg-white/4 hover:text-white'}`}
            >
              <n.icon size={17} className={view === n.name ? 'text-orange-400' : ''} />
              {n.name}
              {n.name === 'Events' && pending > 0 && (
                <span className="ml-auto rounded bg-white/10 px-1.5 text-[10px]">{pending}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto hidden pt-8 lg:block">
          <div className="rounded-xl border border-slate-700/60 p-4">
            <span className="flex items-center gap-2 text-xs">
              <ShieldCheck size={15} className="text-orange-300" />
              Built for reliability
            </span>
            <p className="mt-2 text-[11px] leading-5 text-slate-500">
              Signed requests. Durable events. A record of every attempt.
            </p>
          </div>
          <button
            onClick={() =>
              void action(async () => {
                await api('/auth/logout', undefined, 'POST');
                qc.clear();
              })
            }
            className="mt-5 flex w-full items-center gap-3 px-2 text-xs text-slate-400"
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-slate-700 font-semibold text-white">
              {me.name.slice(0, 1)}
            </span>
            <span className="truncate text-left">
              {me.name}
              <span className="mt-1 block text-[10px] text-slate-500">
                {owner ? 'Workspace owner' : 'Workspace member'}
              </span>
            </span>
            <LogOut size={14} className="ml-auto" />
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 lg:ml-[230px]">
        <header className="flex h-[74px] items-center justify-between border-b border-slate-200 bg-white px-5 lg:px-9">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-violet-50 text-xs font-bold text-violet-600">
              {me.organizations.find((o) => o.id === org)?.name.slice(0, 1)}
            </span>
            <select
              aria-label="Workspace"
              className="max-w-[180px] bg-transparent text-xs font-semibold outline-none"
              value={org}
              onChange={(e) => {
                setOrg(e.target.value);
                setEventId('');
                setCursor('');
              }}
            >
              {me.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => setModal('workspace')}
              title="Create workspace"
              aria-label="Create workspace"
              className="ml-2 text-slate-400"
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="flex items-center gap-5 text-xs text-slate-500">
            <span className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-amber-400'}`}
              />
              {live ? 'Live updates' : 'Reconnecting'}
            </span>
            <a
              href={`${API}/docs`}
              target="_blank"
              rel="noreferrer"
              className="hidden items-center gap-1 sm:flex"
            >
              API docs
              <ExternalLink size={12} />
            </a>
          </div>
        </header>
        <div className="mx-auto max-w-[1450px] px-5 py-8 lg:px-9">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-[10px] font-semibold tracking-[.15em] text-slate-400">
                WEBHOOK CONTROL CENTER
              </p>
              <h1 className="text-[28px] font-semibold tracking-tight">
                {view === 'Overview' ? 'Delivery overview' : view}
              </h1>
              <p className="mt-2 text-xs text-slate-500">
                {
                  {
                    Overview: 'A clear view of your events and integration health.',
                    Events: 'Inspect payloads, trace attempts, and replay deliveries.',
                    Endpoints: 'Connect your services and control where events go.',
                    'API keys': 'Manage credentials for publishing events to your workspace.',
                    Team: 'Collaborate with your team across one workspace.',
                    'Audit log': 'A history of changes and actions in this workspace.',
                    Documentation: 'Everything you need to connect your first integration.',
                  }[view]
                }
              </p>
            </div>
            <Button
              onClick={() =>
                setModal(
                  view === 'Endpoints'
                    ? 'endpoint'
                    : view === 'API keys'
                      ? 'key'
                      : view === 'Team'
                        ? 'invite'
                        : 'event',
                )
              }
              disabled={(['Endpoints', 'API keys', 'Team'] as string[]).includes(view) && !owner}
            >
              {view === 'Endpoints' ? <Plus size={15} /> : <Send size={14} />}
              {view === 'Endpoints'
                ? 'Add endpoint'
                : view === 'API keys'
                  ? 'Create API key'
                  : view === 'Team'
                    ? 'Invite member'
                    : 'Publish event'}
            </Button>
          </div>
          {(error || queryError) && (
            <div
              role="alert"
              className="mb-5 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700"
            >
              {error || (queryError as Error).message}
            </div>
          )}
          {view === 'Overview' && (
            <div className="enter">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  {
                    label: 'Events received',
                    value: stats.data?.events ?? 0,
                    detail: 'Last 24 hours',
                    icon: Activity,
                    color: 'text-violet-500 bg-violet-50',
                  },
                  {
                    label: 'Successful deliveries',
                    value: success === '—' ? '—' : `${success}%`,
                    detail: 'All terminal deliveries',
                    icon: ShieldCheck,
                    color: 'text-emerald-600 bg-emerald-50',
                  },
                  {
                    label: 'Delivery latency · p95',
                    value: `${stats.data?.p95 ?? 0} ms`,
                    detail: 'HTTP attempts · last 24 hours',
                    icon: Zap,
                    color: 'text-orange-500 bg-orange-50',
                  },
                  {
                    label: 'Active endpoints',
                    value: stats.data?.endpoints ?? 0,
                    detail: `${pending} deliveries in progress`,
                    icon: Webhook,
                    color: 'text-blue-500 bg-blue-50',
                  },
                ].map((card) => (
                  <div key={card.label} className="card p-5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-slate-500">{card.label}</p>
                      <span className={`rounded-lg p-2 ${card.color}`}>
                        <card.icon size={16} />
                      </span>
                    </div>
                    <p className="mt-3 text-[30px] font-semibold tracking-tight">{card.value}</p>
                    <p className="mt-2 text-[10px] text-slate-400">{card.detail}</p>
                  </div>
                ))}
              </div>
              <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_300px]">
                <section className="card p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="font-semibold">Delivery activity</h2>
                      <p className="mt-1 text-[11px] text-slate-400">
                        Outbound HTTP attempts over the last 24 hours
                      </p>
                    </div>
                    <span className="rounded-md border border-slate-200 px-2 py-1 text-[10px] text-slate-500">
                      Last 24 hours
                    </span>
                  </div>
                  <div className="mt-7 h-[225px]">
                    {stats.data?.hourly.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={stats.data.hourly}>
                          <defs>
                            <linearGradient id="delivered" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#6b9e88" stopOpacity={0.2} />
                              <stop offset="100%" stopColor="#6b9e88" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f4" />
                          <XAxis
                            dataKey="hour"
                            tickFormatter={(s) =>
                              new Date(s).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            }
                            tick={{ fontSize: 10, fill: '#94a3b8' }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <YAxis
                            allowDecimals={false}
                            tick={{ fontSize: 10, fill: '#94a3b8' }}
                            tickLine={false}
                            axisLine={false}
                            width={28}
                          />
                          <Tooltip labelFormatter={(v) => time(String(v))} />
                          <Area
                            type="monotone"
                            dataKey="delivered"
                            stroke="#4b9776"
                            fill="url(#delivered)"
                            strokeWidth={2}
                          />
                          <Area
                            type="monotone"
                            dataKey="failed"
                            name="Non-success attempts"
                            stroke="#ef8a6d"
                            fill="transparent"
                            strokeWidth={2}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <Empty
                        icon={<Radio size={24} />}
                        title="Ready for your first delivery"
                        text="Your activity chart will appear when events start flowing."
                      />
                    )}
                  </div>
                  <div className="mt-2 flex justify-center gap-5 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      Delivered
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-orange-400" />
                      Non-success attempts
                    </span>
                  </div>
                </section>
                <section className="card p-5">
                  <h2 className="font-semibold">Delivery health</h2>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Current state across your workspace
                  </p>
                  <div className="mt-7 space-y-5">
                    {['delivered', 'retrying', 'throttled', 'failed'].map((s) => (
                      <div key={s}>
                        <div className="mb-2 flex justify-between">
                          <Badge status={s} />
                          <span className="text-xs font-semibold">{counts[s] ?? 0}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div
                            style={{ width: `${total ? ((counts[s] ?? 0) / total) * 100 : 0}%` }}
                            className={`h-full rounded-full ${s === 'delivered' ? 'bg-emerald-400' : s === 'failed' ? 'bg-red-400' : s === 'throttled' ? 'bg-violet-400' : 'bg-amber-400'}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-6 border-t border-slate-100 pt-4 text-[11px] leading-5 text-slate-400">
                    Failed deliveries stay available for inspection and manual replay.
                  </p>
                </section>
              </div>
              <section className="card mt-5 overflow-hidden">
                <div className="flex items-center justify-between p-5">
                  <h2 className="font-semibold">Recent events</h2>
                  <button
                    onClick={() => setView('Events')}
                    className="flex items-center gap-1 text-[11px] text-slate-500"
                  >
                    View all events
                    <ArrowRight size={13} />
                  </button>
                </div>
                {eventTable(rows.slice(0, 5))}
              </section>
            </div>
          )}
          {view === 'Events' && (
            <section className="card enter overflow-hidden">
              <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4">
                <div className="relative flex-1">
                  <Search size={15} className="absolute left-3 top-3 text-slate-400" />
                  <input
                    aria-label="Search event types"
                    className="field pl-9 text-xs"
                    placeholder="Search by event type…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setCursor('');
                    }}
                  />
                </div>
                <select
                  aria-label="Filter by delivery status"
                  className="field w-auto text-xs"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setCursor('');
                  }}
                >
                  <option value="">All statuses</option>
                  {['delivered', 'failed', 'retrying', 'throttled', 'pending', 'processing'].map(
                    (s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ),
                  )}
                </select>
              </div>
              {eventTable(rows)}
              <div className="flex justify-end gap-2 border-t border-slate-100 p-3">
                {cursor && (
                  <Button variant="secondary" onClick={() => setCursor('')}>
                    First page
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={!events.data?.nextCursor}
                  onClick={() => setCursor(events.data?.nextCursor ?? '')}
                >
                  Next page
                  <ArrowRight size={12} />
                </Button>
              </div>
            </section>
          )}
          {view === 'Endpoints' && (
            <div className="grid gap-4 lg:grid-cols-2">
              {endpoints.data?.map((endpoint) => (
                <section className="card p-5" key={endpoint.id}>
                  <div className="flex items-start justify-between">
                    <span className="rounded-xl bg-slate-50 p-3 text-slate-500">
                      <Webhook size={20} />
                    </span>
                    <Badge status={endpoint.enabled ? 'enabled' : 'disabled'} />
                  </div>
                  <h2 className="mt-4 font-semibold">{endpoint.name}</h2>
                  <p className="mono mt-2 break-all text-slate-400">{endpoint.url}</p>
                  <p className="mt-4 text-xs text-slate-500">
                    Subscribed to:{' '}
                    {endpoint.eventTypes.length
                      ? endpoint.eventTypes.join(', ')
                      : 'All event types'}
                  </p>
                  <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                    {owner && (
                      <>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setEditingEndpoint(endpoint);
                            setModal('edit-endpoint');
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            void action(() =>
                              api(`/endpoints/${endpoint.id}`, org, 'PATCH', {
                                enabled: !endpoint.enabled,
                              }),
                            )
                          }
                        >
                          {endpoint.enabled ? 'Disable endpoint' : 'Enable endpoint'}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              const result = await api(
                                `/endpoints/${endpoint.id}/rotate-secret`,
                                org,
                                'POST',
                              );
                              setSecret({
                                title: 'New signing secret · old secret valid for 24 hours',
                                value: result.secret,
                              });
                            })
                          }
                        >
                          <RefreshCw size={13} />
                          Rotate secret
                        </Button>
                      </>
                    )}
                  </div>
                </section>
              ))}
              {!endpoints.data?.length && (
                <section className="card col-span-full">
                  <Empty
                    icon={<Webhook size={25} />}
                    title="Connect your first endpoint"
                    text="Add a service URL to start receiving signed webhook events."
                  />
                </section>
              )}
            </div>
          )}
          {view === 'API keys' && (
            <section className="card overflow-hidden">
              {!owner ? (
                <Empty
                  icon={<KeyRound size={25} />}
                  title="Owner access required"
                  text="Ask your workspace owner to manage API credentials."
                />
              ) : (
                <>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Key prefix</th>
                        <th>Created</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.data?.map((key) => (
                        <tr key={key.id}>
                          <td>{key.name}</td>
                          <td className="mono">{key.prefix}…</td>
                          <td>{time(key.createdAt)}</td>
                          <td>{key.revokedAt ? 'Revoked' : 'Active · publish only'}</td>
                          <td className="space-x-2">
                            {!key.revokedAt && (
                              <>
                                <Button
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    void action(async () => {
                                      const result = await api(
                                        `/keys/${key.id}/rotate`,
                                        org,
                                        'POST',
                                      );
                                      setSecret({
                                        title: 'Replacement API key',
                                        value: result.secret,
                                      });
                                    })
                                  }
                                >
                                  Rotate
                                </Button>
                                <Button
                                  variant="danger"
                                  disabled={busy}
                                  onClick={() =>
                                    void action(() => api(`/keys/${key.id}`, org, 'DELETE'))
                                  }
                                >
                                  Revoke
                                </Button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!keys.data?.length && (
                    <Empty
                      icon={<KeyRound size={25} />}
                      title="Create an API key"
                      text="Use a workspace key to publish events from your application."
                    />
                  )}
                </>
              )}
            </section>
          )}
          {view === 'Team' && (
            <section className="card overflow-hidden">
              <table className="table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Email</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {members.data?.map((m) => (
                    <tr key={m.user.id}>
                      <td>{m.user.name}</td>
                      <td>{m.user.email}</td>
                      <td className="capitalize">{m.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-slate-100 p-5 text-xs leading-6 text-slate-500">
                Owners manage endpoints and credentials. Members can inspect events, publish events,
                and replay deliveries.
                <button className="ml-3 text-orange-600" onClick={() => setModal('accept')}>
                  Accept an invitation
                </button>
              </div>
            </section>
          )}
          {view === 'Audit log' && (
            <section className="card overflow-hidden">
              <table className="table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Resource</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {audits.data?.map((a) => (
                    <tr key={a.id}>
                      <td className="font-medium">{a.action}</td>
                      <td className="mono text-slate-500">{a.actor.slice(0, 16)}…</td>
                      <td className="mono text-slate-500">{a.resourceId?.slice(0, 16) ?? '—'}</td>
                      <td>{time(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!audits.data?.length && (
                <Empty
                  icon={<ShieldCheck size={25} />}
                  title="Your workspace history"
                  text="Actions will appear here as you configure integrations."
                />
              )}
            </section>
          )}
          {view === 'Documentation' && (
            <section className="card max-w-4xl p-7">
              <h2 className="text-xl font-semibold">Publish your first event</h2>
              <p className="mt-3 leading-6 text-slate-500">
                Create an endpoint and API key, then send a request with a unique idempotency key.
                Repeating the same request with the same key returns the original event.
              </p>
              <Code
                text={`curl ${API}/events \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Idempotency-Key: order-123-created' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"type":"order.created","payload":{"orderId":"123","amount":2499}}'`}
              />
              <h2 className="mt-7 font-semibold">Verify the signature</h2>
              <p className="mt-2 leading-6 text-slate-500">
                Verify HMAC-SHA256 over <code className="mono">eventId.timestamp.rawBody</code>{' '}
                using your signing secret. Compare signatures in constant time and reject timestamps
                older than five minutes. During secret rotation, the header includes signatures for
                both secrets for 24 hours.
              </p>
              <Code
                text={`const expected = createHmac('sha256', signingSecret)\n  .update(webhookId + '.' + timestamp + '.' + rawBody)\n  .digest('hex');\n// Compare against each v1= value in webhook-signature.\n// Use timingSafeEqual after checking equal byte lengths.`}
              />
              <h2 className="mt-7 font-semibold">Design for duplicate deliveries</h2>
              <p className="mt-2 leading-6 text-slate-500">
                Delivery uses retries and may arrive more than once. Deduplicate using{' '}
                <code className="mono">webhook-id</code>. Return a 2xx response after safely
                recording the event. Responses of 429 defer delivery without consuming its failure
                budget; temporary failures retry with backoff. Redirects are rejected.
              </p>
              <a
                href={`${API}/docs`}
                target="_blank"
                rel="noreferrer"
                className="mt-5 inline-flex items-center gap-2 text-orange-600"
              >
                Explore the API reference
                <ExternalLink size={14} />
              </a>
            </section>
          )}
          <footer className="mt-8 flex justify-between text-[10px] text-slate-400">
            <span>Relay · Every delivery accounted for</span>
            <span>Workspace data · {new Date().getFullYear()}</span>
          </footer>
        </div>
      </main>
      <Modal
        open={!!modal}
        close={() => {
          setModal('');
          setError('');
        }}
        title={
          {
            endpoint: 'Add an endpoint',
            'edit-endpoint': 'Edit endpoint',
            event: 'Publish an event',
            key: 'Create an API key',
            workspace: 'Create a workspace',
            invite: 'Invite a teammate',
            accept: 'Accept invitation',
          }[modal] ?? ''
        }
        description={
          modal === 'event'
            ? 'Your event is stored before delivery begins.'
            : modal === 'invite'
              ? 'Copy the invitation link and share it with your teammate.'
              : undefined
        }
      >
        <form onSubmit={submit} className="mt-5">
          {['endpoint', 'edit-endpoint', 'key', 'workspace'].includes(modal) && (
            <>
              <label className="label" htmlFor="form-name">
                Name
              </label>
              <input
                id="form-name"
                name="name"
                defaultValue={modal === 'edit-endpoint' ? editingEndpoint?.name : undefined}
                className="field"
                required
                maxLength={100}
                placeholder={modal === 'endpoint' ? 'Order service' : 'Production integration'}
              />
            </>
          )}
          {(modal === 'endpoint' || modal === 'edit-endpoint') && (
            <>
              <label className="label" htmlFor="form-url">
                Endpoint URL
              </label>
              <input
                id="form-url"
                name="url"
                defaultValue={modal === 'edit-endpoint' ? editingEndpoint?.url : undefined}
                type="url"
                className="field"
                required
                placeholder="https://your-service.com/webhooks"
              />
              <label className="label" htmlFor="event-types">
                Event types (comma separated)
              </label>
              <input
                id="event-types"
                name="eventTypes"
                defaultValue={
                  modal === 'edit-endpoint' ? editingEndpoint?.eventTypes.join(', ') : undefined
                }
                className="field"
                placeholder="Leave empty to receive all events"
              />
            </>
          )}
          {modal === 'event' && (
            <>
              <label className="label" htmlFor="event-type">
                Event type
              </label>
              <input
                id="event-type"
                name="type"
                className="field"
                defaultValue="order.created"
                required
              />
              <label className="label" htmlFor="idempotency-key">
                Idempotency key
              </label>
              <input
                id="idempotency-key"
                name="idempotencyKey"
                className="field mono"
                defaultValue={`evt-${Date.now()}`}
                required
              />
              <label className="label" htmlFor="payload">
                Payload (JSON object)
              </label>
              <textarea
                id="payload"
                name="payload"
                className="field mono min-h-36"
                defaultValue={
                  '{\n  "orderId": "ord_123",\n  "amount": 2499,\n  "currency": "INR"\n}'
                }
                required
              />
            </>
          )}
          {modal === 'invite' && (
            <>
              <label className="label" htmlFor="invite-email">
                Teammate email
              </label>
              <input id="invite-email" name="email" type="email" className="field" required />
            </>
          )}
          {modal === 'accept' && (
            <>
              <label className="label" htmlFor="invite-token">
                Invitation token
              </label>
              <input
                id="invite-token"
                name="token"
                className="field mono"
                defaultValue={
                  typeof window !== 'undefined'
                    ? (new URLSearchParams(window.location.search).get('invite') ?? '')
                    : ''
                }
                required
              />
            </>
          )}
          {error && (
            <p role="alert" className="mt-4 text-xs text-red-600">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setModal('')}>
              Cancel
            </Button>
            <Button disabled={busy}>
              {busy ? 'Saving…' : modal === 'event' ? 'Publish event' : 'Continue'}
              <ArrowRight size={13} />
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={!!secret}
        close={() => setSecret(null)}
        title={secret?.title ?? ''}
        description={
          secret?.title === 'Invitation link'
            ? 'Share this link with the invited email address. It expires in seven days.'
            : 'Copy and store this credential securely. It will not be shown again.'
        }
      >
        <div className="mt-5 break-all rounded-lg border border-slate-200 bg-slate-50 p-4 mono">
          {secret?.value}
        </div>
        <Button
          className="mt-5"
          onClick={() => {
            void navigator.clipboard
              .writeText(secret?.value ?? '')
              .catch(() => setError('Select and copy the credential manually.'));
          }}
        >
          <Copy size={14} />
          Copy
        </Button>
      </Modal>
      <Modal
        open={!!eventId}
        close={() => setEventId('')}
        title={detail.data?.type ?? 'Event details'}
        description={eventId}
        wide
      >
        {detail.isPending ? (
          <p className="mt-6 text-slate-500">Loading delivery history…</p>
        ) : (
          detail.data && (
            <>
              <div className="mt-5 flex justify-between text-xs text-slate-500">
                <span>Received {time(detail.data.createdAt)}</span>
                <span>{detail.data.deliveries.length} endpoint(s)</span>
              </div>
              <Code text={JSON.stringify(detail.data.payload, null, 2)} />
              {detail.data.deliveries.map((d) => (
                <section key={d.id} className="mt-5 rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold">{d.endpoint.name}</h3>
                      <p className="mono mt-1 break-all text-slate-400">{d.endpoint.url}</p>
                    </div>
                    <Badge status={d.status} />
                  </div>
                  <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {d.attemptCount} HTTP attempts · replay generation {d.generation}
                    </span>
                    <Button
                      variant="secondary"
                      disabled={busy || !['delivered', 'failed'].includes(d.status)}
                      onClick={() =>
                        void action(() => api(`/deliveries/${d.id}/replay`, org, 'POST'))
                      }
                    >
                      <RefreshCw size={12} />
                      Replay
                    </Button>
                  </div>
                  {d.lastError && (
                    <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
                      {d.lastError}
                    </p>
                  )}
                  <div className="mt-4 space-y-3">
                    {d.attempts?.map((a) => (
                      <div key={a.id} className="border-t border-slate-100 pt-3">
                        <div className="flex flex-wrap justify-between gap-2 text-xs">
                          <span>
                            Attempt #{a.number} ·{' '}
                            {a.statusCode ? `HTTP ${a.statusCode}` : 'Network / policy error'}
                          </span>
                          <span className="text-slate-400">
                            {a.durationMs} ms · {time(a.createdAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500">{a.error ?? a.outcome}</p>
                        {a.responseSnippet && (
                          <details className="mt-2 text-xs text-slate-500">
                            <summary className="cursor-pointer">Response preview</summary>
                            <pre className="mono mt-2 overflow-auto rounded bg-slate-50 p-3 whitespace-pre-wrap">
                              {a.responseSnippet}
                            </pre>
                          </details>
                        )}
                      </div>
                    ))}
                    {!d.attempts?.length && (
                      <p className="text-xs text-slate-400">Waiting for the first attempt.</p>
                    )}
                  </div>
                </section>
              ))}
            </>
          )
        )}
      </Modal>
    </div>
  );
}
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex h-full min-h-[170px] flex-col items-center justify-center px-5 py-8 text-center">
      <span className="mb-3 text-slate-300">{icon}</span>
      <p className="text-sm font-medium text-slate-600">{title}</p>
      <p className="mt-2 max-w-sm text-xs leading-5 text-slate-400">{text}</p>
    </div>
  );
}
function Code({ text }: { text: string }) {
  return (
    <pre className="mono mt-5 overflow-x-auto rounded-xl bg-[#1e2533] p-5 text-xs leading-6 text-slate-300">
      {text}
    </pre>
  );
}
