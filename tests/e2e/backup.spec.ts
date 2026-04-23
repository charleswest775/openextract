import { test, expect, ENCRYPTED_FIXTURE_BACKUP_PATH } from './fixtures';

// Opens the unencrypted synthetic backup end-to-end: click the "Explore my
// Data" CTA on the home screen, the stubbed `dialog:selectFolder` returns the
// fixture path, `list_backups` + `open_backup` succeed, and the app
// transitions to the Dashboard with the fixture's device name.
test('opens an unencrypted backup and shows the dashboard', async ({ firstWindow }) => {
  await expect(firstWindow.getByRole('heading', { name: /iPhone data, unlocked/i }))
    .toBeVisible();

  await firstWindow.getByRole('button', { name: /Explore my Data/i }).click();

  // Dashboard renders the backup's device name as the hero h1 — only
  // appears once stats have loaded from the sidecar, so reaching this
  // assertion proves open_backup succeeded and get_backup_stats returned.
  await expect(firstWindow.getByRole('heading', { name: 'E2E Test iPhone' }))
    .toBeVisible({ timeout: 20_000 });
});

// When the backup is encrypted and no password is supplied, open_backup
// returns `status: 'password_required'` and the PasswordDialog is rendered
// over the home screen. This test asserts the dialog appears — entering the
// correct password against a real-encrypted fixture requires ios-backup-core
// and is out of scope for smoke coverage.
test.describe('encrypted backup', () => {
  test.use({ backupPath: ENCRYPTED_FIXTURE_BACKUP_PATH });

  test('shows the password dialog', async ({ firstWindow }) => {
    await firstWindow.getByRole('button', { name: /Explore my Data/i }).click();

    await expect(firstWindow.getByText('Encrypted Backup')).toBeVisible({ timeout: 20_000 });
    await expect(firstWindow.getByPlaceholder('Backup password')).toBeVisible();
    await expect(firstWindow.getByRole('button', { name: 'Unlock' })).toBeVisible();
  });
});
