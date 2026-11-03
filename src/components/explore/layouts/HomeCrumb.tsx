import { ChevronRightIcon, HomeIcon } from '../../shared/Icons';

/**
 * The way back to a layout's home page: a Home button that looks like one,
 * then where you are now.
 */
export default function HomeCrumb({ onHome, current, homeName }: { onHome: () => void; current?: string; homeName: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
      <button
        onClick={onHome}
        title={`Back to ${homeName}`}
        className="h-9 pl-3 pr-4 rounded-full border border-border-strong bg-surface flex items-center gap-2 text-sm font-semibold text-text-primary hover:bg-[var(--bg-elevated)] transition-colors flex-shrink-0"
      >
        <HomeIcon size={20} className="text-accent" />
        Home
      </button>
      {current && (
        <span className="hidden lg:flex items-center gap-1.5 min-w-0">
          <ChevronRightIcon size={18} className="text-text-tertiary flex-shrink-0" />
          <span aria-current="page" className="text-sm font-medium text-text-secondary truncate max-w-[160px]">{current}</span>
        </span>
      )}
    </nav>
  );
}
