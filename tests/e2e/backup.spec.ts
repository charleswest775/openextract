import { test, expect, ENCRYPTED_FIXTURE_BACKUP_PATH } from './fixtures';

// Drives the full home → explore flow: clicks "Explore my data", the stubbed
// dialog returns the fixture path, list_backups + open_backup + get_backup_stats
// all go through the sidecar, and the dashboard renders the fixture's device
// name as an h1.
test('opens an unencrypted backup and shows the dashboard', async ({ firstWindow }) => {
  await firstWindow.getByRole('button', { name: /Explore my data/i }).click();

  await expect(firstWindow.getByRole('heading', { level: 1, name: 'E2E Test iPhone' }))
    .toBeVisible({ timeout: 20_000 });
});

// When Manifest.plist has IsEncrypted=True, open_backup returns
// status=password_required and the PasswordDialog renders over the home
// screen. Reaching the dialog proves the UI handled the encrypted branch.
// PasswordDialog isn't a role="dialog"; select by text.
test.describe('encrypted backup', () => {
  test.use({ backupPath: ENCRYPTED_FIXTURE_BACKUP_PATH });

  test('shows the password dialog', async ({ firstWindow }) => {
    await firstWindow.getByRole('button', { name: /Explore my data/i }).click();

    await expect(firstWindow.getByText('Encrypted Backup')).toBeVisible({ timeout: 20_000 });
    await expect(firstWindow.getByPlaceholder('Backup password')).toBeVisible();
    await expect(firstWindow.getByRole('button', { name: 'Unlock' })).toBeVisible();
  });
});
