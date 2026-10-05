import './telemetry';
import { createServer } from 'node:http';
import { dispatchBatch, reconcile } from './outbox';
import { processReplayBatches } from './replay';
import { sweepRetention } from './retention';
import { sweepAlerts } from './alerts';
import { logger, registry } from './observability';
import { db } from './db';
import { redis, deliveryQueue } from './queue';
let running = true;
const metrics = createServer(async (_req, res) => {
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
}).listen(4001, '0.0.0.0');
process.once('SIGTERM', () => {
  running = false;
});
process.once('SIGINT', () => {
  running = false;
});
void (async () => {
  let lastMaintenance = 0;
  let lastReconcile = 0;
  logger.info('Outbox dispatcher ready');
  while (running) {
    try {
      if (Date.now() - lastMaintenance >= 10000) {
        lastMaintenance = Date.now();
        await sweepAlerts();
        await sweepRetention();
      }
      await processReplayBatches();
      await dispatchBatch();
      if (Date.now() - lastReconcile >= 10000) {
        lastReconcile = Date.now();
        await reconcile();
      }
    } catch (err) {
      logger.error({ err }, 'Dispatch interrupted; outbox retained');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  metrics.close();
  await deliveryQueue.close();
  redis.disconnect();
  await db.$disconnect();
})();
