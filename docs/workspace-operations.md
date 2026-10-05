# Workspace operations

Retention, delivery alerts, webhook testing, and scoped API keys share the existing tenant boundary and delivery engine. Browser requests include `X-Organization-Id`; mutations also require the configured `Origin`. API keys bind to one workspace and do not need that header. A mismatched workspace header is rejected.

## Retention

Open **Settings** to set event retention and attempt retention in days. Each policy accepts `1–3650` or `null` to keep data indefinitely. Both default to `null`. When both are enabled, attempt retention must not exceed event retention, because deleting an event also deletes its attempts.

Event cleanup requires an old event whose deliveries are all terminal (`delivered` or `failed`) and whose completion times are older than the cutoff. Events with no deliveries can expire once the event is old enough. Pending, retrying, paused, leased, or queued-for-replay deliveries are protected. Attempt-only cleanup similarly requires an old terminal delivery and old attempts; event metadata remains available.

The dispatcher selects up to five configured workspaces every ten seconds, with at least a minute between runs for each workspace. One transaction removes at most 100 events, plus up to 500 standalone attempts from 25 terminal deliveries. Cascading history for deleted events is additional to that attempt limit. Cleanup uses workspace advisory locks and delivery row locks; locked work is skipped and retried on a later sweep. The preview is an estimate at request time, so concurrent work may change actual counts.

`ExpiredEvent` stores the workspace, original event ID, idempotency key, request hash, and expiry time. It stores no payload. A matching publish retry returns `410`; a different request with that key returns `409`. The publication transaction and cleanup use the same idempotency lock, preventing a race that could recreate the event. Owners cannot clear these receipts through the API.

Replay-batch records retain the original delivery ID after history expires and report `expired`. Notification records also survive event deletion. Audit records, incidents, cleanup-run metadata, replay metadata, and minimal receipts are retained indefinitely in this version. Retention is therefore payload/history cleanup rather than a complete storage quota. Dashboard statistics and alert evaluation use the remaining attempts; keep attempts for at least the alert window when you need that history.

| Route                          | Permission     | Purpose                                            |
| ------------------------------ | -------------- | -------------------------------------------------- |
| `GET /settings/retention`      | Browser member | Policy, eligible counts, last run, ten recent runs |
| `PATCH /settings/retention`    | Browser owner  | Save both nullable retention periods               |
| `POST /settings/retention/run` | Browser owner  | Run one batch; returns counts and `busy`           |

Saving a policy enables automatic deletion immediately. Manual cleanup requires an additional dashboard confirmation. Deletion is permanent.

## Delivery alerts

Under **Alerts**, create a named rule for all endpoints or one endpoint. A workspace supports up to twenty rules. Configure:

| Setting                             | Default     | Range                          |
| ----------------------------------- | ----------- | ------------------------------ |
| Distinct delivery failure threshold | 3           | 1–1000                         |
| Rolling window in minutes           | 15          | 1–1440                         |
| Incident cooldown in minutes        | 30          | 1–1440                         |
| Notification endpoint               | In app only | Endpoint in the same workspace |

Evaluation counts distinct production deliveries with `retry` or `failed` attempts in the rolling window **after the endpoint's latest successful production attempt**. Repeated retries of one delivery count once. `429`, test traffic, and alert notification traffic do not count. This is an endpoint failure streak signal, not a failed-request percentage or an alert on every rejected payload.

A rule opens one active incident per endpoint once its threshold is reached. Row locks and a unique active key prevent duplicates across concurrent monitors. While open, its failure count updates without sending repeated notifications. Acknowledgement records that a teammate has seen it; it does not resolve or silence the rule. A production success clears earlier failures. An incident resolves when no counted failures remain, either after recovery or when its window clears. Resolution messages distinguish those cases. Disabling a rule or changing its monitored endpoint closes existing incidents without sending recovery webhooks.

Cooldown prevents a new incident for the same rule and endpoint until the configured period since the previous opening has elapsed. Opening and resolution each produce at most one logical notification event. Those events use `relay.alert.opened` and `relay.alert.resolved`, carry `source=alert`, and target only the configured notification endpoint regardless of subscriptions. The payload includes `alertId`, `endpointId`, `status`, `message`, and `failureCount`.

Notifications commit atomically with incident changes and use ordinary outbox delivery, signatures, retries, circuit breakers, and quotas. They inherit at-least-once HTTP delivery, so the notification receiver must deduplicate event IDs. A disabled or unhealthy destination appears as a failed/pending notification in the incident. Use a healthy notification endpoint independent of the receiver being monitored. Email and native Slack integrations are not included; an adapter receiver can forward notifications to those systems.

The dispatcher evaluates up to twenty due rules every ten seconds, ordered by last evaluation. This is periodic monitoring with no notification latency SLA. `relay_alert_changes_total{state="opened|resolved"}` records monitor transitions; audit entries track rule changes, acknowledgement, and incidents.

| Route                          | Permission     | Purpose                                           |
| ------------------------------ | -------------- | ------------------------------------------------- |
| `GET /alert-rules`             | Browser member | List workspace rules                              |
| `POST /alert-rules`            | Browser owner  | Create a rule                                     |
| `PATCH /alert-rules/:id`       | Browser owner  | Update or enable/disable a rule                   |
| `GET /alerts`                  | Browser member | Cursor-paginated incidents; optional `status=open | resolved` |
| `POST /alerts/:id/acknowledge` | Browser member | Idempotent acknowledgement                        |

## Webhook testing

Open **Testing**, choose an enabled endpoint, and use an order, subscription, or report template or a custom JSON object. Tests bypass subscriptions and target exactly one endpoint. They are tagged `source=test`, send `webhook-test: true`, and use the existing delivery pipeline. The header does not prevent side effects by itself: implement test handling in your receiver or select a sandbox destination.

The diagnostics view includes delivery status, HTTP attempts, durations, bounded responses/errors, signed request headers, and the exact outgoing body. Those additional request diagnostics are stored only for explicit tests. The latest twenty tests and up to one hundred attempts per selected test are available. Test events also appear in Events with a source badge, but the overview's production statistics exclude them. Infrastructure metrics and circuit state still reflect real test requests.

The signature verifier takes `endpointId`, `eventId`, `timestamp`, `signature`, and `rawBody`. It verifies HMAC-SHA256 over `eventId.timestamp.rawBody`, compares valid `v1` signatures in constant time, accepts the current secret or previous secret during its rotation grace period, and requires a timestamp within five minutes. The response separates `signatureValid` and `timestampValid`; `valid` requires both. It never returns signing secrets. Changing whitespace or any other raw-body byte invalidates a signature.

| Route                            | Permission                    | Purpose                                   |
| -------------------------------- | ----------------------------- | ----------------------------------------- |
| `GET /testing/templates`         | Member or `testing:write` key | Sample payloads                           |
| `POST /testing/events`           | Member or `testing:write` key | Targeted test; requires `Idempotency-Key` |
| `GET /testing/events`            | Member or `testing:write` key | Recent workspace tests                    |
| `GET /testing/events/:id`        | Member or `testing:write` key | Test request and receiver diagnostics     |
| `POST /testing/verify-signature` | Member or `testing:write` key | Verify exact captured request             |

## Scoped API keys

Owners create keys under **API keys** with one or more permissions:

| Scope               | Routes allowed                                                      |
| ------------------- | ------------------------------------------------------------------- |
| `events:publish`    | `POST /events`                                                      |
| `events:read`       | Events list/detail, failure inbox, production statistics            |
| `endpoints:read`    | Endpoint list and circuit history; secrets omitted                  |
| `deliveries:replay` | Single/bulk replay and replay-batch list/detail                     |
| `testing:write`     | Test templates, test publishing/diagnostics, signature verification |

An optional event-type allowlist applies only to production/test publishing. An empty list allows any event type; values are exact matches, not wildcard patterns. Read scopes can inspect all applicable workspace records. A replay key can replay existing deliveries independently of the publishing allowlist.

`POST /keys` accepts `name`, `scopes`, `eventTypes`, and nullable ISO `expiresAt`. Omitted scopes default to `events:publish`, omitted event types to an empty list, and omitted expiry to no expiry. Expiry must be in the next 365 days. The dashboard defaults new keys to ninety days and offers seven, thirty, ninety, 365 days, or no expiry. Existing keys retain their previous publishing behavior and have no expiry.

The plaintext key is shown once; only its hash is stored. The list exposes prefix, scopes, restrictions, expiry, revocation, and last usage time. Usage timestamps update at most once every five minutes and may include denied requests authenticated with an otherwise valid key. Revoked or expired keys return `401`; missing scopes or disallowed event types return `403`.

Rotation serializes concurrent requests, immediately revokes the old key, and preserves scopes, event types, and the original expiry rather than extending its lifetime. Expired keys cannot rotate; create a new key. No scope grants access to credentials, invitations, audit/SSE, retention settings, alert rules, or other administrative operations.

## Upgrade

Stop the application processes, run `pnpm db:generate` and `pnpm db:migrate`, then restart API, dispatcher, and workers together. Migration `202610050002_workspace_operations` adds the feature tables/columns, backfills terminal completion timestamps and replay IDs, and preserves existing history and publish-only key behavior. Retention stays disabled until an owner saves a policy. Full Docker mode applies migrations through its migration service when rebuilt.
