import AppHeader from '../shared/AppHeader';
import PrivacyFooter from '../shared/PrivacyFooter';
import { DownloadIcon, FolderIcon, ChevronRightIcon, LinesIcon, GridIcon, ClockIcon, PlayIcon } from '../shared/Icons';

interface Props {
  onGetMyData: () => void;
  onBrowseForBackup: () => void;
}

export default function ReturnedView({ onGetMyData, onBrowseForBackup }: Props) {
  return (
    <div className="h-screen flex flex-col bg-white">
      <AppHeader />

      <div className="flex-1 overflow-y-auto px-7 py-8">
        {/* Hero */}
        <div className="mb-7">
          <h1 className="text-xl font-medium text-gray-900 mb-2">
            Welcome back. Ready to get your data?
          </h1>
          <p className="text-sm text-gray-500 max-w-lg leading-relaxed">
            Once your iPhone is backed up, you'll be able to search every message, browse every
            photo, and explore your entire digital history — all privately on your machine.
          </p>
        </div>

        {/* Primary action card */}
        <button
          onClick={onGetMyData}
          className="w-full bg-gray-50 rounded-xl p-5 flex items-center gap-4 mb-5 border border-transparent hover:border-gray-300 transition-colors text-left"
        >
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-400 flex items-center justify-center flex-shrink-0">
            <DownloadIcon className="text-white" size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-medium text-gray-900">Get my data</div>
            <div className="text-sm text-gray-500">Connect your iPhone to start — takes about 30 minutes</div>
          </div>
          <ChevronRightIcon className="text-gray-400 flex-shrink-0" size={20} />
        </button>

        {/* Secondary action — already have a backup */}
        <button
          onClick={onBrowseForBackup}
          className="w-full bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-3 mb-7 hover:border-gray-300 transition-colors text-left"
        >
          <div className="w-8 h-8 rounded-md bg-gray-100 flex items-center justify-center flex-shrink-0">
            <FolderIcon className="text-gray-500" size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900">Already have a backup?</div>
            <div className="text-xs text-gray-500">Point to an iTunes or Finder backup on your computer</div>
          </div>
        </button>

        {/* What you'll unlock grid */}
        <div className="mb-7">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">
            What you'll unlock
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="flex items-center gap-2.5 p-2.5 bg-gray-50 rounded-md">
              <LinesIcon className="text-blue-500 flex-shrink-0" size={16} />
              <div>
                <div className="text-sm font-medium text-gray-900">Every message</div>
                <div className="text-xs text-gray-400">Including deleted texts</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 p-2.5 bg-gray-50 rounded-md">
              <GridIcon className="text-green-500 flex-shrink-0" size={16} />
              <div>
                <div className="text-sm font-medium text-gray-900">All your photos</div>
                <div className="text-xs text-gray-400">With location and metadata</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 p-2.5 bg-gray-50 rounded-md">
              <ClockIcon className="text-amber-500 flex-shrink-0" size={16} />
              <div>
                <div className="text-sm font-medium text-gray-900">Your timeline</div>
                <div className="text-xs text-gray-400">Activity across apps and dates</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 p-2.5 bg-gray-50 rounded-md">
              <PlayIcon className="text-red-500 flex-shrink-0" size={16} />
              <div>
                <div className="text-sm font-medium text-gray-900">Export anything</div>
                <div className="text-xs text-gray-400">PDF, CSV, images — your format</div>
              </div>
            </div>
          </div>
        </div>

        <PrivacyFooter variant="compact" />
      </div>
    </div>
  );
}
