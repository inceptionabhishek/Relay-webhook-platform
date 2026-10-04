import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
const attempts = new Map();
createServer(async (req, res) => {
  if (req.url === '/health') {
    res.end('ok');
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/webhooks/')) {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 300000) {
      res.writeHead(413);
      res.end();
      return;
    }
  }
  if (process.env.RECEIVER_SECRET) {
    const timestamp = req.headers['webhook-timestamp'];
    const expected = createHmac('sha256', process.env.RECEIVER_SECRET)
      .update(`${req.headers['webhook-id']}.${timestamp}.${body}`)
      .digest();
    const matches = String(req.headers['webhook-signature'] ?? '')
      .split(',')
      .some((s) => {
        const received = Buffer.from(s.replace(/^v1=/, ''), 'hex');
        return received.length === expected.length && timingSafeEqual(received, expected);
      });
    if (!matches || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      res.writeHead(401);
      res.end('Invalid signature or timestamp');
      return;
    }
  }
  const mode = req.url.split('/').pop();
  const key = `${req.url}:${req.headers['webhook-id']}:${req.headers['webhook-delivery-id']}`;
  const count = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, count);
  if (attempts.size > 10000) attempts.delete(attempts.keys().next().value);
  if (mode === 'slow') {
    setTimeout(() => {
      res.writeHead(200);
      res.end('Slow response');
    }, 10000);
    return;
  }
  if (mode === 'fail' || (mode === 'flaky' && count < 3)) {
    res.writeHead(503);
    res.end('Simulated outage');
    return;
  }
  if (mode === 'throttle' && count === 1) {
    res.writeHead(429, { 'Retry-After': '2' });
    res.end('Simulated throttling');
    return;
  }
  if (mode === 'reject') {
    res.writeHead(400);
    res.end('Permanent rejection');
    return;
  }
  if (mode === 'redirect') {
    res.writeHead(302, { Location: 'http://169.254.169.254/' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ received: true, eventId: req.headers['webhook-id'], attempt: count }));
}).listen(4200, '0.0.0.0', () => console.log('Test receiver listening on :4200'));
