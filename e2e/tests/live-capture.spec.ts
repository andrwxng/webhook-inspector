import { expect, test } from '@playwright/test';

/**
 * The brief's flagship flow: create an endpoint, send a webhook to it
 * from outside the browser, and watch it appear in the dashboard LIVE —
 * no reload, no polling. Exercises auth, endpoint creation, ingest,
 * SSE delivery (through Redis pub/sub), and safe payload rendering.
 */
test('register → create endpoint → webhook appears live → inspect detail', async ({
  page,
  request,
}) => {
  const email = `e2e-${Date.now()}@example.com`;

  // Register a fresh account.
  await page.goto('/');
  await page.getByRole('tab', { name: 'Sign up' }).click();
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');

  // Create an endpoint and grab its webhook URL.
  await page.fill('input[placeholder*="endpoint name"]', 'e2e endpoint');
  await page.click('text=New endpoint');
  const webhookUrl = (await page
    .locator('.endpoint-url code')
    .textContent())!.trim();
  expect(webhookUrl).toMatch(/\/in\/[a-z0-9]{12}$/);

  // Wait until the SSE stream is live, THEN send — proving delivery is
  // push, not a page refresh.
  await expect(page.locator('.live-badge')).toHaveText(/live/);
  const sent = await request.post(`${webhookUrl}/e2e/orders?source=test`, {
    headers: { 'content-type': 'application/json', 'x-e2e-header': 'hello' },
    data: '{"event":"e2e"}',
  });
  expect(sent.status()).toBe(200);

  // The capture appears without any reload.
  const row = page.locator('.request-list li');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('/e2e/orders');

  // Full detail: path, custom header, payload (JSON is pretty-printed,
  // still rendered as text only).
  await row.click();
  await expect(page.locator('.detail')).toContainText('/e2e/orders');
  await expect(page.locator('.detail')).toContainText('x-e2e-header');
  await expect(page.locator('.payload')).toContainText('"event": "e2e"');
});
