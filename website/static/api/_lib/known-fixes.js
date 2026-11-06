'use strict';

// Answers the app shows right after a report is sent, when the report looks like
// a problem we already know about. Edit freely: the site redeploys when this
// merges, and the app picks up the change without a new release.
//
// `match` is tested against what the user wrote plus the diagnostics; `when`, if
// given, must match too (diagnostics start "App: OpenExtract 0.9.0 on macOS …").
// Match the words the app and engine really use: scripts/feedback.test.mjs sends
// their real error messages through here, so add yours there when you add a fix.
// Keep `text` plain (no Markdown), short, and written for someone who isn't technical.

const KNOWN_FIXES = [
  {
    id: 'engine-did-not-start',
    title: "Part of OpenExtract didn't start",
    // From electron/sidecar.ts: a call made while the engine is down, and a failed launch in its log.
    match: /Python sidecar is not running|\[ERROR STARTING\]/,
    text: 'Quit OpenExtract and open it again. If it still can\'t open backups, download the latest version from openextract.app and install it over this one. On Windows, security software (Windows Security, Smart App Control or an antivirus) can stop part of OpenExtract from running: check it for a recent alert about OpenExtract.',
  },
  {
    id: 'backup-password',
    title: 'The password for an encrypted backup',
    // The engine says "Failed to decrypt backup: Failed to decrypt keys: incorrect passphrase?";
    // the rest is how people put it. Not "passcode": that's the iPhone's own lock. "Forgot" only
    // counts right before "my/the (backup) password", so a forgotten Wi-Fi or Apple ID password doesn't.
    match: /(?:incorrect|wrong) pass(?:word|phrase)|pass(?:word|phrase) (?:is |was )?(?:incorrect|wrong)|\b(?:forg[eo]t(?:ten)?|lost|(?:(?:can|don|couldn)['’]?t|cannot|do not) remember) (?:the |my |our |this )?(?:backup |encryption |encrypted backup )?pass(?:word|phrase)\b/i,
    text: "An encrypted backup uses the password you chose for backups in Finder or iTunes. It isn't your iPhone passcode or your Apple Account password. If you can't remember it, it can't be recovered, but you can remove it on the iPhone: Settings > General > Transfer or Reset iPhone > Reset > Reset All Settings. That keeps your data but resets settings such as Wi-Fi passwords and wallpaper. Then make a new encrypted backup with a new password.",
  },
  {
    id: 'mac-full-disk-access',
    title: 'macOS needs to allow access',
    // The engine's own message starts "FULL_DISK_ACCESS_REQUIRED:"; the prose after a long
    // folder path can be cut off in the report's list of recent errors.
    match: /Operation not permitted|PermissionError|Full[ _]Disk[ _]Access/i,
    when: /on macOS/,
    text: 'macOS keeps iPhone backups in a protected folder. Open System Settings > Privacy & Security > Full Disk Access, turn on OpenExtract, then quit and reopen OpenExtract.',
  },
  {
    id: 'iphone-full',
    title: 'Your iPhone needs free space to make a backup',
    // The iPhone's own refusal (MBErrorDomain/105), in the engine log; up to 0.10.1 the app
    // blamed the backup drive for it (OE-10). Later versions say "Your iPhone is too full …".
    match: /Failed to create snapshot|iPhone is too full to make a backup/,
    text: 'Your iPhone itself is too full to make a backup, however much space the computer or drive has: it needs some free space of its own to prepare one. On the iPhone, open Settings > General > iPhone Storage, delete or offload what you don\'t need, then try the backup again.',
  },
  {
    id: 'encrypted-backup-no-such-value',
    title: 'Encrypted backups of some iPhones',
    // python/device_backup.py up to 0.10.1, when an iPhone has never made an encrypted backup:
    // pymobiledevice3's MissingValueError (OE-12).
    match: /No such value\./,
    text: 'OpenExtract 0.10.1 and earlier can\'t make an encrypted backup of an iPhone that has never made one. Until an update fixes it, turn off "Encrypt backup" and try again. An unencrypted backup leaves out some data, such as saved passwords and Health data.',
  },
  {
    id: 'windows-apple-devices',
    title: 'Windows needs Apple Devices to find an iPhone',
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
    match: /No iPhone backups found/i,
    text: 'Choose the folder that holds your backups, not one backup inside it. On a Mac it\'s Library/Application Support/MobileSync/Backup in your user folder. On Windows it\'s usually Apple/MobileSync/Backup in your user folder, or AppData/Roaming/Apple Computer/MobileSync/Backup.',
  },
];

module.exports = { KNOWN_FIXES };
