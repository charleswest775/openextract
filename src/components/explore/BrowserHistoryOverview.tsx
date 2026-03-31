import { useMemo } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { formatDate } from '../../lib/dates';
import { computeBrowserStats, type HistoryVisit } from '../../lib/browserHistoryStats';

interface Props {
  visits: HistoryVisit[];
  onSelectDomain: (domain: string) => void;
  onSelectDate: (date: string) => void;
  onViewAll: () => void;
}

const BROWSER_COLORS: Record<string, string> = {
  safari: '#3b82f6',
  firefox: '#f97316',
};

const PEAK_COLOR = '#f59e0b';
const DEFAULT_HOUR_COLOR = '#d1d5db';
const ACTIVITY_COLOR = '#10b981';
const AVG_COLOR = '#6366f1';
const DOMAIN_COLOR = '#34d399';
const DOW_COLOR = '#818cf8';

/** 7-day rolling average for the activity chart */
function rollingAverage(data: { date: string; count: number }[], window = 7) {
  return data.map((d, i) => {
    const slice = data.slice(Math.max(0, i - window + 1), i + 1);
    const avg = slice.reduce((s, x) => s + x.count, 0) / slice.length;
    return { ...d, avg: parseFloat(avg.toFixed(1)) };
  });
}

function formatHour(h: number) {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wide text-gray-400 font-medium mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 leading-tight">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-medium text-gray-700">{children}</h3>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

export default function BrowserHistoryOverview({ visits, onSelectDomain, onSelectDate, onViewAll }: Props) {
  const stats = useMemo(() => computeBrowserStats(visits), [visits]);
  const activityData = useMemo(() => rollingAverage(stats.activityByDay), [stats.activityByDay]);

  // Month tick positions for activity chart (first date of each month)
  const monthTicks = useMemo(() => {
    const seen = new Set<string>();
    return activityData
      .filter(d => {
        const month = d.date.slice(0, 7);
        if (seen.has(month)) return false;
        seen.add(month);
        return true;
      })
      .map(d => d.date);
  }, [activityData]);

  // Inject fill color into hour data so recharts can use it via shape prop
  const hourData = useMemo(() => stats.hourDistribution.map(entry => ({
    ...entry,
    barFill: Math.abs(entry.hour - stats.peakHour) <= 1 ? PEAK_COLOR : DEFAULT_HOUR_COLOR,
  })), [stats.hourDistribution, stats.peakHour]);

  if (visits.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-gray-400">
        No browsing data to analyze
      </div>
    );
  }

  const peakHourLabel = formatHour(stats.peakHour);
  const peakHourCount = stats.hourDistribution[stats.peakHour]?.count ?? 0;

  const dateRangeLabel = stats.dateRange
    ? `${formatDate(stats.dateRange.earliest)} – ${formatDate(stats.dateRange.latest)}`
    : '—';

  function formatMonthTick(dateStr: string) {
    try {
      return new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, { month: 'short' });
    } catch {
      return '';
    }
  }

  // recharts v3: onClick data has the datum in data.payload
  function handleActivityClick(data: any) {
    const date = data?.payload?.date ?? data?.date;
    if (date) onSelectDate(date);
  }

  function handleDomainClick(data: any) {
    const domain = data?.payload?.domain ?? data?.domain;
    if (domain) onSelectDomain(domain);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-8">

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total Visits" value={stats.totalVisits.toLocaleString()} sub="browsing events" />
          <StatCard label="Unique Sites" value={stats.uniqueDomains.toLocaleString()} sub="distinct domains" />
          <StatCard label="Date Range" value={dateRangeLabel} />
          <StatCard label="Peak Hour" value={peakHourLabel} sub={`${peakHourCount.toLocaleString()} visits`} />
        </div>

        {/* ── Activity over time ── */}
        {activityData.length > 0 && (
          <div>
            <SectionTitle hint="Last 90 days · click a bar to filter">Browsing Activity</SectionTitle>
            <ResponsiveContainer width="100%" height={180} minWidth={200}>
              <ComposedChart data={activityData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="date"
                  ticks={monthTicks}
                  tickFormatter={formatMonthTick}
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-white border border-gray-200 rounded shadow-sm px-3 py-2 text-xs">
                        <div className="font-medium text-gray-700">{formatDate(label)}</div>
                        <div className="text-emerald-600">{payload[0]?.value} visits</div>
                        {payload[1]?.value != null && (
                          <div className="text-indigo-400">{payload[1].value} avg</div>
                        )}
                      </div>
                    );
                  }}
                  cursor={{ fill: '#f3f4f6' }}
                />
                <Bar
                  dataKey="count"
                  fill={ACTIVITY_COLOR}
                  radius={[2, 2, 0, 0]}
                  onClick={handleActivityClick}
                  style={{ cursor: 'pointer' }}
                />
                <Line
                  type="monotone"
                  dataKey="avg"
                  stroke={AVG_COLOR}
                  dot={false}
                  strokeWidth={1.5}
                  activeDot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="flex items-center gap-4 mt-2">
              <span className="flex items-center gap-1.5 text-xs text-gray-400">
                <span className="w-3 h-2 rounded-sm inline-block" style={{ background: ACTIVITY_COLOR }} />
                Daily visits
              </span>
              <span className="flex items-center gap-1.5 text-xs text-gray-400">
                <span className="w-6 border-t-2 inline-block" style={{ borderColor: AVG_COLOR }} />
                7-day average
              </span>
            </div>
          </div>
        )}

        {/* ── Top domains ── */}
        {stats.topDomains.length > 0 && (
          <div>
            <SectionTitle hint="click to filter">Most Visited Sites</SectionTitle>
            <ResponsiveContainer
              width="100%"
              height={Math.max(stats.topDomains.length * 28, 80)}
              minWidth={200}
            >
              <BarChart
                data={stats.topDomains}
                layout="vertical"
                margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
              >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="domain"
                  width={170}
                  tick={{ fontSize: 11, fill: '#374151' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-white border border-gray-200 rounded shadow-sm px-3 py-2 text-xs">
                        <div className="font-medium text-gray-700">{payload[0]?.payload?.domain}</div>
                        <div className="text-emerald-600">{payload[0]?.value} visits</div>
                      </div>
                    );
                  }}
                  cursor={{ fill: '#f3f4f6' }}
                />
                <Bar
                  dataKey="count"
                  fill={DOMAIN_COLOR}
                  radius={[0, 3, 3, 0]}
                  onClick={handleDomainClick}
                  style={{ cursor: 'pointer' }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── Two-column: Hours + Browser ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* Browsing Hours */}
          <div>
            <SectionTitle>Browsing Hours</SectionTitle>
            <ResponsiveContainer width="100%" height={120} minWidth={200}>
              <BarChart data={hourData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="hour"
                  ticks={[0, 6, 12, 18]}
                  tickFormatter={formatHour}
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const h = payload[0]?.payload?.hour ?? 0;
                    return (
                      <div className="bg-white border border-gray-200 rounded shadow-sm px-3 py-2 text-xs">
                        <div className="font-medium text-gray-700">
                          {formatHour(h)} – {formatHour((h + 1) % 24)}
                        </div>
                        <div className="text-amber-500">{payload[0]?.value} visits</div>
                      </div>
                    );
                  }}
                  cursor={false}
                />
                <Bar
                  dataKey="count"
                  radius={[2, 2, 0, 0]}
                  shape={(props: any) => {
                    const { x, y, width, height, barFill } = props;
                    const h = Math.max(height, 1);
                    return (
                      <rect
                        x={x}
                        y={y + (height - h)}
                        width={Math.max(width, 1)}
                        height={h}
                        rx={2}
                        fill={barFill ?? DEFAULT_HOUR_COLOR}
                      />
                    );
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs text-gray-400 mt-1">
              Peak: {peakHourLabel} · {peakHourCount.toLocaleString()} visits
            </p>
          </div>

          {/* Browser Breakdown */}
          <div>
            <SectionTitle>Browser Breakdown</SectionTitle>
            {stats.browserBreakdown.length > 1 ? (
              <div className="flex items-center gap-4">
                <PieChart width={150} height={150}>
                  <Pie
                    data={stats.browserBreakdown}
                    dataKey="count"
                    nameKey="browser"
                    cx="50%"
                    cy="50%"
                    innerRadius={38}
                    outerRadius={62}
                    paddingAngle={2}
                  >
                    {stats.browserBreakdown.map((entry) => (
                      <Cell
                        key={entry.browser}
                        fill={BROWSER_COLORS[entry.browser] ?? '#94a3b8'}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="bg-white border border-gray-200 rounded shadow-sm px-3 py-2 text-xs">
                          <div className="font-medium capitalize">{payload[0]?.name}</div>
                          <div>{payload[0]?.value?.toLocaleString()} visits</div>
                        </div>
                      );
                    }}
                  />
                </PieChart>
                <div className="space-y-2">
                  {stats.browserBreakdown.map(b => (
                    <div key={b.browser} className="flex items-center gap-2 text-sm">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ background: BROWSER_COLORS[b.browser] ?? '#94a3b8' }}
                      />
                      <span className="text-gray-700 capitalize">{b.browser}</span>
                      <span className="font-medium text-gray-900">{b.count.toLocaleString()}</span>
                      <span className="text-xs text-gray-400">{b.pct}%</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {stats.browserBreakdown.map(b => (
                  <div key={b.browser} className="flex items-center gap-3">
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ background: BROWSER_COLORS[b.browser] ?? '#94a3b8' }}
                    />
                    <span className="text-sm text-gray-700 capitalize">{b.browser}</span>
                    <span className="text-sm font-medium text-gray-900 ml-auto">
                      {b.count.toLocaleString()}
                    </span>
                    <span className="text-xs text-gray-400">100%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Day of week ── */}
        <div>
          <SectionTitle>Day of Week</SectionTitle>
          <ResponsiveContainer width="100%" height={120} minWidth={200}>
            <BarChart data={stats.dayOfWeekDistribution} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="bg-white border border-gray-200 rounded shadow-sm px-3 py-2 text-xs">
                      <div className="font-medium text-gray-700">{payload[0]?.payload?.label}</div>
                      <div className="text-indigo-500">{payload[0]?.value?.toLocaleString()} visits</div>
                    </div>
                  );
                }}
                cursor={{ fill: '#f3f4f6' }}
              />
              <Bar dataKey="count" fill={DOW_COLOR} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* ── View all ── */}
        <button
          onClick={onViewAll}
          className="w-full py-2.5 text-sm text-emerald-600 border border-emerald-200 rounded-lg hover:bg-emerald-50 transition-colors font-medium"
        >
          View Full History →
        </button>

      </div>
    </div>
  );
}
