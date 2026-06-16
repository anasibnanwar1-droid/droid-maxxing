import { expect, test } from '@playwright/test';

test('loads the Droid Control shell', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/Droid Control/);
  await expect(page.locator('#root')).toBeVisible();
});
