export {};

/**
 * Sends feedback reports to openextract.app, and later asks whether they've
 * been fixed so the app can say so. The website side is website/static/api/.
 *
 * Privacy rules (the privacy page describes these):
 *  - A report leaves the computer only when the user clicks Send. It holds what
 *    the form showed them, plus a random code that lets this computer, and
 *    nobody else, look the report up later.
 *  - Follow-up checks send only the report number and that code, at most every
 *    few days, and only while a report is still open (for up to six months).
 */

const SITE = 'https://www.openextract.app';
const REQUEST_TIMEOUT_MS = 20_000;
const CHECK_EVERY_MS = 3 * 24 * 60 * 60 * 1000;
const FOLLOW_UP_FOR_MS = 183 * 24 * 60 * 60 * 1000;
const MAX_KEPT = 20;
const MAX_CHECKS_PER_RUN = 10;

export interface ReportInput {
  kind: string;
  area: string;
  details: string;
  diagnostics: string;
  email?: string;
  /** Random hex made once per form, so a retry of the same report isn't filed twice. */
  token: string;
}

export interface KnownFix {
  id: string;
  title: string;
  text: string;
  url?: string;
}

export type SendResult =
  | { ok: true; reference: string; knownFixes: KnownFix[] }
  | { ok: false; error: string };

interface TrackedReport {
  number: number;
  reference: string;
  token: string;
  /** First line of what the user wrote, so the "fixed" note can say which report. */
  summary: string;
  sentAt: string;
  status: 'open' | 'fixed' | 'closed';
  fixedIn?: string;
  announced?: boolean;
}

export interface FixedReport {
  reference: string;
  summary: string;
  sentAt: string;
  fixedIn?: string;
  /** The running version already has the fix. */
  inThisVersion: boolean;
}

interface Store {
  get(key: string, fallback?: any): any;
  set(key: string, value: any): void;
}

type Fetch = (url: string, init: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const OFFLINE = "Couldn't reach openextract.app. Check your internet connection and try again, or copy the report to send later.";
const UNAVAILABLE = "The report couldn't be sent right now. Try again later, copy the report, or post it on GitHub instead.";

/** -1, 0 or 1, comparing dotted version numbers ("0.9.10" is newer than "0.9.2"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function summaryOf(details: string): string {
  const first = details.trim().split('\n')[0].replace(/\s+/g, ' ');
  return first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first;
}

function asKnownFixes(value: unknown): KnownFix[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(f => f && typeof f.title === 'string' && typeof f.text === 'string')
    .slice(0, 3)
    .map(f => ({
      id: String(f.id ?? ''),
      title: f.title,
      text: f.text,
      // Only links to pages we'd send people to anyway.
      ...(typeof f.url === 'string' && /^https:\/\/(www\.openextract\.app|github\.com\/charleswest775|support\.apple\.com)\//.test(f.url)
        ? { url: f.url } : {}),
    }));
}

export class FeedbackReports {
  constructor(
    private store: Store,
    private fetchFn: Fetch,
    private appVersion: string,
    private site: string = SITE,
  ) {}

  private reports(): TrackedReport[] {
    const saved = this.store.get('feedbackReports', []);
    return Array.isArray(saved) ? saved : [];
  }

  private async post(path: string, payload: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchFn(`${this.site}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async send(input: ReportInput): Promise<SendResult> {
    const email = String(input.email ?? '').trim();
    const payload = {
      kind: String(input.kind ?? ''),
      area: String(input.area ?? ''),
      details: String(input.details ?? ''),
      diagnostics: String(input.diagnostics ?? ''),
      ...(email ? { email } : {}),
      token: String(input.token ?? ''),
    };

    let res;
    try {
      res = await this.post('/api/feedback', payload);
    } catch {
      return { ok: false, error: OFFLINE };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !Number.isInteger(body?.number)) {
      // The site's own messages (a bad email, too long, too many reports) are written for users.
      const message = typeof body?.error === 'string' && [400, 429].includes(res.status) ? body.error.slice(0, 300) : UNAVAILABLE;
      return { ok: false, error: message };
    }

    const reference = typeof body.reference === 'string' ? body.reference : `OE-${body.number}`;
    const now = new Date().toISOString();
    const kept = this.reports().filter(r => r.number !== body.number);
    kept.push({
      number: body.number,
      reference,
      token: payload.token,
      summary: summaryOf(payload.details),
      sentAt: now,
      status: 'open',
    });
    this.store.set('feedbackReports', kept.slice(-MAX_KEPT));
    // Remembered on this computer only, to fill in the form next time.
    this.store.set('feedbackEmail', email);
    // The first follow-up waits a few days; nothing will have changed sooner.
    this.store.set('feedbackLastCheck', Date.now());

    return { ok: true, reference, knownFixes: asKnownFixes(body.knownFixes) };
  }

  /**
   * Asks about reports that are still open, if a check is due. Returns true when
   * one turned out to be fixed. Network failures are ignored until the next check.
   */
  async checkIfDue(now = Date.now()): Promise<boolean> {
    const reports = this.reports();
    const open = reports.filter(r => r.status === 'open' && now - Date.parse(r.sentAt) < FOLLOW_UP_FOR_MS);
    if (!open.length) return false;
    const last = Number(this.store.get('feedbackLastCheck', 0)) || 0;
    if (now - last < CHECK_EVERY_MS) return false;
    this.store.set('feedbackLastCheck', now);

    let changed = false;
    let fixed = false;
    for (const r of open.slice(-MAX_CHECKS_PER_RUN)) {
      let res;
      try {
        res = await this.post('/api/feedback-status', { number: r.number, token: r.token });
      } catch {
        break;
      }
      if (res.status === 404) {
        // Deleted, or moved somewhere this code doesn't reach: nothing more to hear about.
        r.status = 'closed';
        changed = true;
        continue;
      }
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      if (body?.status === 'fixed') {
        r.status = 'fixed';
        if (typeof body.fixedIn === 'string' && /^\d+(\.\d+){1,3}$/.test(body.fixedIn)) r.fixedIn = body.fixedIn;
        changed = fixed = true;
      } else if (body?.status === 'closed') {
        r.status = 'closed';
        changed = true;
      }
    }
    if (changed) this.store.set('feedbackReports', reports);
    return fixed;
  }

  /** Fixed reports the user hasn't been told about yet. */
  fixedToAnnounce(): FixedReport[] {
    return this.reports()
      .filter(r => r.status === 'fixed' && !r.announced)
      .map(r => ({
        reference: r.reference,
        summary: r.summary,
        sentAt: r.sentAt,
        fixedIn: r.fixedIn,
        inThisVersion: !r.fixedIn || compareVersions(this.appVersion, r.fixedIn) >= 0,
      }));
  }

  markAnnounced(reference: string) {
    const reports = this.reports();
    for (const r of reports) if (r.reference === reference) r.announced = true;
    this.store.set('feedbackReports', reports);
  }
}
