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

No production capacity or availability claim is made. CI is configured but has not run on GitHub; AWS resources have not been provisioned.
