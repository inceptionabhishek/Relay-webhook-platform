import http from 'k6/http';
import { check } from 'k6';
export const options = {
  scenarios: {
    ingest: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 10),
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'] },
};
export default function () {
  const response = http.post(
    `${__ENV.API_URL || 'http://host.docker.internal:4000'}/events`,
    JSON.stringify({
      type: 'load.test',
      payload: { orderId: `${__VU}-${__ITER}`, workload: 'synthetic' },
    }),
    {
      headers: {
        Authorization: `Bearer ${__ENV.API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `load-${__ENV.RUN_ID || 'local'}-${__VU}-${__ITER}`,
      },
    },
  );
  check(response, { 'durably accepted': (res) => res.status === 201 });
}
