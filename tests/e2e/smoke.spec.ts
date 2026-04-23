import { test, expect } from './fixtures';

// Smoke test: proves the full stack (Electron main + preload + renderer +
// Python sidecar) boots and can round-trip a JSON-RPC call. Any future per-
// tab regression spec can layer on top of this.
test('app launches and sidecar responds to ping', async ({ firstWindow }) => {
  await expect(firstWindow.getByRole('heading', { name: /iPhone data, unlocked/i }))
    .toBeVisible();

  const pingResult = await firstWindow.evaluate(async () => {
    return await (window as any).openextract.call('ping', {});
  });

  expect(pingResult).toMatchObject({
    success: true,
    data: { status: 'ok' },
  });
});
