import { expect, test } from '@playwright/test';

test('historical comparison flow: ask, see real stages, change table, citations; persists on reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText("You don't have to remember what you asked yesterday.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Postgres hosting for a small SaaS' })).toBeVisible();

  const box = page.getByLabel('Message');
  await box.fill('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');
  await box.press('Enter');

  // Live research activity shows server-reported stages
  await expect(page.getByText('Memory', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Historical vs current')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Price up')).toBeVisible();
  await expect(page.getByText('Historical baseline unavailable').first()).toBeVisible();

  // Final message: citation chip links to the real source URL
  const cite = page.locator('a.cite[href="https://neon.tech/pricing"]').first();
  await expect(cite).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /^Sources/ }).click();
  await expect(page.getByText('Official pricing').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/echo-comparison.png', fullPage: false });

  // Persistence across reload
  await page.reload();
  await expect(page.getByText('Has any pricing changed since then?')).toBeVisible();
  await expect(page.getByText('Research trail')).toBeVisible();
});

test('conversation management: search, rename, delete', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Search conversation history').fill('CRM');
  await expect(page.getByRole('button', { name: /CRM shortlist/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Postgres hosting/ })).toHaveCount(0);
  await page.getByLabel('Search conversation history').fill('');

  const item = page.getByRole('button', { name: 'CRM shortlist for sales team' });
  await item.hover();
  await item.locator('..').getByLabel('Rename conversation').click();
  await page.getByLabel('Conversation title').fill('CRM shortlist (renamed)');
  await page.getByLabel('Conversation title').press('Enter');
  await expect(page.getByRole('button', { name: 'CRM shortlist (renamed)' })).toBeVisible();

  const renamed = page.getByRole('button', { name: 'CRM shortlist (renamed)' });
  await renamed.hover();
  await renamed.locator('..').getByLabel('Delete conversation').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'CRM shortlist (renamed)' })).toHaveCount(0);
});
