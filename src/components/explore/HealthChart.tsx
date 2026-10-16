import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPeriod, formatTick, type Bucket } from '../../lib/health';

// One series per chart, so one hue: the Hearth accent. It clears 3:1 against
// the white chart card (not against the cream page — keep charts on cards).
const SERIES = '#d97757';
const SERIES_HOVER = '#c26547';
const GRID = '#ece1d1';
const TICK = '#97897a';
const SURFACE = '#ffffff';

// Few enough points that each one should be visible as a dot (e.g. weekly weigh-ins).
const MAX_DOTTED_POINTS = 45;

/** Round-number axis ticks (steps of 1, 2, 2.5 or 5 × 10ⁿ) covering [min, max]. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) max = min + 1;
  const raw = (max - min) / count;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = ([1, 2, 2.5, 5, 10].find(f => raw / exp <= f) ?? 10) * exp;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; v < max + step; v += step) {
    ticks.push(Number(v.toPrecision(12)));
    if (v >= max) break;
  }
  return ticks;
}

interface Props {
  kind: 'bar' | 'line';
  data: { key: string; value: number }[];
  bucket: Bucket;
  /** Formats a value for the tooltip, e.g. 7234 → "7,234 steps" */
  formatValue: (value: number) => string;
  /** Formats a value for the y-axis ticks */
  formatAxis: (value: number) => string;
  /** Height of the whole chart, axis labels included */
  height?: number;
}

function ChartTooltip({ active, payload, label, bucket, formatValue, kind }: {
  active?: boolean;
  payload?: readonly { value?: unknown }[];
  label?: unknown;
  bucket: Bucket;
  formatValue: (value: number) => string;
  kind: 'bar' | 'line';
}) {
  if (!active || !payload?.length || typeof payload[0].value !== 'number') return null;
  return (
    <div className="bg-white border border-border-default rounded-md shadow-sm px-3 py-2">
      <div className="flex items-center gap-2">
        {kind === 'line'
          ? <span className="w-3 h-0.5 rounded-full" style={{ background: SERIES }} />
          : <span className="w-2 h-2 rounded-sm" style={{ background: SERIES }} />}
        <span className="text-sm font-semibold text-text-primary">{formatValue(payload[0].value)}</span>
      </div>
      <div className="text-xs text-text-secondary mt-0.5">{formatPeriod(String(label), bucket)}</div>
    </div>
  );
}

/** A single-series column or line chart over time buckets. */
export default function HealthChart({ kind, data, bucket, formatValue, formatAxis, height = 180 }: Props) {
  const values = data.map(d => d.value);
  const ticks = niceTicks(kind === 'bar' ? 0 : Math.min(...values), Math.max(...values));
  const xAxis = (
    <XAxis
      dataKey="key"
      tickFormatter={(k: string) => formatTick(k, bucket)}
      tick={{ fontSize: 11, fill: TICK }}
      axisLine={false}
      tickLine={false}
      interval="preserveStartEnd"
      minTickGap={28}
    />
  );
  const yAxis = (
    <YAxis
      width={44}
      tickFormatter={formatAxis}
      tick={{ fontSize: 11, fill: TICK }}
      axisLine={false}
      tickLine={false}
      ticks={ticks}
      domain={[ticks[0], ticks[ticks.length - 1]]}
      interval={0}
    />
  );
  const grid = <CartesianGrid vertical={false} stroke={GRID} />;
  const tooltip = (
    <Tooltip
      content={(p) => <ChartTooltip {...p} bucket={bucket} formatValue={formatValue} kind={kind} />}
      cursor={kind === 'bar' ? { fill: 'rgba(217, 119, 87, 0.08)' } : { stroke: '#d9c8ad', strokeWidth: 1 }}
      isAnimationActive={false}
    />
  );

  return (
    <ResponsiveContainer width="100%" height={height}>
      {kind === 'bar' ? (
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="25%">
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          <Bar
            dataKey="value"
            fill={SERIES}
            activeBar={{ fill: SERIES_HOVER }}
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
            isAnimationActive={false}
          />
        </BarChart>
      ) : (
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          <Line
            type="linear"
            dataKey="value"
            stroke={SERIES}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={data.length <= MAX_DOTTED_POINTS ? { r: 4, fill: SERIES, stroke: SURFACE, strokeWidth: 2 } : false}
            activeDot={{ r: 4, fill: SERIES, stroke: SURFACE, strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}
