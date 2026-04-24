import { ReactNode } from 'react';

interface Props {
  eyebrow: string;
  title: ReactNode;
  italic?: string;
  right?: ReactNode;
}

/**
 * Hearth section header: mono caption eyebrow + Fraunces serif title with
 * optional italic terracotta accent word. Used across all Explore screens
 * to match the Hearth aesthetic.
 */
export default function HearthHeader({ eyebrow, title, italic, right }: Props) {
  return (
    <div
      className="flex items-end justify-between gap-4 bg-base"
      style={{ padding: '20px 28px 14px', borderBottom: '1px solid var(--border-default)', flexShrink: 0 }}
    >
      <div className="min-w-0 flex-1">
        <div className="hearth-eyebrow mb-1.5">{eyebrow}</div>
        <h1 className="hearth-title text-3xl">
          {title}
          {italic && <> <span className="font-serif-italic text-accent">{italic}</span></>}
        </h1>
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}
