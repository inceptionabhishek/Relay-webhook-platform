ALTER TABLE "Organization" ADD COLUMN "lastScheduledAt" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00';
ALTER TABLE "Outbox" ADD COLUMN "completedAt" TIMESTAMP(3);
CREATE INDEX "Delivery_endpointId_status_nextAttemptAt_idx" ON "Delivery"("endpointId", "status", "nextAttemptAt");
CREATE TABLE "CircuitTransition" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "endpointId" TEXT NOT NULL REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "fromState" TEXT NOT NULL,
  "toState" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CircuitTransition_endpointId_createdAt_idx" ON "CircuitTransition"("endpointId", "createdAt");
CREATE TABLE "ReplayBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "actor" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "ReplayBatch_organizationId_idempotencyKey_key" ON "ReplayBatch"("organizationId", "idempotencyKey");
CREATE INDEX "ReplayBatch_organizationId_createdAt_idx" ON "ReplayBatch"("organizationId", "createdAt");
CREATE TABLE "ReplayItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "batchId" TEXT NOT NULL REFERENCES "ReplayBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "deliveryId" TEXT NOT NULL REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "expectedGeneration" INTEGER NOT NULL,
  "replayGeneration" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "error" TEXT
);
CREATE UNIQUE INDEX "ReplayItem_batchId_deliveryId_key" ON "ReplayItem"("batchId", "deliveryId");
CREATE INDEX "ReplayItem_status_batchId_idx" ON "ReplayItem"("status", "batchId");
