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
