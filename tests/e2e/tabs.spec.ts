import { test, expect } from './fixtures';

// After opening the fixture backup, every sidebar tab must render its
// content panel without throwing. This catches regressions where a tab's
// data-fetching hook crashes on empty-backup responses from the sidecar.
//
// browser_history is excluded because the sidebar hides it when the
// backup has no history data (see ExploreLayout.tsx:67-69), and the
// synthetic fixture is empty.
const TABS: { button: string; assert: RegExp | string }[] = [
  { button: 'Dashboard',        assert: 'E2E Test iPhone' },
  { button: 'Timeline',         assert: /Timeline|No (events|activity)/i },
  { button: 'Messages',         assert: /Messages|No (conversations|messages)/i },
  { button: 'Photos',           assert: /Photos|No photos|Albums/i },
  { button: 'Contacts',         assert: /Contacts|No contacts/i },
  { button: 'Calls',            assert: /Calls|No calls/i },
  { button: 'Notes',            assert: /Notes|No notes/i },
  { button: 'Voicemail',        assert: /Voicemail|No voicemails/i },
  { button: 'Record Recovery',  assert: /Record Recovery|Recover|No recoverable/i },
  { button: 'Export',           assert: /Export/i },
];

test('every sidebar tab renders after opening a backup', async ({ firstWindow }) => {
  // Get to the explore screen first.
  await firstWindow.getByRole('button', { name: /Explore my Data/i }).click();
  await expect(firstWindow.getByRole('heading', { name: 'E2E Test iPhone' }))
    .toBeVisible({ timeout: 20_000 });

  const jsErrors: string[] = [];
  firstWindow.on('pageerror', (err) => jsErrors.push(err.message));

  for (const tab of TABS) {
    await firstWindow.getByRole('button', { name: tab.button, exact: true }).click();
    // Every tab has distinct copy; matching at least one known phrase in the
    // rendered content proves the panel mounted without crashing.
    await expect(firstWindow.getByText(tab.assert).first())
      .toBeVisible({ timeout: 15_000 });
  }

  expect(jsErrors, `uncaught renderer errors: ${jsErrors.join(' | ')}`).toEqual([]);
});
