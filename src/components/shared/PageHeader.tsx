import type { ReactNode } from 'react';
import { SearchIcon } from './Icons';

interface Props {
  title: string;
  /** What's on the page, e.g. "45 contacts". */
  count?: ReactNode;
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
  };
  /** Buttons on the right, usually one Save. */
  actions?: ReactNode;
}

/** The one header every screen in a backup uses: title, count, search and actions. */
export default function PageHeader({ title, count, search, actions }: Props) {
  return (
    <header className="h-16 px-6 flex items-center gap-4 border-b border-rule bg-base flex-shrink-0">
      <div className="flex items-baseline gap-3 min-w-0">
        <h1 className="text-2xl text-text-primary whitespace-nowrap">{title}</h1>
        {count != null && <span className="text-sm text-text-tertiary truncate">{count}</span>}
      </div>
      <div className="flex-1" />
      {search && <SearchField {...search} className="w-44 lg:w-64" />}
      {actions}
    </header>
  );
}

export function SearchField({ value, onChange, placeholder, className = '' }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" size={18} />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full h-10 pl-10 pr-3 text-sm bg-surface border border-rule rounded-full text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
      />
    </div>
  );
}
