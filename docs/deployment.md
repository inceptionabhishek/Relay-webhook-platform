# Deployment path

## Local containers

`docker compose up --build -d` runs the complete application, test receiver, PostgreSQL, persistent Redis, and monitoring stack. `docker compose logs -f api dispatcher worker` exposes operational logs. `docker compose down` stops the stack and preserves named volumes. Only explicitly remove volumes when discarding your own local data.

The server image runs the compiled NestJS API/worker/dispatcher as the `node` user. The frontend image runs Next.js standalone output. A migration service applies committed migrations before starting the API and workers.

## AWS target

A sensible first deployment uses containerized API, worker, dispatcher, and frontend on EC2; RDS PostgreSQL; and ElastiCache Redis. Put TLS termination in front of the app, and keep database/Redis/metrics access in private networking. This is a deployment design; no AWS accounts, resources, or charges are created by setup.

1. Build and push both images to your own container registry.
2. Provision a VPC/security groups, EC2 host, RDS PostgreSQL, and Redis with encrypted connections according to your budget and availability needs.
3. Supply production configuration through a secrets manager: DB/Redis URLs, `ENCRYPTION_KEY`, `NODE_ENV=production`, `WEB_ORIGIN=https://relay.example.com`, and an empty `ALLOWED_DEVELOPMENT_HOSTS`.
4. Build the web image with `NEXT_PUBLIC_API_URL=https://api.relay.example.com`. This is a public build-time value. Keep frontend/API under the same registrable site for SameSite cookie behavior.
5. Run `prisma migrate deploy` once as a release step. Do not run demo seeding in production.
6. Start API, dispatcher, worker, and web containers using your image and production environment. The development Compose file overrides several environment variables, so do not use it unchanged for this deployment.
7. Restrict `/metrics` to your scraper network and secure operational dashboards. Enable OTLP export to your collector; configure scraping for each worker replica.
8. Validate login, signature verification, event ingestion, a worker restart, retry/replay, and the monitoring views on your actual deployment.

PostgreSQL needs backups and a tested restore process. Keep the encryption key recoverable alongside secrets management; database backups alone cannot decrypt endpoint signing secrets. Configure Redis persistence/HA to your needs; the outbox reconciler can recover lost scheduling work but does not make Redis continuously available.

## Release and scaling

- CI runs formatting, types, unit/integration tests, production builds, and browser tests.
- Scale workers independently after measuring queue age and downstream latency. Each replica shares Redis tenant quotas.
- Multiple dispatchers use `SKIP LOCKED`; avoid excessive dispatcher counts that add DB contention.
- Keep graceful worker shutdown enabled so ongoing requests can finish. Forced termination is covered by lease/reconciliation recovery and receiver deduplication.
- Start with load tests on a documented environment. Choose SLOs only after measuring ingestion and end-to-end delivery independently.

Further production work includes account recovery, data retention, dashboards/alerts for saturation and failed deliveries, secrets rotation procedures, infrastructure-as-code, deployment rollback, and security review.
