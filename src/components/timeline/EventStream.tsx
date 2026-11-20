import { memo, useMemo } from 'react';
import type { TimelineEntry } from '../../types/timeline';
import { streamDays, type StreamDay } from '../../lib/eventStream';
import { plural } from '../../lib/saveData';
import { useGrowingList } from '../../hooks/useGrowingList';
import TimelineEntryCard from './TimelineEntryCard';

interface Props {
  /** Every event to show, newest first. Only the first part is drawn; more is added as you scroll. */
  entries: TimelineEntry[];
  /** Changes when the stream is something else (other filters, another person): back to the top. */
  resetKey: unknown;
  udid: string;
  /** 'timeline' draws centred date headings with each day's count; 'people' plain ones. */
  variant: 'timeline' | 'people';
  /** The backup is still being read, so the end of the list may not be the end. */
  loading?: boolean;
  /** Padding inside the scroll pane. */
  className?: string;
  onOpenWhatsApp?: (entry: TimelineEntry) => void;
  onOpenMessage?: (entry: TimelineEntry) => void;
}

/**
 * One continuous stream of events, grouped by day under sticky headings, for
 * the Timeline and People. It shows the newest events first and keeps adding
 * older ones as you scroll, so there are no pages to step through.
 */
export default function EventStream({ entries, resetKey, udid, variant, loading, className = '', onOpenWhatsApp, onOpenMessage }: Props) {
  const { shown, more, scrollRef, sentinelRef } = useGrowingList(entries.length, resetKey);
  const days = useMemo(() => streamDays(entries, shown), [entries, shown]);

  return (
    <div ref={scrollRef} data-scroll-root className={`flex-1 min-h-0 overflow-y-auto ${className}`}>
      {days.map(day => (
        <Day key={day.key} day={day} udid={udid} variant={variant} onOpenWhatsApp={onOpenWhatsApp} onOpenMessage={onOpenMessage} />
      ))}
      <div ref={sentinelRef} className="py-6 text-center text-sm text-text-tertiary" aria-live="polite">
        {entries.length === 0 ? null
          : more ? 'Loading more…'
          : loading ? 'Still reading the backup…'
          : `That's all ${plural(entries.length, 'event')}`}
      </div>
    </div>
  );
}

const Day = memo(function Day({ day, udid, variant, onOpenWhatsApp, onOpenMessage }: {
  day: StreamDay;
  udid: string;
  variant: 'timeline' | 'people';
  onOpenWhatsApp?: (entry: TimelineEntry) => void;
  onOpenMessage?: (entry: TimelineEntry) => void;
}) {
  return (
    <section aria-label={day.label}>
      {variant === 'timeline' ? (
        <div className="sticky top-0 z-10 bg-base flex items-center gap-2.5 pt-3.5 pb-2">
          <div className="flex-1 h-px bg-rule" />
          <h3 className="text-sm font-semibold text-text-primary whitespace-nowrap">{day.label}</h3>
          <span className="text-[13px] text-text-tertiary whitespace-nowrap">{plural(day.total, 'event')}</span>
          <div className="flex-1 h-px bg-rule" />
        </div>
      ) : (
        <h3 className="sticky top-0 z-10 bg-base pt-4 pb-2 text-sm font-semibold text-text-primary">{day.label}</h3>
      )}
      <div className="flex flex-col gap-1.5">
        {day.entries.map(entry => (
          <TimelineEntryCard key={entry.id} entry={entry} udid={udid} onOpenWhatsApp={onOpenWhatsApp} onOpenMessage={onOpenMessage} />
        ))}
      </div>
    </section>
  );
});
