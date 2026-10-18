import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { saveFolder } from '../../lib/ipc';
import { ExportIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import NoticeBanners, { type ExportStatus } from '../shared/NoticeBanners';
import HealthChart from './HealthChart';
import {
  RANGES,
  averageBy,
  defaultUnits,
  distance,
  formatMinutes,
  formatNumber,
  formatPeriod,
  localDate,
  mean,
  rangeStart,
  toYmd,
  weight,
  type HealthSummary,
  type HealthWorkout,
  type RangeKey,
  type Units,
} from '../../lib/health';

interface Props {
  udid: string;
}

const WORKOUT_PAGE = 100;

const oneDecimal = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const compact = (v: number) => (v >= 1000 ? `${oneDecimal(v / 1000)}k` : oneDecimal(v));

function StatTile({ label, value, sub }: { label: string; value: string | null; sub: string }) {
  return (
    <div className="bg-white border border-border-default rounded-lg px-4 py-3">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className="text-2xl font-semibold text-text-primary leading-tight mt-1">{value ?? '—'}</div>
      <div className="text-xs text-text-tertiary mt-0.5">{value === null ? 'No data in this range' : sub}</div>
    </div>
  );
}

function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: { key: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center bg-elevated rounded-md p-0.5">
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`px-2.5 py-1 text-xs rounded transition-colors ${
            value === o.key ? 'bg-white text-text-primary shadow-sm font-medium' : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="bg-white border border-border-default rounded-lg p-4">
      <h3 className="text-sm font-medium text-text-primary">{title}</h3>
      <p className="text-xs text-text-tertiary mb-3">{subtitle}</p>
      {children}
    </section>
  );
}

function workoutDay(w: HealthWorkout): string | null {
  return w.start ? toYmd(new Date(w.start)) : null;
}

function formatDuration(minutes: number | null): string {
  return minutes === null ? '—' : formatMinutes(minutes);
}

export default function HealthExplorer({ udid }: Props) {
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rangeKey, setRangeKey] = useState<RangeKey>('90d');
  const [view, setView] = useState<'charts' | 'table'>('charts');
  const [units, setUnits] = useState<Units>(defaultUnits);
  const [workoutLimit, setWorkoutLimit] = useState(WORKOUT_PAGE);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<ExportStatus | null>(null);

  useEffect(() => {
    loadSummary();
  }, [udid]);

  async function loadSummary() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await window.openextract.call('get_health_summary', { udid });
      if (res.success && res.data) setSummary(res.data);
      else setLoadError(res.error || "Couldn't load Health data.");
    } finally {
      setLoading(false);
    }
  }

  async function handleExport() {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    setStatus(null);
    try {
      const res = await window.openextract.call('export_health', { udid, output_dir: `${outputDir}/Health` });
      const data = res.success ? res.data : null;
      if (data?.success) {
        window.openextract.incrementExportCount();
        setStatus({
          ok: true,
          text: `Exported ${formatNumber(data.days)} days and ${formatNumber(data.workouts)} workouts to ${data.path}.`,
        });
      } else {
        setStatus({ ok: false, text: data?.error || res.error || 'Export failed.' });
      }
    } finally {
      setExporting(false);
    }
  }

  const range = RANGES.find(r => r.key === rangeKey)!;
  const bucket = range.bucket;
  const first = summary?.range ? rangeStart(summary.range, range.days) : null;
  const last = summary?.range?.last ?? null;

  const days = useMemo(
    () => (first && last ? (summary?.daily ?? []).filter(d => d.date >= first && d.date <= last) : []),
    [summary, first, last],
  );
  const nights = useMemo(
    () => (first && last ? (summary?.sleep ?? []).filter(n => n.date >= first && n.date <= last) : []),
    [summary, first, last],
  );
  const workouts = useMemo(
    () => (summary?.workouts ?? []).filter(w => {
      const day = workoutDay(w);
      return !!day && (!first || day >= first);
    }),
    [summary, first],
  );

  const series = useMemo(() => ({
    steps: averageBy(days, bucket, d => d.steps),
    sleep: averageBy(nights, bucket, n => (n.asleep_minutes > 0 ? n.asleep_minutes / 60 : null)),
    resting: averageBy(days, bucket, d => d.resting_heart_rate),
    weight: averageBy(days, bucket, d => (d.weight_kg === undefined ? null : weight(d.weight_kg, units).value)),
  }), [days, nights, bucket, units]);

  const tableRows = useMemo(() => {
    const rows = new Map<string, Record<string, number>>();
    const put = (field: string, points: { key: string; value: number }[]) => {
      for (const p of points) rows.set(p.key, { ...rows.get(p.key), [field]: p.value });
    };
    put('steps', series.steps);
    put('distance', averageBy(days, bucket, d => (d.distance_km === undefined ? null : distance(d.distance_km, units).value)));
    put('flights', averageBy(days, bucket, d => d.flights));
    put('energy', averageBy(days, bucket, d => d.active_energy_kcal));
    put('sleep', series.sleep);
    put('resting', series.resting);
    put('weight', series.weight);
    return [...rows.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [series, days, bucket, units]);

  const hasData = !!summary && (summary.daily.length > 0 || summary.sleep.length > 0 || summary.workouts.length > 0);
  const errors = [
    ...(loadError ? [loadError] : []),
    ...(summary?.notice ? [summary.notice] : []),
    ...(summary?.errors ?? []).map(e => e.message),
  ];

  const avgSteps = mean(days.map(d => d.steps));
  const avgSleep = mean(nights.map(n => (n.asleep_minutes > 0 ? n.asleep_minutes : null)));
  const avgResting = mean(days.map(d => d.resting_heart_rate));
  const workoutHours = workouts.reduce((sum, w) => sum + (w.duration_minutes ?? 0), 0) / 60;
  const distanceUnit = distance(0, units).unit;
  const weightUnit = weight(0, units).unit;
  const per = bucket === 'day' ? 'Each day' : bucket === 'week' ? 'Weekly average' : 'Monthly average';

  const rangeText = first && last
    ? `${localDate(first).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} – ${localDate(last).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 bg-base" style={{ padding: '20px 28px 14px', borderBottom: '1px solid var(--border-default)', flexShrink: 0 }}>
        <div>
          <div className="hearth-eyebrow mb-1.5">Health{rangeText && ` · ${rangeText}`}</div>
          <h1 className="hearth-title text-3xl">
            Steps you <span className="font-serif-italic text-accent">took.</span>
          </h1>
        </div>
        <button onClick={handleExport} disabled={exporting || !hasData} className="hearth-ghost-btn" title="Export daily data and workouts as CSV">
          <ExportIcon size={13} />
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      <NoticeBanners errors={errors} status={status} />

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex flex-col items-center gap-3 py-12 text-accent">
            <OrganicLoader size={72} />
            <p className="text-xs text-text-tertiary">Reading Health data. Years of history can take a minute.</p>
          </div>
        )}

        {!loading && summary && !hasData && (
          <div className="text-center py-8 text-sm text-gray-400">No Health data found in this backup</div>
        )}

        {!loading && hasData && (
          <div className="px-7 py-5 space-y-5">
            {/* One filter row scopes everything below it. */}
            <div className="flex flex-wrap items-center gap-2">
              <Segmented label="Date range" options={RANGES} value={rangeKey} onChange={k => { setRangeKey(k); setWorkoutLimit(WORKOUT_PAGE); }} />
              <Segmented label="View" options={[{ key: 'charts', label: 'Charts' }, { key: 'table', label: 'Table' }]} value={view} onChange={setView} />
              <Segmented label="Units" options={[{ key: 'metric', label: 'km · kg' }, { key: 'us', label: 'mi · lb' }]} value={units} onChange={setUnits} />
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatTile label="Steps" value={avgSteps === null ? null : formatNumber(avgSteps)} sub="average per day" />
              <StatTile label="Sleep" value={avgSleep === null ? null : formatMinutes(avgSleep)} sub="average per night" />
              <StatTile label="Resting heart rate" value={avgResting === null ? null : `${formatNumber(avgResting)} bpm`} sub="average" />
              <StatTile label="Workouts" value={workouts.length ? formatNumber(workouts.length) : null} sub={`${formatNumber(workoutHours, 1)} hours in total`} />
            </div>

            {view === 'charts' ? (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {series.steps.length > 0 && (
                  <ChartCard title="Steps" subtitle={`${per}, steps per day`}>
                    <HealthChart kind="bar" data={series.steps} bucket={bucket}
                      formatValue={v => `${formatNumber(v)} steps`} formatAxis={compact} />
                  </ChartCard>
                )}
                {series.sleep.length > 0 && (
                  <ChartCard title="Sleep" subtitle={`${per}, hours asleep per night`}>
                    <HealthChart kind="bar" data={series.sleep} bucket={bucket}
                      formatValue={v => `${formatMinutes(v * 60)} asleep`} formatAxis={v => `${oneDecimal(v)}h`} />
                  </ChartCard>
                )}
                {series.resting.length > 0 && (
                  <ChartCard title="Resting heart rate" subtitle={`${per}, beats per minute`}>
                    <HealthChart kind="line" data={series.resting} bucket={bucket}
                      formatValue={v => `${formatNumber(v)} bpm`} formatAxis={oneDecimal} />
                  </ChartCard>
                )}
                {series.weight.length > 0 && (
                  <ChartCard title="Weight" subtitle={`${per}, ${weightUnit}`}>
                    <HealthChart kind="line" data={series.weight} bucket={bucket}
                      formatValue={v => `${formatNumber(v, 1)} ${weightUnit}`} formatAxis={oneDecimal} />
                  </ChartCard>
                )}
              </div>
            ) : (
              <div className="bg-white border border-border-default rounded-lg overflow-x-auto">
                <table className="w-full text-xs tabular-nums">
                  <thead className="text-text-secondary border-b border-border-default">
                    <tr>
                      <th className="text-left font-medium px-3 py-2">{bucket === 'day' ? 'Day' : bucket === 'week' ? 'Week' : 'Month'}</th>
                      <th className="text-right font-medium px-3 py-2">Steps</th>
                      <th className="text-right font-medium px-3 py-2">Distance ({distanceUnit})</th>
                      <th className="text-right font-medium px-3 py-2">Flights</th>
                      <th className="text-right font-medium px-3 py-2">Active energy (kcal)</th>
                      <th className="text-right font-medium px-3 py-2">Sleep</th>
                      <th className="text-right font-medium px-3 py-2">Resting HR</th>
                      <th className="text-right font-medium px-3 py-2">Weight ({weightUnit})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(([key, r]) => (
                      <tr key={key} className="border-b border-border-subtle text-text-primary">
                        <td className="px-3 py-1.5 whitespace-nowrap">{formatPeriod(key, bucket)}</td>
                        <td className="px-3 py-1.5 text-right">{r.steps !== undefined ? formatNumber(r.steps) : '—'}</td>
                        <td className="px-3 py-1.5 text-right">{r.distance !== undefined ? formatNumber(r.distance, 2) : '—'}</td>
                        <td className="px-3 py-1.5 text-right">{r.flights !== undefined ? formatNumber(r.flights) : '—'}</td>
                        <td className="px-3 py-1.5 text-right">{r.energy !== undefined ? formatNumber(r.energy) : '—'}</td>
                        <td className="px-3 py-1.5 text-right">{r.sleep !== undefined ? formatMinutes(r.sleep * 60) : '—'}</td>
                        <td className="px-3 py-1.5 text-right">{r.resting !== undefined ? formatNumber(r.resting) : '—'}</td>
                        <td className="px-3 py-1.5 text-right">{r.weight !== undefined ? formatNumber(r.weight, 1) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {bucket !== 'day' && (
                  <p className="px-3 py-2 text-[11px] text-text-tertiary">Values are per-day averages for each {bucket}.</p>
                )}
              </div>
            )}

            {workouts.length > 0 && (
              <section>
                <h2 className="text-sm font-medium text-text-primary mb-2">
                  Workouts <span className="text-text-tertiary font-normal">· {formatNumber(workouts.length)}</span>
                </h2>
                <div className="bg-white border border-border-default rounded-lg overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-text-secondary border-b border-border-default">
                      <tr>
                        <th className="text-left font-medium px-3 py-2">Date</th>
                        <th className="text-left font-medium px-3 py-2">Workout</th>
                        <th className="text-right font-medium px-3 py-2">Duration</th>
                        <th className="text-right font-medium px-3 py-2">Distance</th>
                        <th className="text-right font-medium px-3 py-2">Energy</th>
                        <th className="text-right font-medium px-3 py-2">Avg HR</th>
                        <th className="text-left font-medium px-3 py-2">Recorded by</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {workouts.slice(0, workoutLimit).map(w => {
                        const start = w.start ? new Date(w.start) : null;
                        const dist = w.distance_km !== null ? distance(w.distance_km, units) : null;
                        return (
                          <tr key={w.id} className="border-b border-border-subtle text-text-primary">
                            <td className="px-3 py-1.5 whitespace-nowrap">
                              {start ? start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                              <span className="text-text-tertiary"> {start ? start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''}</span>
                            </td>
                            <td className="px-3 py-1.5">
                              {w.type}
                              {w.indoor !== null && <span className="text-text-tertiary"> · {w.indoor ? 'Indoor' : 'Outdoor'}</span>}
                            </td>
                            <td className="px-3 py-1.5 text-right">{formatDuration(w.duration_minutes)}</td>
                            <td className="px-3 py-1.5 text-right">{dist ? `${formatNumber(dist.value, 2)} ${dist.unit}` : '—'}</td>
                            <td className="px-3 py-1.5 text-right">{w.energy_kcal !== null ? `${formatNumber(w.energy_kcal)} kcal` : '—'}</td>
                            <td className="px-3 py-1.5 text-right">{w.avg_heart_rate !== null ? `${w.avg_heart_rate} bpm` : '—'}</td>
                            <td className="px-3 py-1.5 text-text-secondary">{w.source ?? '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {workouts.length > workoutLimit && (
                  <div className="flex justify-center pt-3">
                    <button onClick={() => setWorkoutLimit(l => l + WORKOUT_PAGE)} className="hearth-ghost-btn">
                      Show more ({formatNumber(workouts.length - workoutLimit)} older)
                    </button>
                  </div>
                )}
              </section>
            )}

            <p className="text-[11px] text-text-tertiary leading-relaxed max-w-3xl">
              iPhone and Apple Watch often record the same steps. For each day, OpenExtract uses whichever
              device counted more, so nothing is counted twice; sleep uses the source that recorded the most
              sleep each night. Days follow this computer's time zone.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
