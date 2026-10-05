ALTER TABLE "Organization" ADD COLUMN "eventRetentionDays" INTEGER, ADD COLUMN "attemptRetentionDays" INTEGER, ADD COLUMN "retentionLastRunAt" TIMESTAMP(3);
ALTER TABLE "ApiKey" ADD COLUMN scopes TEXT[] NOT NULL DEFAULT ARRAY['events:publish']::TEXT[], ADD COLUMN "eventTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], ADD COLUMN "expiresAt" TIMESTAMP(3), ADD COLUMN "lastUsedAt" TIMESTAMP(3);
ALTER TABLE "Event" ADD COLUMN source TEXT NOT NULL DEFAULT 'production';
ALTER TABLE "Delivery" ADD COLUMN "finishedAt" TIMESTAMP(3);
UPDATE "Delivery" d SET "finishedAt" = COALESCE(d."deliveredAt", (SELECT max(a."createdAt") FROM "Attempt" a WHERE a."deliveryId" = d.id), d."createdAt") WHERE d.status IN ('delivered','failed');
ALTER TABLE "Attempt" ADD COLUMN "requestHeaders" JSONB, ADD COLUMN "requestBody" TEXT;
ALTER TABLE "ReplayItem" ADD COLUMN "originalDeliveryId" TEXT;
UPDATE "ReplayItem" SET "originalDeliveryId" = "deliveryId";
ALTER TABLE "ReplayItem" ALTER COLUMN "originalDeliveryId" SET NOT NULL, ALTER COLUMN "deliveryId" DROP NOT NULL;
ALTER TABLE "ReplayItem" DROP CONSTRAINT "ReplayItem_deliveryId_fkey";
ALTER TABLE "ReplayItem" ADD CONSTRAINT "ReplayItem_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"(id) ON DELETE SET NULL ON UPDATE CASCADE;
DROP INDEX "ReplayItem_batchId_deliveryId_key";
CREATE UNIQUE INDEX "ReplayItem_batchId_originalDeliveryId_key" ON "ReplayItem"("batchId", "originalDeliveryId");
CREATE TABLE "ExpiredEvent" (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "eventId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "expiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ExpiredEvent_eventId_key" ON "ExpiredEvent"("eventId");
CREATE UNIQUE INDEX "ExpiredEvent_organizationId_idempotencyKey_key" ON "ExpiredEvent"("organizationId", "idempotencyKey");
CREATE TABLE "RetentionRun" (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "eventsDeleted" INTEGER NOT NULL, "attemptsDeleted" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RetentionRun_organizationId_createdAt_idx" ON "RetentionRun"("organizationId", "createdAt");
CREATE TABLE "AlertRule" (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
 "endpointId" TEXT REFERENCES "Endpoint"(id) ON DELETE SET NULL ON UPDATE CASCADE,
 "notificationEndpointId" TEXT REFERENCES "Endpoint"(id) ON DELETE SET NULL ON UPDATE CASCADE,
 threshold INTEGER NOT NULL DEFAULT 3, "windowMinutes" INTEGER NOT NULL DEFAULT 15, "cooldownMinutes" INTEGER NOT NULL DEFAULT 30,
 "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AlertRule_enabled_lastEvaluatedAt_idx" ON "AlertRule"(enabled, "lastEvaluatedAt");
CREATE TABLE "Alert" (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "ruleId" TEXT NOT NULL REFERENCES "AlertRule"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "endpointId" TEXT NOT NULL REFERENCES "Endpoint"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "activeKey" TEXT, message TEXT NOT NULL, "failureCount" INTEGER NOT NULL,
 "acknowledgedAt" TIMESTAMP(3), "resolvedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Alert_activeKey_key" ON "Alert"("activeKey");
CREATE INDEX "Alert_organizationId_createdAt_idx" ON "Alert"("organizationId", "createdAt");
CREATE TABLE "AlertNotification" (
 id TEXT PRIMARY KEY, "alertId" TEXT NOT NULL REFERENCES "Alert"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "eventId" TEXT REFERENCES "Event"(id) ON DELETE SET NULL ON UPDATE CASCADE,
 phase TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AlertNotification_eventId_key" ON "AlertNotification"("eventId");
CREATE UNIQUE INDEX "AlertNotification_alertId_phase_key" ON "AlertNotification"("alertId", phase);
