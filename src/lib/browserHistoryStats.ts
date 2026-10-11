/**
 * Shared types and stat computation for browser history.
 */

/** Browser keys the sidecar can report. Keep in sync with ios-backup-core's BrowserHistoryExtractor.BROWSERS. */
export type BrowserKey = 'safari' | 'firefox' | 'chrome' | 'edge' | 'brave';

/** Display order for filters and legends. */
export const BROWSER_ORDER: BrowserKey[] = ['safari', 'chrome', 'firefox', 'edge', 'brave'];

const BROWSER_LABELS: Record<BrowserKey, string> = {
  safari: 'Safari',
  firefox: 'Firefox',
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
};

/** Chart/legend colors per browser. */
export const BROWSER_COLORS: Record<BrowserKey, string> = {
  safari: '#3b82f6',
  firefox: '#f97316',
  chrome: '#16a34a',
  edge: '#0891b2',
  brave: '#e11d48',
};

/** Tailwind classes for the small browser badge in tables. */
export const BROWSER_BADGE_CLASSES: Record<BrowserKey, string> = {
  safari: 'bg-blue-50 text-blue-600',
  firefox: 'bg-orange-50 text-orange-600',
  chrome: 'bg-green-50 text-green-700',
  edge: 'bg-cyan-50 text-cyan-700',
  brave: 'bg-rose-50 text-rose-600',
};

export function browserLabel(browser: string): string {
  return BROWSER_LABELS[browser as BrowserKey] ?? browser.charAt(0).toUpperCase() + browser.slice(1);
}

export interface HistoryVisit {
  visit_id: string;
  url: string;
  title: string;
  domain: string;
  visit_date: string | null;
  browser: BrowserKey;
  visit_count: number | null;
}

/** A browser whose history database was found but couldn't be read. */
export interface BrowserHistoryError {
  browser: string;
  message: string;
}

export interface BrowserHistoryStats {
  totalVisits: number;
  uniqueDomains: number;
  dateRange: { earliest: string; latest: string } | null;
  browsersFound: string[];
  /** Visits per YYYY-MM-DD, last 90 days, sorted ascending */
  activityByDay: { date: string; count: number }[];
  /** Top 15 domains by visit count, descending */
  topDomains: { domain: string; count: number }[];
  /** 24 entries, one per hour 0-23 */
  hourDistribution: { hour: number; label: string; count: number }[];
  /** Per-browser totals */
  browserBreakdown: { browser: string; count: number; pct: number }[];
  /** 7 entries Sun=0 through Sat=6 */
  dayOfWeekDistribution: { day: number; label: string; count: number }[];
  /** Index 0-23 of the peak hour */
  peakHour: number;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatHourLabel(h: number): string {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

export function computeBrowserStats(visits: HistoryVisit[]): BrowserHistoryStats {
  const domainCounts = new Map<string, number>();
  const browserCounts = new Map<string, number>();
  const dateCounts = new Map<string, number>();
  const hourCounts = new Array(24).fill(0);
  const dowCounts = new Array(7).fill(0);
  const browserSet = new Set<string>();

  let earliest: string | null = null;
  let latest: string | null = null;

  for (const v of visits) {
    // domain
    if (v.domain) {
      domainCounts.set(v.domain, (domainCounts.get(v.domain) ?? 0) + 1);
    }

    // browser
    if (v.browser) {
      browserCounts.set(v.browser, (browserCounts.get(v.browser) ?? 0) + 1);
      browserSet.add(v.browser);
    }

    // time-based (skip null dates)
    if (v.visit_date) {
      const dateStr = v.visit_date.slice(0, 10); // YYYY-MM-DD
      dateCounts.set(dateStr, (dateCounts.get(dateStr) ?? 0) + 1);

      if (!earliest || v.visit_date < earliest) earliest = v.visit_date;
      if (!latest || v.visit_date > latest) latest = v.visit_date;

      try {
        const d = new Date(v.visit_date);
        hourCounts[d.getHours()]++;
        dowCounts[d.getDay()]++;
      } catch {
        // ignore parse errors
      }
    }
  }

  // activityByDay: last 90 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const activityByDay = Array.from(dateCounts.entries())
    .filter(([date]) => date >= cutoffStr)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  // topDomains: top 15
  const topDomains = Array.from(domainCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([domain, count]) => ({ domain, count }));

  // hourDistribution
  const hourDistribution = hourCounts.map((count, hour) => ({
    hour,
    label: formatHourLabel(hour),
    count,
  }));

  // peakHour
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  // browserBreakdown with percentages
  const total = visits.length;
  const browserBreakdown = Array.from(browserCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([browser, count]) => ({
      browser,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
    }));

  // dayOfWeekDistribution
  const dayOfWeekDistribution = dowCounts.map((count, day) => ({
    day,
    label: DAY_LABELS[day],
    count,
  }));

  return {
    totalVisits: visits.length,
    uniqueDomains: domainCounts.size,
    dateRange: earliest && latest ? { earliest, latest } : null,
    browsersFound: Array.from(browserSet),
    activityByDay,
    topDomains,
    hourDistribution,
    browserBreakdown,
    dayOfWeekDistribution,
    peakHour,
  };
}
