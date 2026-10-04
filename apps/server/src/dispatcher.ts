import './telemetry';
import { createServer } from 'node:http';
import { dispatchBatch, reconcile } from './outbox';
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
  let ticks = 0;
  logger.info('Outbox dispatcher ready');
  while (running) {
    try {
      await dispatchBatch();
      if (ticks++ % 20 === 0) await reconcile();
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
