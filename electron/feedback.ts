export {};
const os = require('os');
const fs = require('fs');

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
 */
export function extractLogExcerpt(logText: string): string {
  const entries: string[][] = [];
  for (const line of logText.split(/\r?\n/)) {
    if (line.startsWith('[')) entries.push([line]);
    else if (entries.length && line.trim()) entries[entries.length - 1].push(line);
  }

  const wanted: string[][] = [];
  entries.forEach((entry, i) => {
    const head = entry[0];
    if (head.startsWith('[RPC ERROR]') || head.startsWith('[ERROR STARTING]')) {
      wanted.push(entry);
      return;
    }
    // "[EXIT] code null" / "code 0" is a normal quit; anything else is a crash.
    const exit = head.match(/^\[EXIT\] code (\S+)/);
    if (!exit || exit[1] === 'null' || exit[1] === '0') return;
    // A crash before the engine could answer (e.g. a missing module) only leaves its
    // traceback on stderr. Keep the stderr lines just before the exit, but only when
    // they are a traceback, since stderr otherwise carries stray prints.
    let start = i;
    while (start > 0 && entries[start - 1][0].startsWith('[STDERR]')) start -= 1;
    const stderr = entries.slice(start, i).flat();
    const tb = stderr.findIndex(l => l.includes('Traceback (most recent call last)'));
    if (tb >= 0) wanted.push([...stderr.slice(tb), head]);
    else wanted.push(entry);
  });

  return wanted.slice(-MAX_LOG_ENTRIES).map(lines => {
    if (lines.length <= MAX_LINES_PER_ENTRY) return lines.join('\n');
    // Keep the header and the end of the traceback, where the actual error is.
    return [lines[0], '  …', ...lines.slice(-(MAX_LINES_PER_ENTRY - 2))].join('\n');
  }).join('\n\n');
}

function readLogTail(logPath: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf-8');
    // Drop the partial first line when we started mid-file.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export class FeedbackRecorder {
  private failures: RecentFailure[] = [];
  private outcomes = new Map<string, 'ok' | 'failed'>();
  private backup: BackupFacts | null = null;
  private secrets = new Map<string, string>();

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
      };
      this.outcomes.clear();
    }
    if (method === 'list_backups' && outcome.ok && Array.isArray(outcome.result?.backups)) {
      for (const b of outcome.result.backups) {
        this.addSecret(b?.device_name, '<device name>');
        this.addSecret(b?.udid, '<udid>');
        this.addSecret(b?.backup_dir, '<backup folder>');
      }
    }

    // Some extractors return { error } inside a successful result. An empty_reason
    // means the data is legitimately absent (e.g. needs an encrypted backup), not a bug.
    let error: string | null = outcome.ok ? null : outcome.error;
    if (outcome.ok && outcome.result && typeof outcome.result === 'object'
        && typeof outcome.result.error === 'string' && outcome.result.error && !outcome.result.empty_reason) {
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
      logExcerpt: scrub(extractLogExcerpt(readLogTail(this.logPath))),
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
