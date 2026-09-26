import { test, expect } from './fixtures';

// Proves the full stack boots: Electron main + preload + renderer + Python
// sidecar can round-trip a JSON-RPC call. Every future spec builds on this.
test('app launches and sidecar responds to ping', async ({ firstWindow }) => {
  // FirstVisitView splits its hero across nodes ("Your iPhone data," + <span>
  // "unlocked.</span>"), so match via regex on the heading role.
  await expect(firstWindow.getByRole('heading', { name: /Your iPhone data.*unlocked/i }))
    .toBeVisible();

  const pingResult = await firstWindow.evaluate(async () => {
    return await (window as any).openextract.call('ping', {});
  });

  expect(pingResult).toMatchObject({
    success: true,
    data: { status: 'ok' },
  });
});
