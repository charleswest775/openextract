import { useMemo } from 'react';
import { highlightRanges, parseQuery } from '../../lib/search';

interface Props {
  text: string;
  query: string;
  /** Start this many characters before the first match, so it shows in a one-line preview. 0 shows all of it. */
  around?: number;
  /** For text on a dark or colored background. */
  markClassName?: string;
}

/** `text` with every match of `query` marked. */
export default function Highlight({ text, query, around = 0, markClassName = 'text-inherit' }: Props) {
  const ranges = useMemo(() => highlightRanges(text, parseQuery(query)), [text, query]);
  if (ranges.length === 0) return <>{text}</>;

  let start = 0;
  if (around > 0 && ranges[0][0] > around) start = ranges[0][0] - Math.floor(around / 2);
  const parts: JSX.Element[] = [];
  let at = start;
  ranges.forEach(([from, to], i) => {
    if (to <= start) return;
    from = Math.max(from, start);
    if (from > at) parts.push(<span key={`t${i}`}>{text.slice(at, from)}</span>);
    parts.push(<mark key={`m${i}`} className={`bg-amber-200 rounded px-0.5 ${markClassName}`}>{text.slice(from, to)}</mark>);
    at = to;
  });
  if (at < text.length) parts.push(<span key="end">{text.slice(at)}</span>);
  return <>{start > 0 && '…'}{parts}</>;
}
