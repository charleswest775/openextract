import type { ReactNode } from 'react';

/**
 * Small card for the bottom-right notice stack (updates, the one-time share
 * prompt). App.tsx positions the stack; this only draws the card.
 */
export default function NoticeCard({ title, icon, onClose, children }: {
  title: string;
  icon: ReactNode;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className="w-[340px] px-4 py-3.5 rounded-xl"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-strong)',
        boxShadow: '0 10px 28px rgba(30,26,22,0.18)',
      }}
    >
      <div className="flex items-start gap-2.5 mb-1.5">
        <span className="text-accent flex-shrink-0 mt-0.5 flex">{icon}</span>
        <div className="flex-1 text-sm font-medium text-text-primary">{title}</div>
        {onClose && (
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary flex-shrink-0" aria-label="Dismiss">×</button>
        )}
      </div>
      <div className="pl-[26px]">{children}</div>
    </div>
  );
}
