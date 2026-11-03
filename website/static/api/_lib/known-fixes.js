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
    id: 'no-backups-found',
    title: 'Choosing the backups folder',
    match: /No iPhone backups found/i,
    text: 'Choose the folder that holds your backups, not one backup inside it. On a Mac it\'s Library/Application Support/MobileSync/Backup in your user folder. On Windows it\'s usually Apple/MobileSync/Backup in your user folder, or AppData/Roaming/Apple Computer/MobileSync/Backup.',
  },
];

module.exports = { KNOWN_FIXES };
