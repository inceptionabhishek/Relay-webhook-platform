import './telemetry';
import { Worker } from 'bullmq';
import { createServer } from 'node:http';
import { queueName, redis, deliveryQueue } from './queue';
import { processDelivery } from './delivery';
import { config } from './config';
import { db } from './db';
import { logger, registry } from './observability';
const worker = new Worker(queueName, (job) => processDelivery(job.data), {
  connection: { url: config.REDIS_URL },
  concurrency: config.WORKER_CONCURRENCY,
  lockDuration: 60000,
});
worker.on('failed', (job, err) =>
  logger.error(
    { jobId: job?.id, err },
    'Worker infrastructure failure; BullMQ retries and reconciler recover work',
  ),
);
worker.on('error', (err) => logger.error({ err }, 'Worker connection error'));
const metrics = createServer(async (_req, res) => {
  res.setHeader('content-type', registry.contentType);
  res.end(await registry.metrics());
}).listen(4002, '0.0.0.0');
logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'Delivery worker ready');
async function stop() {
  await worker.close();
  metrics.close();
  await deliveryQueue.close();
  redis.disconnect();
  await db.$disconnect();
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
