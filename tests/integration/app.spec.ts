import { expect, test } from '@playwright/test';

const appUrl = process.env.DROIDEX_TEST_URL || '/';

test('loads the Droid Control shell', async ({ page }) => {
  await page.goto(appUrl);

  await expect(page).toHaveTitle(/Droid Control/);
  await expect(page.locator('#root')).toBeVisible();
});

test('slash feedback returns a durable copyable report receipt', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(appUrl);

  const composer = page.locator('textarea').first();
  await composer.fill('/');
  await page.getByText('/bug', { exact: true }).click();

  const dialog = page.getByRole('dialog');
  const details = page.getByRole('textbox', { name: 'Details' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bug', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(details).toBeFocused();

  await page.evaluate(() => {
    Reflect.set(window, 'droidControl', {
      submitFeedbackReport: async () => ({
        reportId: 'RPT-20260804-A1B2C3D4E5F6',
        userId: 'USR-123456781234',
        eventId: '00112233445566778899aabbccddeeff',
      }),
    });
  });
  await details.fill('The update button stopped responding after download.');
  await page.getByRole('button', { name: 'Submit report' }).click();

  await expect(page.getByRole('heading', { name: 'Report sent' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Report ID' })).toHaveValue(
    'RPT-20260804-A1B2C3D4E5F6',
  );
  await page.getByRole('button', { name: 'Copy ID' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('RPT-20260804-A1B2C3D4E5F6');
});
