import type { FeedbackDiagnostics } from '../types';

/**
 * Builds the feedback report. The form sends it to openextract.app
 * (electron/feedbackReports.ts → website/static/api/), or, if that fails, opens
 * it as a public GitHub issue in the user's browser. Either way the user sees the
 * full text in the form and can edit it first.
 *
 * The site's API (website/static/api/_lib/feedback.js), the GitHub issue form
 * (.github/ISSUE_TEMPLATE/in_app_feedback.yml) and the labelling workflow
 * (.github/workflows/feedback-labels.yml) use the kind/area ids and labels
 * below, so keep them in step (scripts/feedback.test.mjs checks).
 */

export const FEEDBACK_REPO = 'charleswest775/openextract';
export const FEEDBACK_TEMPLATE = 'in_app_feedback.yml';
export const PRIVACY_URL = 'https://www.openextract.app/privacy#feedback';

/** Random code the site keeps a hash of, so only this computer can look the report up later. */
export function newReportToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export type FeedbackKind = 'broken' | 'missing' | 'idea' | 'other';

export const FEEDBACK_KINDS: { id: FeedbackKind; label: string; hint: string }[] = [
  { id: 'broken', label: "Something's broken", hint: 'An error, a crash, or a button that does nothing' },
  { id: 'missing', label: 'Something in my backup is missing or wrong', hint: "Data you expected isn't there, or an export came out wrong" },
  { id: 'idea', label: 'An idea or request', hint: 'Something OpenExtract should do' },
  { id: 'other', label: 'Something else', hint: 'A question, or just telling us how it went' },
];

export type FeedbackArea =
  | 'general' | 'open_backup' | 'create_backup' | 'search' | 'dashboard' | 'people' | 'timeline' | 'year'
  | 'messages' | 'photos' | 'contacts' | 'calls' | 'notes' | 'voicemail' | 'browser_history' | 'record_recovery'
  | 'export';

export const FEEDBACK_AREAS: { id: FeedbackArea; label: string }[] = [
  { id: 'general', label: 'The app in general' },
  { id: 'open_backup', label: 'Opening a backup' },
  { id: 'create_backup', label: 'Making a backup' },
  { id: 'search', label: 'Search' },
  { id: 'dashboard', label: 'Backup details' },
  { id: 'people', label: 'People' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'year', label: 'Year' },
  { id: 'messages', label: 'Messages' },
  { id: 'photos', label: 'Photos' },
  { id: 'contacts', label: 'Address book' },
  { id: 'calls', label: 'Calls' },
  { id: 'notes', label: 'Notes' },
  { id: 'voicemail', label: 'Voicemail' },
  { id: 'browser_history', label: 'Web history' },
  { id: 'record_recovery', label: 'Recovering deleted messages' },
  { id: 'export', label: 'Exporting' },
];

export interface FeedbackRequest {
  kind?: FeedbackKind;
  area?: FeedbackArea;
  /** Error text to report; it is scrubbed by the main process before it's shown. */
  error?: string;
}

export interface FeedbackForm {
  kind: FeedbackKind;
  area: FeedbackArea;
  details: string;
  /** The diagnostics text as the user left it after reviewing/editing. */
  diagnostics: string;
}

// GitHub rejects issue URLs much over 8 KB.
export const GITHUB_URL_BUDGET = 7500;
export const SHORTENED_NOTE = '\n\n(Shortened to fit. The full report is on your clipboard; paste it here to include the rest.)';

export function kindLabel(kind: FeedbackKind): string {
  return FEEDBACK_KINDS.find(k => k.id === kind)?.label ?? kind;
}

export function areaLabel(area: FeedbackArea): string {
  return FEEDBACK_AREAS.find(a => a.id === area)?.label ?? area;
}

function fence(text: string): string {
  // A ``` inside the text would close the block early.
  return '```\n' + text.replace(/```/g, "'''").trim() + '\n```';
}

/** Diagnostics as Markdown. Shown to the user in an editable box before anything leaves the app. */
export function formatDiagnostics(d: FeedbackDiagnostics): string {
  const lines: string[] = [];
  lines.push(`App: OpenExtract ${d.appVersion} on ${d.os}`);

  if (d.backup) {
    const b = d.backup;
    const parts = [
      b.model,
      b.iosVersion ? `iOS ${b.iosVersion}` : undefined,
      b.encrypted === undefined ? undefined : b.encrypted ? 'encrypted' : 'not encrypted',
      typeof b.sizeGB === 'number' ? `${b.sizeGB} GB` : undefined,
    ].filter(Boolean);
    lines.push(`Backup: ${parts.join(' · ') || 'details unknown'}`);
  } else {
    lines.push('Backup: none open');
  }
  if (d.loaded.length) lines.push(`Loaded OK: ${d.loaded.join(', ')}`);
  if (d.failed.length) lines.push(`Failed: ${d.failed.join(', ')}`);

  if (d.reportedError) {
    lines.push('', 'Error shown:', fence(d.reportedError));
  }

  if (d.recentErrors.length) {
    lines.push('', 'Recent errors:');
    for (const e of d.recentErrors.slice(-8)) {
      const time = e.at.slice(11, 19);
      const times = e.count > 1 ? ` (×${e.count})` : '';
      lines.push(`- ${time} ${e.method}${times}: ${e.message.split('\n')[0].slice(0, 300)}`);
    }
  }

  if (d.logExcerpt.trim()) {
    lines.push('', 'Engine log (errors only):', fence(d.logExcerpt));
  }

  return lines.join('\n');
}

/** Issue title: area plus the start of what the user wrote, so the issue list is scannable. */
export function issueTitle(form: Pick<FeedbackForm, 'area' | 'details' | 'kind'>): string {
  const first = form.details.trim().split('\n')[0].replace(/\s+/g, ' ');
  const summary = first.length > 70 ? `${first.slice(0, 67).trimEnd()}…` : first;
  return `[Feedback] ${areaLabel(form.area)}: ${summary || kindLabel(form.kind)}`;
}

/**
 * Cut `text` (at a line break where possible) until `build(text)` fits in
 * `budget`. The diagnostics are ordered most useful first, so the log goes first.
 */
function fitToBudget(text: string, budget: number, build: (t: string) => string): { text: string; shortened: boolean } {
  if (build(text).length <= budget) return { text, shortened: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(text.slice(0, mid) + SHORTENED_NOTE).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = text.slice(0, lo);
  const nl = cut.lastIndexOf('\n');
  if (nl > lo * 0.6) cut = cut.slice(0, nl);
  // Don't leave a code block open, and re-check the budget with the closing fence added.
  const closeFence = (t: string) => ((t.match(/```/g) || []).length % 2 === 1 ? `${t}\n\`\`\`` : t);
  while (cut && build(closeFence(cut) + SHORTENED_NOTE).length > budget) cut = cut.slice(0, -50);
  return { text: closeFence(cut) + SHORTENED_NOTE, shortened: true };
}

/** The full report, put on the clipboard so nothing is lost if the link is shortened. */
export function fullReport(form: FeedbackForm): string {
  return [
    `Type: ${kindLabel(form.kind)}`,
    `Part of the app: ${areaLabel(form.area)}`,
    '',
    'What happened:',
    form.details.trim() || '(not filled in)',
    '',
    '--- Diagnostics ---',
    form.diagnostics.trim() || '(removed by the sender)',
  ].join('\n');
}

export function githubIssueUrl(form: FeedbackForm): { url: string; shortened: boolean } {
  const build = (diagnostics: string, details = form.details) => {
    const params = new URLSearchParams({
      template: FEEDBACK_TEMPLATE,
      title: issueTitle(form),
      kind: kindLabel(form.kind),
      area: areaLabel(form.area),
      details,
      diagnostics,
    });
    return `https://github.com/${FEEDBACK_REPO}/issues/new?${params.toString()}`;
  };
  const fitted = fitToBudget(form.diagnostics, GITHUB_URL_BUDGET, d => build(d));
  if (build(fitted.text).length <= GITHUB_URL_BUDGET) return { url: build(fitted.text), shortened: fitted.shortened };
  // Very long description: shorten that too. The clipboard still has all of it.
  const details = fitToBudget(form.details, GITHUB_URL_BUDGET, t => build(SHORTENED_NOTE.trim(), t));
  return { url: build(SHORTENED_NOTE.trim(), details.text), shortened: true };
}
