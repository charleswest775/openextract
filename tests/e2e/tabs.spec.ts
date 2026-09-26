import { test, expect } from './fixtures';

// After opening the fixture backup, every sidebar tab must render its
// content panel without throwing. Catches regressions where a tab's
// data-fetching hook crashes on empty-backup responses from the sidecar.
//
// Sidebar buttons render as icon-only <button title="Label">. Playwright's
// accessible-name computation picks up `title`, so getByRole with the label
// works. `History` is hidden when the backup has no browser history; the
// synthetic fixture is empty, so it's excluded here.
const TABS: { button: string; assert: RegExp | string }[] = [
  { button: 'Overview',  assert: 'E2E Test iPhone' },
  { button: 'Timeline',  assert: /Timeline|No (events|activity)/i },
  { button: 'Messages',  assert: /Messages|No (conversations|messages)/i },
  { button: 'Photos',    assert: /Photos|No photos|Albums/i },
  { button: 'Contacts',  assert: /Contacts|No contacts/i },
  { button: 'Calls',     assert: /Calls|No calls/i },
  { button: 'Notes',     assert: /Notes|No notes/i },
  { button: 'Voicemail', assert: /Voicemail|No voicemails/i },
  { button: 'Recover',   assert: /Recover|No recoverable|deleted/i },
  { button: 'Export',    assert: /Export/i },
];

test('every sidebar tab renders after opening a backup', async ({ firstWindow }) => {
  await firstWindow.getByRole('button', { name: /Explore my data/i }).click();
  await expect(firstWindow.getByRole('heading', { level: 1, name: 'E2E Test iPhone' }))
    .toBeVisible({ timeout: 20_000 });

  const jsErrors: string[] = [];
  firstWindow.on('pageerror', (err) => jsErrors.push(err.message));

  for (const tab of TABS) {
    await firstWindow.getByRole('button', { name: tab.button, exact: true }).click();
    await expect(firstWindow.getByText(tab.assert).first())
      .toBeVisible({ timeout: 15_000 });
  }

  expect(jsErrors, `uncaught renderer errors: ${jsErrors.join(' | ')}`).toEqual([]);
});
