import { randomUUID } from 'node:crypto';
import { redis } from './queue';
import { config } from './config';
import { db } from './db';
import { circuitTransitions, logger } from './observability';

// All state changes use Redis TIME and an epoch. Results from an earlier circuit epoch
// cannot close a circuit opened by another request. The half-open token fences probes.
const LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local epoch = tonumber(redis.call('HGET', KEYS[1], 'epoch') or '0')
local failures = tonumber(redis.call('HGET', KEYS[1], 'failures') or '0')
local opens = tonumber(redis.call('HGET', KEYS[1], 'opens') or '0')
local nextProbe = tonumber(redis.call('HGET', KEYS[1], 'nextProbeAt') or '0')
local probeUntil = tonumber(redis.call('HGET', KEYS[1], 'probeUntil') or '0')
local token = redis.call('HGET', KEYS[1], 'token') or ''
local from = state
local reason = ''
local allowed = false
local op = ARGV[1]
local threshold = tonumber(ARGV[2])
local base = tonumber(ARGV[3])
local maximum = tonumber(ARGV[4])
local lease = tonumber(ARGV[5])
local function openCircuit(why)
  state = 'open'
  epoch = epoch + 1
  opens = opens + 1
  nextProbe = now + math.min(maximum, base * 2 ^ math.min(opens - 1, 10))
  probeUntil = 0
  token = ''
  reason = why
end
if state == 'half-open' and probeUntil <= now then
  openCircuit('Recovery probe lease expired')
end
if op == 'acquire' then
  if state == 'closed' then allowed = true
  elseif state == 'open' and nextProbe <= now then
    state = 'half-open'
    epoch = epoch + 1
    token = ARGV[6]
    probeUntil = now + lease
    allowed = true
    reason = 'Recovery probe started'
  end
elseif op == 'finish' and epoch == tonumber(ARGV[7]) and
  (state == 'closed' or (state == 'half-open' and token == ARGV[6])) then
  local outcome = ARGV[8]
  if state == 'half-open' then
    if outcome == 'delivered' or outcome == 'failed' then
      state = 'closed'
      epoch = epoch + 1
      failures = 0
      opens = 0
      nextProbe = 0
      probeUntil = 0
      token = ''
      reason = 'Recovery probe received a non-transient response'
    elseif outcome == 'cancelled' then
      state = 'open'
      epoch = epoch + 1
      nextProbe = now + 1000
      probeUntil = 0
      token = ''
      reason = 'Recovery probe deferred before HTTP'
    else openCircuit('Recovery probe failed or was rate limited') end
  elseif outcome == 'retry' then
    failures = failures + 1
    if failures >= threshold then openCircuit('Consecutive transient failure threshold reached') end
  elseif outcome == 'delivered' or outcome == 'failed' then failures = 0 end
elseif op == 'probe' then
  if state == 'open' then
    nextProbe = now
    reason = 'Immediate recovery probe requested'
  end
end
redis.call('HSET', KEYS[1], 'state', state, 'epoch', epoch, 'failures', failures,
  'opens', opens, 'nextProbeAt', nextProbe, 'probeUntil', probeUntil, 'token', token)
redis.call('PEXPIRE', KEYS[1], 604800000)
return cjson.encode({state=state, epoch=epoch, failures=failures, opens=opens,
  nextProbeAt=nextProbe, probeUntil=probeUntil, allowed=allowed,
  delay=math.max(100, (state == 'half-open' and probeUntil or nextProbe) - now),
  fromState=from, reason=reason})
`;
export type CircuitState = {
  state: 'closed' | 'open' | 'half-open' | 'unavailable';
  failures: number;
  opens: number;
  nextProbeAt: number;
  probeUntil: number;
};
export type CircuitPermit = CircuitState & {
  epoch: number;
  token: string;
  allowed: boolean;
  delay: number;
};
const key = (endpointId: string) => `circuit:{${endpointId}}`;
async function change(endpointId: string, op: string, token = '', epoch = 0, outcome = '') {
  const result = JSON.parse(
    String(
      await redis.eval(
        LUA,
        1,
        key(endpointId),
        op,
        config.CIRCUIT_FAILURE_THRESHOLD,
        config.CIRCUIT_COOLDOWN_MS,
        config.CIRCUIT_MAX_COOLDOWN_MS,
        config.DELIVERY_TIMEOUT_MS + 15000,
        token,
        epoch,
        outcome,
      ),
    ),
  );
  if (result.reason) {
    circuitTransitions.inc({ state: result.state });
    // Redis admission and PostgreSQL history cannot commit atomically. A history failure
    // must not lose the permit and strand a live probe; report it in structured logs.
    await db.circuitTransition
      .create({
        data: {
          endpointId,
          fromState: result.fromState,
          toState: result.state,
          reason: result.reason,
        },
      })
      .catch((err) =>
        logger.error({ err, endpointId, transition: result }, 'Circuit history write failed'),
      );
  }
  return result;
}
export async function acquireCircuit(endpointId: string): Promise<CircuitPermit> {
  const token = randomUUID();
  return { ...(await change(endpointId, 'acquire', token)), token };
}
export async function finishCircuit(endpointId: string, permit: CircuitPermit, outcome: string) {
  if (permit.allowed) await change(endpointId, 'finish', permit.token, permit.epoch, outcome);
}
export async function requestProbe(endpointId: string) {
  return change(endpointId, 'probe');
}
export async function circuitStates(endpointIds: string[]): Promise<Record<string, CircuitState>> {
  if (!endpointIds.length) return {};
  const pipeline = redis.pipeline();
  endpointIds.forEach((id) => pipeline.hgetall(key(id)));
  try {
    const results = await pipeline.exec();
    return Object.fromEntries(
      endpointIds.map((id, index) => {
        const [error, raw] = results?.[index] ?? [new Error('Redis unavailable'), {}];
        const value = raw as Record<string, string>;
        return [
          id,
          {
            state: (error ? 'unavailable' : (value.state ?? 'closed')) as CircuitState['state'],
            failures: Number(value.failures ?? 0),
            opens: Number(value.opens ?? 0),
            nextProbeAt: Number(value.nextProbeAt ?? 0),
            probeUntil: Number(value.probeUntil ?? 0),
          },
        ];
      }),
    );
  } catch {
    return Object.fromEntries(
      endpointIds.map((id) => [
        id,
        { state: 'unavailable', failures: 0, opens: 0, nextProbeAt: 0, probeUntil: 0 },
      ]),
    );
  }
}
