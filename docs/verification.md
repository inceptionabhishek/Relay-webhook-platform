# Verification

Verification results for v0.1, executed on 2026-10-04. Commands and tests are included in the repository so results can be reproduced.

| Check                                     | Result                                                                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                                | Passed for server, dashboard and receiver                                                                                                                                  |
| Formatting                                | Passed                                                                                                                                                                     |
| Unit security/policy tests                | 23 passed                                                                                                                                                                  |
| PostgreSQL/Redis integration tests        | 15 passed, including dispatch rollback, lost-job recovery, timeout/retry behavior, tenant isolation and credential rotation                                                |
| Frontend production build                 | Passed using webpack, on host and in Docker                                                                                                                                |
| Server production build                   | Passed in Docker                                                                                                                                                           |
| Browser workflow                          | Passed against both host development and production-built Docker stacks; desktop and 390px mobile screenshots inspected; no horizontal overflow or uncaught browser errors |
| Docker images/startup                     | Passed; migration, API, dispatcher, worker, web and monitoring containers started                                                                                          |
| Docker delivery and telemetry smoke check | Passed: seeded login, committed event, successful asynchronous delivery, Grafana/Prometheus/Jaeger readiness, three healthy scrape targets, exported worker traces         |
| Synthetic k6 ingestion smoke test         | 101 accepted requests, zero HTTP failures, 25.756958 ms p95 ingestion latency                                                                                              |

The benchmark targeted 10 requests/second for 10 seconds on a macOS ARM64 development host with Docker PostgreSQL, Redis and receiver. OpenTelemetry export was disabled for that benchmark. It measured ingestion rather than end-to-end delivery, under a small synthetic workload. [Machine-readable summary](benchmark-summary.json).

No production capacity or availability claim is made. CI is configured; remote CI status has not been verified here; AWS resources have not been provisioned.

## Delivery operations update — 2026-10-05

| Check                              | Result                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| TypeScript and formatting          | Passed                                                                                                                      |
| Unit security/policy tests         | 23 passed                                                                                                                   |
| PostgreSQL/Redis integration tests | 24 passed                                                                                                                   |
| Production builds                  | Server and Next.js webpack builds passed                                                                                    |
| Browser workflows                  | 2 passed, including failure-inbox selection, bulk replay, outcome tracking, open-circuit history, and manual recovery probe |
| Responsive layout                  | Failure inbox checked at 390px with no document-level horizontal overflow; desktop and mobile screenshots inspected         |
| Database upgrade                   | Additive delivery-operations migration applied to the existing local database; Prisma schema comparison is empty            |

Integration coverage includes atomic single-probe admission, stale circuit results, probe lease expiry, maximum delivery age while paused, 429 handling, concurrent idempotent replay requests, changed/disabled delivery skips, bounded replay chunks, API-key scope restrictions, new-tenant admission behind a large backlog, concurrent dispatcher budgets, and abandoned scheduling-slot recovery.

Browser tests ran against host application processes with Docker PostgreSQL, Redis, and the receiver. Application and infrastructure processes started for these checks were stopped afterward. New container images and a full monitoring-stack smoke run were not repeated for this update. The earlier ingestion benchmark was not rerun and does not measure the new scheduler's capacity.
