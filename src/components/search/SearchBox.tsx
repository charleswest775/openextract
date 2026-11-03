import type { RefObject } from 'react';
import { SearchIcon } from '../shared/Icons';

interface Props {
  inputRef: RefObject<HTMLInputElement>;
  text: string;
  onText: (text: string) => void;
  /** The screen the box is filtering, shown as a tag in the box. Null searches everything. */
  scope: string | null;
  onClearScope: () => void;
  placeholder: string;
  /** Up and down move through results, Enter opens one. */
  onKey?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** The one search box at the top of every screen. */
export default function SearchBox({ inputRef, text, onText, scope, onClearScope, placeholder, onKey }: Props) {
  const shortcut = window.openextract.platform === 'darwin' ? '⌘K' : 'Ctrl+K';
  return (
    <div className="relative w-full max-w-[600px] flex items-center h-10 bg-surface border-2 border-rule rounded-xl focus-within:border-accent">
      <SearchIcon size={20} className="ml-3.5 flex-shrink-0 text-text-secondary pointer-events-none" />
      {scope && (
        <span className="ml-2 flex-shrink-0 flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-lg bg-accent-wash text-sm text-accent font-medium">
          in {scope}
          <button
            onClick={() => { onClearScope(); inputRef.current?.focus(); }}
            title="Search the whole backup instead"
            aria-label={`Stop searching only ${scope}`}
            className="w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--accent-soft)] hover:text-white"
          >
            ×
          </button>
        </span>
      )}
      <input
        ref={inputRef}
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        onChange={e => onText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            onText('');
          } else if (e.key === 'Backspace' && scope && text === '') {
            onClearScope();
          } else {
            onKey?.(e);
          }
        }}
        className="flex-1 min-w-0 h-full pl-2.5 pr-2 bg-transparent text-[15px] text-text-primary placeholder:text-text-tertiary focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      {text && (
        <button
          onClick={() => { onText(''); inputRef.current?.focus(); }}
          title="Clear the search (Esc)"
          aria-label="Clear the search"
          className="mr-2 w-6 h-6 flex-shrink-0 rounded-full bg-sand text-text-secondary hover:text-text-primary flex items-center justify-center text-base leading-none"
        >
          ×
        </button>
      )}
      <kbd className="mr-3 hidden sm:block flex-shrink-0 font-mono text-xs text-text-tertiary border border-rule rounded-md px-1.5 py-0.5 pointer-events-none">
        {shortcut}
      </kbd>
    </div>
  );
}
