const APP_VERSION = '0.4.0';

interface Props {
  showVersion?: boolean;
  showSettings?: boolean;
}

export default function AppHeader({ showVersion = true, showSettings = true }: Props) {
  return (
    <div className="px-5 py-3 border-b border-rule flex items-center justify-between bg-base">
      <div className="flex items-baseline gap-2.5">
        <div
          className="w-5 h-5 rounded-full self-center"
          style={{
            background: 'radial-gradient(circle at 35% 35%, var(--cream), var(--accent) 80%)',
          }}
        />
        <span className="font-serif text-[17px] font-medium text-text-primary tracking-tight">
          OpenExtract
        </span>
        {showVersion && (
          <span className="text-[11px] font-mono text-text-tertiary">v{APP_VERSION}</span>
        )}
      </div>
      {showSettings && (
        <button className="text-sm text-text-secondary hover:text-text-primary transition-colors">
          Settings
        </button>
      )}
    </div>
  );
}
