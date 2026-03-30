const APP_VERSION = '0.3.0';

interface Props {
  showVersion?: boolean;
  showSettings?: boolean;
}

export default function AppHeader({ showVersion = true, showSettings = true }: Props) {
  return (
    <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-400 flex items-center justify-center">
          <span className="text-white text-xs font-medium">OE</span>
        </div>
        <span className="font-medium text-[15px] text-gray-900">OpenExtract</span>
        {showVersion && (
          <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
            v{APP_VERSION}
          </span>
        )}
      </div>
      {showSettings && (
        <button className="text-sm text-gray-500 hover:text-gray-700 transition-colors">
          Settings
        </button>
      )}
    </div>
  );
}
