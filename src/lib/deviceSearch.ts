/**
 * The iPhone search on Back up my iPhone (backup.list_devices, python/device_backup.py) and
 * how its results read on screen (src/components/backup/BackupFlow.tsx).
 */

/** One iPhone or iPad the search found. */
export interface DeviceInfo {
  udid: string;
  name: string;
  ios_version: string;
  connection_type: 'usb' | 'wifi';
  // false until the iPhone trusts this computer (backup.pair_device); null when unknown
  trusted?: boolean | null;
  // true when the iPhone already has a backup password (Encrypt local backup): every backup
  // is encrypted with it, and the app can't set a new one (OE-68). null when unknown.
  encrypts_backups?: boolean | null;
  // false when the iPhone is connected but didn't answer the search in time (OE-37, OE-8,
  // OE-31); `message` then says what to do. Its name and iOS version may be unknown.
  answering?: boolean;
  message?: string;
}

/** The line under a device's name: "iOS 18.1 · USB", and what it's waiting for, if anything. */
export function deviceDetail(device: DeviceInfo): string {
  const parts: string[] = [];
  if (device.ios_version) parts.push(`iOS ${device.ios_version}`);
  parts.push(device.connection_type === 'usb' ? 'USB' : 'Wi-Fi');
  if (device.answering === false) parts.push('Not answering');
  else if (device.trusted === false) parts.push('Waiting for you to trust this computer');
  return parts.join(' · ');
}

/** Whether a device can be backed up now: it answered the search and trusts this computer. */
export function canBackUp(device: DeviceInfo | null | undefined): boolean {
  return !!device && device.answering !== false && device.trusted !== false;
}

/** What to do about the devices that didn't answer, each piece of advice once. */
export function notAnsweringMessages(devices: DeviceInfo[]): string[] {
  const messages = devices.filter(d => d.answering === false).map(d => d.message || NOT_ANSWERING);
  return [...new Set(messages)];
}

/**
 * The device list once an iPhone that was asked to trust this computer stopped answering
 * (backup.pair_device's "not_answering"): listed as not answering, with the engine's `message`
 * saying what to do, as if it hadn't answered the search. Refresh asks it again.
 */
export function markNotAnswering(devices: DeviceInfo[], udid: string, message?: string): DeviceInfo[] {
  return devices.map(d => d.udid === udid
    ? { ...d, trusted: null, encrypts_backups: null, answering: false, message: message || NOT_ANSWERING }
    : d);
}

// For a device that didn't answer but came without the engine's own words.
const NOT_ANSWERING =
  "Your iPhone is connected but isn't answering. Unplug it, unlock it, plug it back in, then click Refresh.";

/**
 * Shown when the app stopped waiting for the search (electron/main.ts's limit), so the engine
 * may still be stuck on it, and the app's other requests wait behind it: hence reopening.
 * Before the engine had limits of its own, one silent iPhone did this after 5 minutes (OE-37).
 */
export const SEARCH_TIMED_OUT =
  "OpenExtract couldn't finish looking for your iPhone because something it asked didn't answer. "
  + 'Unplug your iPhone, quit OpenExtract and open it again, then unlock the iPhone, plug it back in and click Refresh. '
  + "If it still can't find it, restart your iPhone and your computer.";

/** The words to show when the search itself failed, from the failed call's message. */
export function searchFailedMessage(error: string): string {
  if (/^Sidecar call timed out/i.test(error)) return SEARCH_TIMED_OUT;
  return error;
}
