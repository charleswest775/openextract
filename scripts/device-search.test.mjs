// Tests for how the iPhone search on Back up my iPhone reads on screen, including an iPhone
// that's connected but didn't answer (OE-37, OE-8, OE-31).
// Run with: node --test scripts/device-search.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const { deviceDetail, canBackUp, markNotAnswering, notAnsweringMessages, searchFailedMessage, SEARCH_TIMED_OUT } =
  loadTs('src/lib/deviceSearch.ts');

const iphone = (extra = {}) => ({
  udid: 'U1', name: "Sam's iPhone", ios_version: '18.1', connection_type: 'usb',
  trusted: true, encrypts_backups: false, answering: true, ...extra,
});
// As python/device_backup.py _not_answering_device lists one that didn't answer its handshake.
const silent = (extra = {}) => ({
  udid: 'U2', name: 'iPhone', ios_version: '', connection_type: 'usb', trusted: null,
  encrypts_backups: null, answering: false,
  message: "Your iPhone is plugged in but isn't answering. Unplug it, unlock it, plug it back in, then click Refresh.",
  ...extra,
});

test('a device that answered shows its iOS version and connection', () => {
  assert.equal(deviceDetail(iphone()), 'iOS 18.1 · USB');
  assert.equal(deviceDetail(iphone({ connection_type: 'wifi' })), 'iOS 18.1 · Wi-Fi');
  assert.equal(deviceDetail(iphone({ trusted: false })), 'iOS 18.1 · USB · Waiting for you to trust this computer');
});

test("a device that didn't answer says so, without an iOS version it doesn't know", () => {
  assert.equal(deviceDetail(silent()), 'USB · Not answering');
  // One that stopped answering after its handshake: its iOS version is known.
  assert.equal(deviceDetail(silent({ ios_version: '18.1' })), 'iOS 18.1 · USB · Not answering');
});

test("only a device that answered and trusts this computer can be backed up", () => {
  assert.equal(canBackUp(iphone()), true);
  assert.equal(canBackUp(iphone({ trusted: false })), false);
  assert.equal(canBackUp(silent()), false);
  assert.equal(canBackUp(null), false);
  // Older engines sent neither answering nor (over RSD) a known trust state.
  assert.equal(canBackUp(iphone({ answering: undefined })), true);
});

test("what to do about devices that didn't answer is shown once per piece of advice", () => {
  assert.deepEqual(notAnsweringMessages([iphone()]), []);
  assert.deepEqual(notAnsweringMessages([silent(), silent({ udid: 'U3' })]), [silent().message]);
  const [fallback] = notAnsweringMessages([silent({ message: undefined })]);
  assert.match(fallback, /isn't answering\. Unplug it, unlock it, plug it back in, then click Refresh\.$/);
});

test('an iPhone that stops answering while asked to trust this computer is shown as not answering', () => {
  // backup.pair_device's "not_answering", with python/device_backup.py's message.
  const message = silent().message;
  const before = [iphone({ udid: 'U1', trusted: false, encrypts_backups: null }), iphone({ udid: 'U4' })];
  const after = markNotAnswering(before, 'U1', message);
  assert.deepEqual(after[0], { ...before[0], trusted: null, encrypts_backups: null, answering: false, message });
  assert.equal(after[1], before[1]);
  // No longer waiting for Trust (BackupFlow stops asking), and it says what to do.
  assert.equal(after.some(d => d.trusted === false), false);
  assert.equal(canBackUp(after[0]), false);
  assert.equal(deviceDetail(after[0]), 'iOS 18.1 · USB · Not answering');
  assert.deepEqual(notAnsweringMessages(after), [message]);
  // Without the engine's words, the app's own.
  assert.match(markNotAnswering(before, 'U1')[0].message, /isn't answering\. Unplug it/);
});

test('when the app stops waiting for the search, it says what to do in plain words', () => {
  const shown = searchFailedMessage('Sidecar call timed out: backup.list_devices');
  assert.equal(shown, SEARCH_TIMED_OUT);
  assert.doesNotMatch(shown, /sidecar|engine|timed out|usbmux|lockdown/i);
  assert.match(shown, /quit OpenExtract and open it again/);
  // The engine's own messages are already plain, and pass through.
  const engine = 'The part of macOS that talks to iPhones (usbmuxd) isn\'t answering. Restart your Mac, then click Refresh.';
  assert.equal(searchFailedMessage(engine), engine);
});
