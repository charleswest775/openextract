const APP_VERSION = '0.3.0';

interface Props {
  showVersion?: boolean;
  showSettings?: boolean;
}

export default function AppHeader({ showVersion = true, showSettings = true }: Props) {
  return (
    <div className="px-5 py-3 border-b border-border-default flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-400 flex items-center justify-center">
          <span className="text-white text-xs font-medium">OE</span>
        </div>
        <span className="font-medium text-[15px] text-text-primary">OpenExtract</span>
        {showVersion && (
          <span className="text-[11px] text-text-tertiary bg-elevated px-2 py-0.5 rounded">
            v{APP_VERSION}
          </span>
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
