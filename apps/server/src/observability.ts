import pino from 'pino';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers.set-cookie',
    'password',
    'secret',
    'apiKey',
    'token',
  ],
});
export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const deliveryAttempts = new Counter({
  name: 'relay_delivery_attempts_total',
  help: 'Outbound HTTP attempts by outcome',
  labelNames: ['outcome'],
  registers: [registry],
});
export const latency = new Histogram({
  name: 'relay_delivery_duration_seconds',
  help: 'Outbound HTTP duration',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});
export const backlog = new Gauge({
  name: 'relay_delivery_backlog',
  help: 'Non-terminal database deliveries',
  registers: [registry],
});
export const oldest = new Gauge({
  name: 'relay_oldest_delivery_age_seconds',
  help: 'Age of oldest outstanding delivery',
  registers: [registry],
});

export const circuitTransitions = new Counter({
  name: 'relay_circuit_transitions_total',
  help: 'Endpoint circuit transitions and probe requests',
  labelNames: ['state'],
  registers: [registry],
});
export const scheduleDelay = new Histogram({
  name: 'relay_dispatch_delay_seconds',
  help: 'Time past outbox due time before fair dispatch',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300],
  registers: [registry],
});

export const alertChanges = new Counter({
  name: 'relay_alert_changes_total',
  help: 'Delivery alert incident transitions',
  labelNames: ['state'],
  registers: [registry],
});
