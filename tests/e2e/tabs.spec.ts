import { test, expect, loadExpected, openFixtureBackup } from './fixtures';

// UI-level regression: open the populated fixture and walk every sidebar
// tab, asserting that real fixture content is rendered (not just that the
// panel mounted). Fails on any uncaught renderer error along the way.
//
// Sidebar buttons are icon-only <button title="Label">; Playwright's
// accessible name picks up `title`. `History` only appears when the backup
// has browser history, which the populated fixture does.
test('every sidebar tab renders the fixture data', async ({ firstWindow: page }) => {
  const x = loadExpected();
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  await openFixtureBackup(page);

  // Scope to the sidebar: panels have their own buttons with the same names
  // (e.g. Recover has an "Export" button).
  const tab = (name: string) =>
    page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
  const visible = (text: string | RegExp) =>
    expect(page.getByText(text).first()).toBeVisible({ timeout: 15_000 });

  await test.step('Overview', async () => {
    await tab('Overview');
    await expect(page.getByRole('heading', { level: 1, name: x.device_name })).toBeVisible();
    await visible('Alice Chen');
  });

  await test.step('Timeline', async () => {
    await tab('Timeline');
    await visible(/Alice Chen|Weekend Hike|Carol Okafor/);
  });

  await test.step('Messages', async () => {
    await tab('Messages');
    await visible('Weekend Hike');
    await visible('Alice Chen');
    await page.getByText('Weekend Hike').first().click();
    await visible(x.search.text);
  });

  await test.step('Photos', async () => {
    await tab('Photos');
    await expect(page.locator('img[src^="data:image"]')).toHaveCount(x.photos.length, { timeout: 15_000 });
  });

  await test.step('Contacts', async () => {
    await tab('Contacts');
    for (const name of x.contacts) await visible(name);
  });

  await test.step('Calls', async () => {
    await tab('Calls');
    await visible('Bob Martinez');
    await visible('Acme Dental');
  });

  await test.step('Notes', async () => {
    await tab('Notes');
    for (const title of x.notes) await visible(title);
  });

  await test.step('Voicemail', async () => {
    await tab('Voicemail');
    await visible('Carol Okafor');
    await visible('Acme Dental');
  });

  await test.step('History', async () => {
    await tab('History');
    // Opens on a summary view; the per-visit list is one click deeper.
    await expect(page.getByRole('heading', { name: new RegExp(`Browser History.*${x.browser_visits}`) }))
      .toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /View Full History/ }).click();
    for (const title of x.browser_titles) await visible(title);
  });

  await test.step('Recover', async () => {
    await tab('Recover');
    await page.getByRole('button', { name: /Scan for deleted messages/ }).click();
    // The first recovered conversation is auto-selected after the scan.
    await visible(x.recently_deleted);
    await page.getByRole('button', { name: /Bob Martinez/ }).click();
    await visible(x.orphaned);
  });

  await test.step('Export', async () => {
    await tab('Export');
    await expect(page.getByRole('heading', { name: 'Export Data' })).toBeVisible();
    await visible('Export call log as CSV');
  });

  expect(jsErrors, `uncaught renderer errors: ${jsErrors.join(' | ')}`).toEqual([]);
});
