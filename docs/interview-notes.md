# Interview and resume notes

## Explain the problem

Third-party endpoints fail, time out, return rate limits, and sometimes process a request without acknowledging it. A synchronous HTTP call ties acceptance to downstream availability and offers little recovery visibility. Relay separates durable acceptance, scheduling, delivery, and inspection.

## Decisions worth discussing

1. Why PostgreSQL is authoritative and Redis is used for scheduling/quotas.
2. Why writing an event and an outbox record in one transaction avoids a database/queue dual-write gap.
3. How a unique constraint handles concurrent idempotency keys.
4. How leases, tokens, generations, and receiver deduplication address different kinds of duplicate work.
5. Why a 429 should defer an attempt without spending the same budget as repeated 5xx errors.
6. How DNS validation, address pinning, redirect rejection, and HTTPS protect webhook egress.
7. How oldest-served tenant turns and bounded queue admission reduce backlog interference, and why they do not guarantee weighted service or latency.
8. How to separate API acceptance latency, queue delay, HTTP latency, and end-to-end delivery latency.
9. What happens when Redis, PostgreSQL, a worker, or the receiver fails at each stage.
10. How shared circuit epochs and one half-open probe prevent stale responses from reopening traffic.
11. Why bulk replay snapshots generations, rechecks delivery state, and separates scheduling completion from HTTP completion.
12. Which bottleneck you would address next based on measurements rather than adding infrastructure speculatively.

## Demo sequence

Show successful delivery, duplicate ingestion, a flaky receiver recovering, an endpoint throttling, a permanent failure, replay history, API-key revocation, and isolation between two workspaces. Show an open endpoint circuit, fix its receiver, and request a recovery probe. Use the failure inbox to replay a batch and inspect its skip reasons and delivery outcomes. Show a trace and a dashboard while explaining the code path.

## Resume wording

Use only behavior you understand and measurements you reproduce:

> Built a multi-tenant webhook delivery platform with Next.js, NestJS, PostgreSQL, Redis, and BullMQ; implemented transactional outbox processing, signed requests, bounded retries, tenant-aware scheduling, endpoint circuit breakers, and durable bulk replay with delivery history.

After benchmarking on a documented environment:

> Measured [X] accepted events/second at [Y] ms p95 ingestion latency on [environment]; verified recovery from [tested failure] using [verification method].

The short local benchmark is a smoke test, not proof of production capacity. Avoid claims of exactly-once delivery, millions of users, strict tenant fairness, or uptime without evidence.
