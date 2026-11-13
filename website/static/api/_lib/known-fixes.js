'use strict';

// Answers the app shows right after a report is sent, when the report looks like
// a problem we already know about, and the "Fixes for common problems" page
// (website/static/fixes.html). Edit freely: the site redeploys when this merges,
// and the app picks up the change without a new release. After editing, run
// `node scripts/build-fixes-page.mjs` to update the page; `npm test` fails until you do.
//
// `match` is tested against what the user wrote plus the diagnostics; `when`, if
// given, must match too (diagnostics start "App: OpenExtract 0.9.0 on macOS …").
// Match the words the app and engine really use: scripts/feedback.test.mjs sends
// their real error messages through here, so add yours there when you add a fix.
// Keep `text` plain (no Markdown), short, and written for someone who isn't technical.
//
// For the page: `area` is the section it goes in ('backup', 'open' or 'app'), `seen`
// is the words the app shows, so people can search for them, and `fixedIn` is the
// version that fixed a bug of ours. Nothing from a private report goes in here.
//
// `hides`, if given, lists fixes not to show alongside this one, for a vaguer fix whose
// advice would be wrong once this one matches (the app shows at most two).

const KNOWN_FIXES = [
  {
    id: 'backups-fail-in-0-15-0',
    title: "OpenExtract 0.15.0 can't make backups",
    area: 'backup',
    seen: ['pymobiledevice3 is not installed. Run: pip install pymobiledevice3'],
    fixedIn: '0.15.1',
    // python/device_backup.py in 0.15.0: pymobiledevice3 11.54 imports pyimg4 on its way to a
    // backup, pyimg4 reads its own package metadata, and the engine was built without it, so every
    // backup failed and the import error was reported as pymobiledevice3 missing (OE-50, OE-51,
    // OE-54). Installing pymobiledevice3 doesn't reach the app's own copy. The next version collects
    // the metadata (scripts/bundle-engine.mjs) and no longer says this, hence `when`.
    match: /pymobiledevice3 is not installed/,
    when: /App: OpenExtract 0\.15\.0\b/,
    text: "OpenExtract 0.15.0 can't make backups: a part it needs was left out when this version was built, so every backup stops at once and says pymobiledevice3 is not installed. Installing pymobiledevice3 yourself won't help, because OpenExtract uses its own copy. OpenExtract 0.15.1 fixes it: install the latest version from openextract.app, then try the backup again.",
  },
  {
    id: 'ios6-photos-stop-engine',
    title: 'Backups made by iOS 6 stop OpenExtract',
    area: 'open',
    seen: ['Sidecar exited with code 1', 'Python sidecar is not running'],
    fixedIn: '0.13.0',
    // python/main.py in 0.12.0 exited when a result held raw bytes, which list_photos gave for
    // an iOS 6 backup (Photos.sqlite keeps photo UUIDs as bytes there), so every later call
    // failed with "Python sidecar is not running" (OE-26 to OE-28). Its traceback is in the
    // report's engine log. Reinstalling, which engine-did-not-start suggests, doesn't help.
    match: /Object of type bytes is not JSON serializable/,
    hides: ['engine-did-not-start'],
    text: "OpenExtract 0.12.0 stops working a few moments after it opens a backup made by iOS 6, when it reads the backup's photos. After that, everything says \"Sidecar exited with code 1\" or \"Python sidecar is not running\". Reinstalling 0.12.0 won't help. OpenExtract 0.13.0 fixes it: install the latest version from openextract.app, then open the backup again.",
  },
  {
    id: 'engine-did-not-start',
    title: "Part of OpenExtract didn't start",
    area: 'app',
    seen: ['Python sidecar is not running'],
    // From electron/sidecar.ts: a call made while the engine is down, and a failed launch in its log.
    match: /Python sidecar is not running|\[ERROR STARTING\]/,
    text: 'Quit OpenExtract and open it again. If it still can\'t open backups, download the latest version from openextract.app and install it over this one. On Windows, security software (Windows Security, Smart App Control or an antivirus) can stop part of OpenExtract from running: check it for a recent alert about OpenExtract.',
  },
  {
    id: 'saving-timed-out',
    title: 'Saving stopped after 5 minutes',
    area: 'app',
    seen: ['Sidecar call timed out: export_photos'],
    fixedIn: '0.11.0',
    // electron/sidecar.ts up to 0.10.2 gave every call 5 minutes, which saving a big photo
    // library (decrypted file by file from an encrypted backup) runs past (OE-14). Later
    // versions give saving 2 hours. The engine goes on saving after the app stops waiting.
    match: /Sidecar call timed out: export_/,
    text: 'OpenExtract 0.10.2 and earlier stop waiting for a save after 5 minutes. That isn\'t long enough for a big photo library, especially from an encrypted backup. Install the latest version from openextract.app, which waits much longer and shows how far a save has got. If you can\'t update yet, the files usually go on saving anyway: open the folder you chose and wait until new files stop appearing, then quit and reopen OpenExtract before you browse again.',
  },
  {
    id: 'backup-password',
    title: 'The password for an encrypted backup',
    area: 'open',
    seen: ['Incorrect password. Please try again.'],
    // The engine says "Failed to decrypt backup: Failed to decrypt keys: incorrect passphrase?";
    // the rest is how people put it. Not "passcode": that's the iPhone's own lock. "Forgot" only
    // counts right before "my/the (backup) password", so a forgotten Wi-Fi or Apple ID password doesn't.
    match: /(?:incorrect|wrong) pass(?:word|phrase)|pass(?:word|phrase) (?:is |was )?(?:incorrect|wrong)|\b(?:forg[eo]t(?:ten)?|lost|(?:(?:can|don|couldn)['’]?t|cannot|do not) remember) (?:the |my |our |this )?(?:backup |encryption |encrypted backup )?pass(?:word|phrase)\b/i,
    text: "An encrypted backup uses the password you chose for backups in Finder or iTunes. It isn't your iPhone passcode or your Apple Account password. If you can't remember it, it can't be recovered, but you can remove it on the iPhone: Settings > General > Transfer or Reset iPhone > Reset > Reset All Settings. That keeps your data but resets settings such as Wi-Fi passwords and wallpaper. Then make a new encrypted backup with a new password.",
  },
  {
    id: 'mac-full-disk-access',
    title: 'macOS needs to allow access',
    area: 'open',
    seen: ['macOS is blocking OpenExtract from reading', 'Operation not permitted'],
    // The engine's own message starts "FULL_DISK_ACCESS_REQUIRED:"; the prose after a long
    // folder path can be cut off in the report's list of recent errors.
    match: /Operation not permitted|PermissionError|Full[ _]Disk[ _]Access/i,
    when: /on macOS/,
    text: 'macOS keeps iPhone backups in a protected folder. Open System Settings > Privacy & Security > Full Disk Access, turn on OpenExtract, then quit and reopen OpenExtract.',
  },
  {
    id: 'iphone-full',
    title: 'Your iPhone needs free space to make a backup',
    area: 'backup',
    seen: ['Your iPhone is too full to make a backup'],
    // The iPhone's own refusal (MBErrorDomain/105), in the engine log; up to 0.10.1 the app
    // blamed the backup drive for it (OE-10). Later versions say "Your iPhone is too full …".
    match: /Failed to create snapshot|iPhone is too full to make a backup/,
    text: 'Your iPhone itself is too full to make a backup, however much space the computer or drive has: it needs some free space of its own to prepare one. (OpenExtract 0.10.1 and earlier said the drive was too small instead.) On the iPhone, open Settings > General > iPhone Storage, delete or offload what you don\'t need, then try the backup again.',
  },
  {
    id: 'backup-drive-full',
    title: 'The backup needs more space than the drive has',
    area: 'backup',
    seen: ['Not enough free space for this backup'],
    // python/device_backup.py _disk_full_message() when the iPhone said how much it needs, or
    // reported its own usage. "The drive you chose only has N GB free" alone was also what 0.10.1
    // said for a full iPhone, so that wording isn't matched.
    match: /It needs more than [\d.]+ GB free, but the drive you chose has|Your iPhone has about [\d.]+ GB of data, but the drive you chose only has/,
    text: 'The drive you chose doesn\'t have room for the backup. A backup can need much more space than your iPhone shows as used, because the iPhone counts some files more than once. Choose a folder on a drive with more free space, such as an external drive, or free up space on this one, then try again.',
  },
  {
    id: 'encrypted-backup-no-such-value',
    title: 'Encrypted backups of some iPhones',
    area: 'backup',
    seen: ['No such value.'],
    fixedIn: '0.10.2',
    // python/device_backup.py up to 0.10.1, when an iPhone has never made an encrypted backup:
    // pymobiledevice3's MissingValueError (OE-12).
    match: /No such value\./,
    text: 'OpenExtract 0.10.1 and earlier can\'t make an encrypted backup of an iPhone that has never made one. Install the latest version from openextract.app. If you can\'t update yet, turn off "Encrypt backup" and try again; an unencrypted backup leaves out some data, such as saved passwords and Health data.',
  },
  {
    id: 'iphone-could-not-send-files',
    title: "Your iPhone couldn't send some of its files",
    area: 'backup',
    seen: ["Your iPhone couldn't send some of its files", 'Multiple errors uploading files (MBErrorDomain/104)'],
    // MBErrorDomain/104 from the iPhone (OE-6, OE-8); python/device_backup.py _FILES_NOT_SENT after 0.10.1.
    match: /Multiple errors uploading files|iPhone couldn't send some of its files/,
    text: 'The iPhone couldn\'t read or send some of its files during the backup. Restart your iPhone, plug it back in, unlock it, then try the backup again.',
  },
  {
    id: 'unfinished-backup-folder',
    title: 'An unfinished backup in the folder',
    area: 'backup',
    seen: ['unfinished backup of this iPhone from an earlier try', 'Error reading backup manifest properties (MBErrorDomain/205)'],
    // MBErrorDomain/205 after an earlier try left an empty Manifest.plist (OE-6);
    // python/device_backup.py _UNFINISHED_BACKUP after 0.10.1.
    match: /Error reading backup manifest properties|unfinished backup of this iPhone from an earlier try/,
    text: 'An earlier backup into this folder stopped partway, and the iPhone can\'t continue it. Choose a new, empty folder and try again. Once the new backup has finished, you can delete the unfinished one.',
  },
  {
    id: 'backup-folder-access-denied',
    title: "OpenExtract wasn't allowed to change the backup folder",
    area: 'backup',
    seen: ["OpenExtract wasn't allowed to change a file in the backup folder", '[WinError 5] Access is denied'],
    // "[WinError 5] Access is denied: '…\\Snapshot\\00'" (OE-11); python/device_backup.py
    // _FOLDER_IN_USE after 0.10.1.
    match: /\[WinError 5\] Access is denied: '[^']*Snapshot|wasn't allowed to change a file in the backup folder/,
    text: 'Another program may be using the backup folder: OneDrive and other cloud folders, and antivirus software, can hold on to files while they work. Choose a new, empty folder that isn\'t in OneDrive or another synced folder, close any window showing the old one, then try again.',
  },
  {
    id: 'backup-stopped-after-2-hours',
    title: 'Big backups stopped after 2 hours',
    area: 'backup',
    seen: ['Sidecar call timed out: backup.start'],
    fixedIn: '0.13.0',
    // electron/main.ts up to 0.12.0 gave backup.start 2 hours in all, so a big backup that was
    // still copying stopped partway (OE-17, OE-18, OE-31). From 0.13.0 the limit counts from the
    // last progress report (electron/sidecar.ts restartClock), so this error then means 2 hours
    // with nothing from the iPhone, which this text doesn't fit: hence `when`.
    match: /Sidecar call timed out: backup\.start/,
    when: /App: OpenExtract 0\.(?:\d|1[0-2])\.\d+\b/,
    text: "OpenExtract 0.12.0 and earlier stop waiting for a backup after 2 hours, even while it's still copying, so a big backup stops partway. OpenExtract 0.13.0 fixes it: install the latest version from openextract.app, then try the backup again. It now gives up only if the iPhone sends nothing for 2 hours.",
  },
  {
    id: 'backup-connection-dropped',
    title: 'The iPhone disconnected partway through a backup',
    area: 'backup',
    seen: [
      'Your iPhone was disconnected before the backup finished',
      'The connection to your iPhone dropped partway through the backup',
      'Your computer went to sleep during the backup',
      'The connection to your iPhone was terminated unexpectedly',
    ],
    // python/device_backup.py _DEVICE_DISCONNECTED and _CONNECTION_DROPPED, and electron/main.ts
    // COMPUTER_SLEPT. Up to 0.12.0 a drop partway with the iPhone still listed said "terminated
    // unexpectedly … tap 'Trust'" (OE-29, OE-31), and the app didn't keep the computer awake.
    match: /disconnected before the backup finished|connection to your iPhone (?:dropped partway|was terminated unexpectedly)|computer went to sleep during the backup/,
    text: 'A backup can take hours, and the iPhone drops off if the computer goes to sleep or the USB connection is interrupted, even while it stays plugged in. OpenExtract 0.13.0 and later keep the computer awake during a backup, so if you have an older version, install the latest from openextract.app first. Keep the computer plugged in, keep a laptop\'s lid open, and don\'t let it sleep until the backup finishes. Plug the iPhone straight into the computer, not through a hub, dock or monitor, and try another USB port if it keeps happening. Then try the backup again.',
  },
  {
    id: 'windows-apple-devices',
    title: 'Windows needs Apple Devices to find an iPhone',
    area: 'backup',
    seen: ["OpenExtract needs Apple Devices, Apple's free iPhone app for Windows", 'Cannot connect to Apple Mobile Device Service'],
    // python/device_backup.py when it can't reach Apple's device service. Up to 0.10.0 it said
    // "Cannot connect to Apple Mobile Device Service. …"; later versions "DEVICE_SERVICE_REQUIRED: …".
    match: /DEVICE_SERVICE_REQUIRED:|Cannot connect to Apple Mobile Device Service/,
    when: /on Windows/,
    // Opening Apple Devices doesn't start the part OpenExtract needs; opening it once sets it to
    // start when you sign in, so a restart is what makes it run (tested on Windows 11).
    text: "To find or back up an iPhone, Windows needs Apple Devices, Apple's free app (iTunes works too). Get Apple Devices from the Microsoft Store, open it once, then restart your PC. Then plug in your iPhone, unlock it, tap Trust if it asks, and click Refresh in OpenExtract. You don't need it to open backups you already have.",
  },
  {
    id: 'no-backups-found',
    title: 'Choosing the backups folder',
    area: 'open',
    seen: ['No iPhone backups found in'],
    match: /No iPhone backups found/i,
    text: 'Choose the folder that holds your backups, not one backup inside it. If a backup you were making with OpenExtract didn\'t finish, there\'s nothing to open yet: make the backup again first. On a Mac it\'s Library/Application Support/MobileSync/Backup in your user folder. On Windows it\'s usually Apple/MobileSync/Backup in your user folder, or AppData/Roaming/Apple Computer/MobileSync/Backup.',
  },
];

module.exports = { KNOWN_FIXES };
