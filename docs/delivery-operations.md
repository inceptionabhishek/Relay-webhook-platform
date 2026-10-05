# Delivery operations

Circuit breakers, bulk replay, and tenant-aware scheduling extend the existing outbox and leased delivery engine. These features do not change the at-least-once delivery contract or event IDs.

## Endpoint circuit breakers

Each endpoint has a Redis circuit shared by all workers:

- **Closed:** requests are allowed. Consecutive transient errors increment the failure counter.
- **Open:** deliveries become `paused` and are durably rescheduled without sending HTTP or spending an attempt. The next eligible delivery probes after the cooldown.
- **Half-open:** one request owns a short probe lease. Other deliveries remain paused. A successful/non-transient response closes the circuit; a transient error or `429` reopens it with a longer cooldown.

Timeouts, connection errors, `408`, `425`, and `5xx` are transient failures. A permanent response such as `400` fails that delivery but resets the circuit counter: the service is reachable and rejecting the request. A `429` on a closed circuit uses the existing endpoint cooldown without tripping the breaker. Unsafe destinations do not count as receiver outages.

The default threshold is five failures and the initial cooldown is 30 seconds. Each failed recovery probe doubles the cooldown up to 15 minutes. Recovery resets the cooldown progression. Expired probe leases reopen the circuit. Redis TIME keeps admission consistent across worker clocks, and an epoch plus probe token prevents an older response from closing a newer circuit.

Deferrals for tenant quotas or endpoint cooldowns release the probe without counting an HTTP failure. Paused deliveries still expire at the existing maximum delivery age.

Endpoint cards show state, failure count, next probe time, and recent history. Owners can request **Probe now** for open circuits. This makes an existing paused delivery due immediately; it does not send a separate synthetic request. If no delivery is available, the next eligible delivery will probe. It does not bypass tenant quotas, endpoint cooldowns, or the age limit.

State is in Redis; transitions are recorded in PostgreSQL. These writes cannot commit atomically. History writes are best effort and failures appear in structured logs, while the Redis admission decision remains authoritative. Circuit hashes expire after seven days of inactivity. Loss/expiry of Redis state resets the circuit to closed; persisted delivery state and history remain.

## Failure inbox and bulk replay

The failure inbox lists deliveries with terminal `failed` status, with filters for event type and endpoint, a failed-delivery count, and cursor pagination. Inspect opens the existing payload and attempt history. Select individual deliveries or an enabled-endpoint page, then start a replay batch.

`POST /replay-batches` requires a browser session, the workspace header, an `Idempotency-Key`, and `{ "deliveryIds": ["..."] }`. It accepts 1–500 IDs and returns `202`. All IDs must belong to that workspace and be failed at acceptance. The sorted, deduplicated ID set is fingerprinted; identical retries return the same batch, and changed selections with the same key return `409`.

A batch stores the delivery generation at acceptance. The dispatcher processes up to 25 items per tick inside a PostgreSQL transaction using row locks. Each item either:

- Increments the delivery generation, resets age/failure budget, retains attempts and event ID, and creates a new outbox record.
- Is skipped with a reason because the endpoint is disabled or the delivery status/generation changed since acceptance.

A crash before commit rolls back the chunk. Committed items are not replayed again after restart. Concurrent/overlapping batches lock deliveries in a consistent order and recheck their snapshots. A single replay submitted before a batch is processed makes the corresponding batch item stale.

Recent batches and per-item details show queued, requeued, and skipped counts plus delivery outcomes. **Completed** means the batch finished scheduling; it does not mean HTTP delivery finished. Later replay generations are shown as `superseded`, rather than being attributed to the earlier batch. Replays respect circuit breakers and tenant limits. Receivers must still deduplicate by event ID.

Endpoints:

| Endpoint                             | Purpose                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `GET /failures`                      | Failed deliveries; `search`, `endpointId`, `cursor`, `limit` filters |
| `POST /replay-batches`               | Accept an idempotent batch of failed deliveries                      |
| `GET /replay-batches`                | Twenty most recent workspace batches                                 |
| `GET /replay-batches/:id`            | Batch progress, delivery outcomes, and skip reasons                  |
| `GET /endpoints/:id/circuit-history` | Recent endpoint transitions                                          |
| `POST /endpoints/:id/probe`          | Owner-only immediate probe request                                   |

API keys remain publish-only. Members can use the failure inbox and replay; owners control recovery probes. All queries enforce workspace isolation.

## Tenant-aware scheduling

The dispatcher chooses the least recently served eligible workspace, dispatches one due outbox row, updates that workspace's service timestamp, and repeats. Each turn chooses the oldest due row within that workspace. This interleaves tenants instead of filling the shared BullMQ queue from an old backlog.

Two admission budgets bound dispatched, incomplete current-generation outbox jobs:

- Three jobs per workspace by default, including queued and executing work.
- Fifty jobs across the platform by default, with at most fifty admissions per sweep.

A transaction-scoped PostgreSQL advisory lock serializes dispatch admission across replicas. It does not serialize workers or HTTP requests. `Outbox.completedAt` releases scheduling capacity when an attempt finishes or defers. Reconciliation releases abandoned capacity and recreates work after a lost job or expired delivery lease. Redis job-ID deduplication and delivery lease fencing still apply.

Work waiting for its turn remains durable in PostgreSQL. A large tenant cannot pre-fill BullMQ with its entire backlog. Existing Redis delivery rate and outbound-concurrency limits are additional execution safeguards.

This is equal-turn scheduling with bounded queue admission, not weighted service or a latency SLA. A slow tenant still occupies its allotted slots, and a new tenant may wait behind the bounded global queue. Large deployments may need partitioned schedulers instead of one advisory-lock admission loop. `relay_dispatch_delay_seconds` measures how long due work waits before dispatch; it excludes intentional retry delays until the outbox becomes due.

## Configuration and rollout

| Variable                     | Default  | Purpose                                       |
| ---------------------------- | -------- | --------------------------------------------- |
| `CIRCUIT_FAILURE_THRESHOLD`  | `5`      | Consecutive transient failures before opening |
| `CIRCUIT_COOLDOWN_MS`        | `30000`  | Initial recovery wait                         |
| `CIRCUIT_MAX_COOLDOWN_MS`    | `900000` | Maximum recovery wait                         |
| `SCHEDULER_TENANT_IN_FLIGHT` | `3`      | Queued/executing jobs per workspace           |
| `SCHEDULER_MAX_IN_FLIGHT`    | `50`     | Queued/executing jobs across workspaces       |

Existing `.env` files use these defaults when variables are absent. Keep the maximum cooldown at least as large as the initial cooldown. The admission budgets should be sized with worker concurrency and receiver latency; increasing them also increases the work ahead of a newly active tenant.

For a host development checkout, stop old application processes, run `pnpm db:generate` and `pnpm db:migrate`, then restart with `pnpm dev`. The migration adds columns and tables and preserves existing records. Upgrade API, dispatcher, and workers together so every worker understands `paused` status. Full Docker mode applies migrations through the migration service when rebuilt with `docker compose up --build -d`.
