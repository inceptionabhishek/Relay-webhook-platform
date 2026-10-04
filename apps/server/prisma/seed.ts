import { db } from '../src/db';
import { passwordHash, token, encrypt } from '../src/crypto';
async function seed() {
  const email = process.env.SEED_EMAIL;
  const password = process.env.SEED_PASSWORD;
  if (!email || !password || password.length < 12)
    throw new Error('Set SEED_EMAIL and a SEED_PASSWORD of at least 12 characters in .env');
  if (process.env.NODE_ENV === 'production')
    throw new Error('Demo seeding is disabled in production');
  const user = await db.user.upsert({
    where: { email },
    update: {},
    create: { email, name: 'Demo Developer', passwordHash: await passwordHash(password) },
  });
  let membership = await db.membership.findFirst({
    where: { userId: user.id },
    include: { organization: true },
  });
  if (!membership) {
    const organization = await db.organization.create({
      data: {
        name: 'Acme Engineering',
        memberships: { create: { userId: user.id, role: 'owner' } },
      },
    });
    membership = await db.membership.findFirstOrThrow({
      where: { userId: user.id, organizationId: organization.id },
      include: { organization: true },
    });
  }
  const base = process.env.DEMO_RECEIVER_URL ?? 'http://localhost:4200';
  for (const [name, path, enabled] of [
    ['Order service', 'success', true],
    ['Unstable service', 'flaky', false],
    ['Rate-limited service', 'throttle', false],
    ['Unavailable service', 'fail', false],
    ['Slow service', 'slow', false],
  ] as const) {
    const existing = await db.endpoint.findFirst({
      where: { organizationId: membership.organizationId, name },
    });
    if (existing) {
      const knownDemoUrls = [
        'http://localhost:4200',
        'http://127.0.0.1:4200',
        'http://receiver:4200',
      ].map((host) => `${host}/webhooks/${path}`);
      if (knownDemoUrls.includes(existing.url) && existing.url !== `${base}/webhooks/${path}`)
        await db.endpoint.update({
          where: { id: existing.id },
          data: { url: `${base}/webhooks/${path}` },
        });
    } else
      await db.endpoint.create({
        data: {
          organizationId: membership.organizationId,
          name,
          url: `${base}/webhooks/${path}`,
          enabled,
          secretEncrypted: encrypt(token('whsec_')),
        },
      });
  }
  console.log('Demo workspace and receiver endpoints ready. Login credentials are in your .env.');
}
void seed().finally(() => db.$disconnect());
