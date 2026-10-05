import { test, expect } from '@playwright/test';
test('register, publish, inspect delivery, replay, and manage credentials', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New to Relay? Create an account' }).click();
  await page.getByLabel('Your name').fill('Portfolio Developer');
  await page.getByLabel('Workspace name').fill(`Browser test ${Date.now()}`);
  await page.getByLabel('Email address').fill(`browser-${Date.now()}@test.local`);
  await page.getByLabel('Password', { exact: true }).fill('strong-browser-password');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delivery overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Endpoints', exact: true }).click();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser receiver');
  await page
    .getByLabel('Endpoint URL')
    .fill(`${process.env.E2E_RECEIVER_URL ?? 'http://localhost:4200'}/webhooks/success`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Endpoint signing secret' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Events', exact: true }).click();
  await page.getByRole('button', { name: 'Publish event', exact: true }).click();
  await page.getByLabel('Event type', { exact: true }).fill('browser.test');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Publish event', exact: true })
    .click();
  await expect(page.getByRole('dialog').getByText('Delivered', { exact: true })).toBeVisible();
  await expect(page.getByText('Attempt #1 · HTTP 200')).toBeVisible();
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.getByText('Attempt #2 · HTTP 200')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'API keys', exact: true }).click();
  await page.getByRole('button', { name: 'Create API key' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser key');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'API key', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('cell', { name: 'Revoked', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Audit log', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'delivery.replayed' })).toBeVisible();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.screenshot({ path: 'work/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'work/dashboard-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('failure inbox bulk replay and endpoint circuit recovery', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'New to Relay? Create an account' }).click();
  await page.getByLabel('Your name').fill('Delivery Operator');
  await page.getByLabel('Workspace name').fill(`Operations ${Date.now()}`);
  await page.getByLabel('Email address').fill(`operations-${Date.now()}@test.local`);
  await page.getByLabel('Password', { exact: true }).fill('strong-browser-password');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delivery overview' })).toBeVisible();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  const receiver = process.env.E2E_RECEIVER_URL ?? 'http://localhost:4200';
  const me = await (await page.request.get(`${apiUrl}/auth/me`)).json();
  const org = me.organizations[0].id;
  const headers = { Origin: 'http://localhost:3000', 'X-Organization-Id': org };
  const endpoint = await (
    await page.request.post(`${apiUrl}/endpoints`, {
      headers,
      data: { name: 'Operations receiver', url: `${receiver}/webhooks/reject` },
    })
  ).json();
  for (let i = 0; i < 3; i++) {
    const response = await page.request.post(`${apiUrl}/events`, {
      headers: { ...headers, 'Idempotency-Key': `replay-${i}` },
      data: { type: 'bulk.test', payload: { i } },
    });
    expect(response.status()).toBe(201);
  }
  await page.getByRole('button', { name: 'Failure inbox', exact: true }).click();
  await expect(page.getByText('3 failed deliveries', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'work/failure-inbox-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'work/failure-inbox-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(
    (
      await page.request.patch(`${apiUrl}/endpoints/${endpoint.id}`, {
        headers,
        data: { url: `${receiver}/webhooks/success` },
      })
    ).status(),
  ).toBe(200);
  await page.getByRole('button', { name: 'Select this page' }).click();
  await page.getByRole('button', { name: 'Replay selected (3)' }).click();
  await page.getByRole('button', { name: 'Start replay batch' }).click();
  await expect(page.getByRole('heading', { name: 'Replay batch progress' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Delivered', { exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByText('0 failed deliveries', { exact: true })).toBeVisible();
  const unhealthy = await (
    await page.request.post(`${apiUrl}/endpoints`, {
      headers,
      data: {
        name: 'Unhealthy receiver',
        url: `${receiver}/webhooks/fail`,
        eventTypes: ['circuit.test'],
      },
    })
  ).json();
  for (let i = 0; i < 8; i++) {
    expect(
      (
        await page.request.post(`${apiUrl}/events`, {
          headers: { ...headers, 'Idempotency-Key': `circuit-${i}` },
          data: { type: 'circuit.test', payload: { i } },
        })
      ).status(),
    ).toBe(201);
  }
  await page.getByRole('button', { name: 'Endpoints', exact: true }).click();
  const card = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Unhealthy receiver', exact: true }) });
  await expect(card.getByText('Circuit: open', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'work/circuit-open-desktop.png', fullPage: true });
  await card.getByRole('button', { name: 'Circuit history', exact: true }).click();
  await expect(card.getByText('Consecutive transient failure threshold reached')).toBeVisible();
  expect(
    (
      await page.request.patch(`${apiUrl}/endpoints/${unhealthy.id}`, {
        headers,
        data: { url: `${receiver}/webhooks/success` },
      })
    ).status(),
  ).toBe(200);
  await card.getByRole('button', { name: 'Probe now' }).click();
  await expect(card.getByText('Circuit: closed', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
