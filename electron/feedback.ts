export {};
const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Facts for the in-app feedback form. Everything here stays in memory until
 * the user opens the form, sees it, edits it, and clicks Send
 * (feedbackReports.ts). Nothing is sent otherwise.
 *
 * Nothing from inside a backup is kept: no message text, contact names,
 * file paths or device names. Error messages and log lines can still mention
 * those, so they go through scrubText() before the renderer sees them.
 */

export interface BackupFacts {
  /** Hardware model, e.g. "iPhone14,2". Not the user's name for the phone. */
  model?: string;
  iosVersion?: string;
  encrypted?: boolean;
  sizeGB?: number | null;
  /** The backup stopped partway (OE-31), so sections may fail for that reason alone. */
  unfinished?: boolean;
  /** How many files the backup lists aren't in its folder (OE-102), from check_backup_files. */
  missingFiles?: number;
}

export interface RecentFailure {
  at: string;
  method: string;
  message: string;
  count: number;
}

export interface FeedbackDiagnostics {
  appVersion: string;
  os: string;
  backup: BackupFacts | null;
  /** Engine calls made for the open backup, by outcome (names only). */
  loaded: string[];
  failed: string[];
  recentErrors: RecentFailure[];
  logExcerpt: string;
  /** The error the user clicked "Report this problem" on, scrubbed. */
  reportedError?: string;
}

// Params that carry folders the user chose; their values are scrubbed if they show up in errors.
const FOLDER_PARAMS = ['backup_dir', 'path', 'output_dir', 'output_path', 'dest_dir', 'export_dir'];
const MAX_FAILURES = 15;
const LOG_TAIL_BYTES = 256 * 1024;
const MAX_LOG_ENTRIES = 4;
const MAX_LINES_PER_ENTRY = 18;

// The engine log is kept one file per time the app is opened: python_log.txt for this
// time, python_log.previous.txt for the time before, and nothing older. Each starts with
// a line saying which version opened it and when:
//   [START] OpenExtract 0.17.1 at 2026-11-19T08:40:02Z
// That line stays in the log. A report says only which of the two times an error is from.
// (The "at" keeps scrubText from taking the version and the date for one long number, a
// phone number, should the line ever be put through it.)
// A report takes errors from this time and, if the same version wrote it, the time
// before: a crash that made someone reopen the app is in that one. The log used to be
// one file that only grew, and a report took the last few errors in it, whoever wrote
// them: a report about a video sent from 0.17.0 carried errors from 0.15.0 and 0.14.0
// (#298), which misled the reply and can bring up the known fix for a problem long gone.
const SESSION_MARK = /^\[START\] OpenExtract (\S+) at \S+$/;
const SESSION_MARK_MAX_BYTES = 256;
// Above the errors in a report, when some are from the time before.
const LOG_LAST_TIME = 'The last time OpenExtract was open:';
const LOG_THIS_TIME = 'This time:';

/** The line that starts a time the app was opened, in the engine log. */
export function sessionMark(appVersion: string, now: Date): string {
  return `[START] OpenExtract ${appVersion} at ${now.toISOString().replace(/\.\d+Z$/, 'Z')}`;
}

/** Where the log of the time before is kept: python_log.txt's is python_log.previous.txt. */
export function previousLogPath(logPath: string): string {
  const ext = path.extname(logPath);
  return `${logPath.slice(0, logPath.length - ext.length)}.previous${ext}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The same path written with \, \\ (as in JSON or repr) and /. */
function pathVariants(p: string): string[] {
  const forward = p.replace(/\\/g, '/');
  const back = p.replace(/\//g, '\\');
  return Array.from(new Set([p, forward, back, back.replace(/\\/g, '\\\\')]));
}

/** Long digit runs that look like phone numbers, but not dates, times or sizes. */
function scrubPhoneNumbers(text: string): string {
  return text.replace(/(?<![\w.:/-])\+?\d[\d ().-]{7,}\d(?![\w.:/])/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return match;
    if (/\d{4}-\d{2}-\d{2}/.test(match) || /\d{1,2}:\d{2}/.test(match)) return match;
    // A bare run of digits with no separators and no + is more often an id or a byte count.
    if (/^\d+$/.test(match) && digits.length > 11) return match;
    return '<phone>';
  });
}

/**
 * Remove personal details from text the user is about to see in the feedback
 * form. `secrets` maps literal strings (home folder, device name, …) to the
 * placeholder that replaces them. Longest first, so a backup folder inside the
 * home folder becomes <backup folder>, not ~/….
 */
export function scrubText(text: string, secrets: Map<string, string>): string {
  if (!text) return '';
  let out = String(text);

  const literals = Array.from(secrets.entries())
    .flatMap(([value, token]) => pathVariants(value).map(v => [v, token] as const))
    .filter(([value]) => value.length >= 3)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [value, token] of literals) {
    // Whole words for short values like a username, anywhere for paths.
    const pattern = /[\\/]/.test(value) || value.length > 12
      ? escapeRegExp(value)
      : `(?<![\\w])${escapeRegExp(value)}(?![\\w])`;
    out = out.replace(new RegExp(pattern, 'gi'), token);
  }

  out = out
    // Other people's home folders (a backup copied from another computer).
    .replace(/(?:[A-Za-z]:)?(?:\\\\|[\\/])(?:Users|home)(?:\\\\|[\\/])[^\\/\s'"<>]+/g, '~')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    // Device UDIDs: 40 hex chars (older) or 8-16 hex (newer). Also catches backup file hashes.
    .replace(/\b[0-9a-f]{40}\b/gi, '<udid>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{16}\b/gi, '<udid>');

  return scrubPhoneNumbers(out);
}

/**
 * The engine log mixes timings, stray prints and errors. Only error entries
 * (tracebacks, failed starts, crashes) are worth sending, and stray prints can
 * contain backup content, so everything else is left out.
 *
 * `logText` may hold more than one time the app was opened, each under its
 * "[START] …" line, the last being this time. When an error that is kept is from
 * an earlier one, the errors are put under "The last time OpenExtract was open:" and
 * "This time:", so whoever reads the report can tell which is which. The "[START] …"
 * lines themselves, with their dates, are not sent.
 */
export function extractLogExcerpt(logText: string): string {
  const entries: string[][] = [];
  for (const line of logText.split(/\r?\n/)) {
    // The packaged engine's bootloader writes "[PYI-1234:ERROR] ..." to stderr, often
    // in the same chunk as the traceback before it, so it continues that [STDERR] entry.
    if (line.startsWith('[') && !line.startsWith('[PYI-')) entries.push([line]);
    else if (entries.length && line.trim()) entries[entries.length - 1].push(line);
  }

  // `session` counts the "[START] …" lines so far: which time the app was opened. (Not the
  // line's text: two times in one second would read the same.)
  const wanted: { lines: string[]; session: number }[] = [];
  let session = 0;
  entries.forEach((entry, i) => {
    const head = entry[0];
    if (SESSION_MARK.test(head)) {
      session += 1;
      return;
    }
    if (head.startsWith('[RPC ERROR]') || head.startsWith('[ERROR STARTING]')) {
      wanted.push({ lines: entry, session });
      return;
    }
    // "[EXIT] code null" / "code 0" is a normal quit; anything else is a crash.
    const exit = head.match(/^\[EXIT\] code (\S+)/);
    if (!exit || exit[1] === 'null' || exit[1] === '0') return;
    // A crash before the engine could answer (e.g. a missing module) only leaves its
    // traceback on stderr. Keep the stderr lines just before the exit, but only when
    // they are a traceback or the bootloader's own errors (it failed before Python
    // ran), since stderr otherwise carries stray prints.
    let start = i;
    while (start > 0 && entries[start - 1][0].startsWith('[STDERR]')) start -= 1;
    const stderr = entries.slice(start, i).flat();
    let from = stderr.findIndex(l => l.includes('Traceback (most recent call last)'));
    if (from < 0) from = stderr.findIndex(l => /\[PYI-\d+:ERROR\]/.test(l));
    if (from >= 0) wanted.push({ lines: [...stderr.slice(from), head], session });
    else wanted.push({ lines: entry, session });
  });

  const kept = wanted.slice(-MAX_LOG_ENTRIES);
  // `session` is now the last time in the log: this time.
  const someFromBefore = kept.some(e => e.session !== session);
  let saidThisTime: boolean | null = null;
  return kept.map(({ lines, session: openedAt }) => {
    // Keep the header and the end of the traceback, where the actual error is.
    const shown = lines.length <= MAX_LINES_PER_ENTRY
      ? lines
      : [lines[0], '  …', ...lines.slice(-(MAX_LINES_PER_ENTRY - 2))];
    const thisTime = openedAt === session;
    const above = someFromBefore && thisTime !== saidThisTime ? [thisTime ? LOG_THIS_TIME : LOG_LAST_TIME] : [];
    saidThisTime = thisTime;
    return [...above, ...shown].join('\n');
  }).join('\n\n');
}

/**
 * The end of a log file, from byte `from` on (where this time's entries start, when an
 * older log couldn't be moved out of the way). '' if it can't be read.
 */
function readLogTail(logPath: string, from = 0): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    // Shorter than where this time started: something replaced the file since, so all
    // of it was written this time.
    if (from > size) from = 0;
    const start = Math.max(from, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf-8');
    // Drop the partial first line when we started partway through this time's entries.
    if (start > from) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** The "[START] …" line a log file begins with, or null if it has none (a log from before these lines). */
function firstSessionMark(logPath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(SESSION_MARK_MAX_BYTES);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.toString('utf-8', 0, read).split(/\r?\n/)[0];
    return SESSION_MARK.test(line) ? line : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** The end of one time's log, under its "[START] …" line even when that line is too far back to be read with it. */
function underItsMark(mark: string, text: string): string {
  return text.split(/\r?\n/).includes(mark) ? text : `${mark}\n${text}`;
}

export class FeedbackRecorder {
  private failures: RecentFailure[] = [];
  private outcomes = new Map<string, 'ok' | 'failed'>();
  private backup: BackupFacts | null = null;
  private secrets = new Map<string, string>();
  /** Where this time's entries start in the log: 0 unless an older log couldn't be moved out of the way. */
  private sessionStart = 0;
  /** This time's "[START] …" line, once beginSession() has written it. */
  private sessionMark: string | null = null;
  /** The log of the time before, when beginSession() moved it there. */
  private previousLog: string | null = null;

  constructor(private logPath: string, private appVersion: string) {
    const home = os.homedir();
    if (home) this.secrets.set(home, '~');
    try {
      const user = os.userInfo().username;
      if (user) this.secrets.set(user, '<user>');
    } catch {
      // No user info (some sandboxes): the home folder rule still applies.
    }
  }

  /**
   * Call once as the app starts, before the engine does and writes to the log. The log
   * of the time before is moved aside (replacing the one before that, so two are kept
   * and the log can't grow without end), and this time's begins with its "[START] …" line.
   *
   * If the old log can't be moved (another OpenExtract has it open, or the folder can't
   * be written), this time's entries go after it in the same file and are told apart by
   * where they start.
   */
  beginSession(now: Date = new Date()): void {
    const previous = previousLogPath(this.logPath);
    this.previousLog = null;
    this.sessionStart = 0;
    try {
      if (fs.existsSync(this.logPath)) {
        fs.renameSync(this.logPath, previous);
        this.previousLog = previous;
      } else {
        // No log of the time before: what is there is older than that.
        fs.rmSync(previous, { force: true });
      }
    } catch {
      // Left where it is: see sessionStart.
    }
    this.sessionMark = sessionMark(this.appVersion, now);
    try {
      this.sessionStart = fs.existsSync(this.logPath) ? fs.statSync(this.logPath).size : 0;
      // An older log's last line may have been cut short when its engine was stopped.
      fs.appendFileSync(this.logPath, `${this.sessionStart ? '\n' : ''}${this.sessionMark}\n`);
    } catch {
      // A log that can't be written to has nothing in it to send either.
    }
  }

  /** The engine log a report draws on: the time before (if this version wrote it), then this time. */
  private recentLog(): string {
    const parts: string[] = [];
    if (this.previousLog) {
      const mark = firstSessionMark(this.previousLog);
      if (mark && mark.match(SESSION_MARK)?.[1] === this.appVersion) {
        parts.push(underItsMark(mark, readLogTail(this.previousLog)));
      }
    }
    const current = readLogTail(this.logPath, this.sessionStart);
    parts.push(this.sessionMark ? underItsMark(this.sessionMark, current) : current);
    return parts.join('\n');
  }

  private addSecret(value: unknown, token: string) {
    if (typeof value === 'string' && value.trim().length >= 4) this.secrets.set(value.trim(), token);
  }

  /** Called by the sidecar bridge after every engine call. Params are read for folders and ids only, never stored. */
  recordCall(method: string, params: any, outcome: { ok: true; result: any } | { ok: false; error: string }) {
    for (const key of FOLDER_PARAMS) this.addSecret(params?.[key], key === 'backup_dir' ? '<backup folder>' : '<folder>');
    this.addSecret(params?.udid, '<udid>');

    if (method === 'open_backup' && outcome.ok && outcome.result?.info) {
      const info = outcome.result.info;
      this.addSecret(info.device_name, '<device name>');
      this.addSecret(info.backup_dir, '<backup folder>');
      this.addSecret(info.udid, '<udid>');
      this.backup = {
        model: typeof info.product_type === 'string' ? info.product_type : undefined,
        iosVersion: typeof info.product_version === 'string' ? info.product_version : undefined,
        encrypted: typeof info.encrypted === 'boolean' ? info.encrypted : undefined,
        sizeGB: typeof info.size_gb === 'number' ? Math.round(info.size_gb * 10) / 10 : null,
        ...(info.unfinished === true ? { unfinished: true } : {}),
      };
      this.outcomes.clear();
    }
    if (method === 'check_backup_files' && outcome.ok && this.backup
        && typeof outcome.result?.missing === 'number' && outcome.result.missing > 0) {
      this.backup.missingFiles = outcome.result.missing;
    }
    if (method === 'list_backups' && outcome.ok && Array.isArray(outcome.result?.backups)) {
      for (const b of outcome.result.backups) {
        this.addSecret(b?.device_name, '<device name>');
        this.addSecret(b?.udid, '<udid>');
        this.addSecret(b?.backup_dir, '<backup folder>');
      }
    }

    // Some extractors return { error } inside a successful result. An empty_reason
    // means the data is legitimately absent (e.g. needs an encrypted backup), not a bug;
    // so does is_video from get_photo_thumbnail (a video has no thumbnail).
    let error: string | null = outcome.ok ? null : outcome.error;
    if (outcome.ok && outcome.result && typeof outcome.result === 'object'
        && typeof outcome.result.error === 'string' && outcome.result.error
        && !outcome.result.empty_reason && !outcome.result.is_video) {
      error = outcome.result.error;
    }

    this.outcomes.set(method, error ? 'failed' : 'ok');
    if (!error) return;

    const last = this.failures[this.failures.length - 1];
    if (last && last.method === method && last.message === error) {
      last.count += 1;
      last.at = new Date().toISOString();
      return;
    }
    this.failures.push({ at: new Date().toISOString(), method, message: error, count: 1 });
    if (this.failures.length > MAX_FAILURES) this.failures.shift();
  }

  diagnostics(reportedError?: string): FeedbackDiagnostics {
    const scrub = (s: string) => scrubText(s, this.secrets);
    const byOutcome = (want: 'ok' | 'failed') =>
      Array.from(this.outcomes.entries()).filter(([, o]) => o === want).map(([m]) => m).sort();

    return {
      appVersion: this.appVersion,
      os: `${osName()} ${systemVersion()} (${process.arch})`,
      backup: this.backup ? { ...this.backup } : null,
      loaded: byOutcome('ok'),
      failed: byOutcome('failed'),
      recentErrors: this.failures.map(f => ({ ...f, message: scrub(f.message) })),
      logExcerpt: scrub(extractLogExcerpt(this.recentLog())),
      reportedError: reportedError ? scrub(String(reportedError)).slice(0, 2000) : undefined,
    };
  }
}

/** macOS/Windows version as users know it (os.release() is the Darwin kernel version on a Mac). */
function systemVersion(): string {
  try {
    const v = (process as any).getSystemVersion?.();
    if (v) return String(v);
  } catch {
    // Not running under Electron (tests).
  }
  return os.release();
}

function osName(): string {
  switch (process.platform) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return process.platform;
  }
}
