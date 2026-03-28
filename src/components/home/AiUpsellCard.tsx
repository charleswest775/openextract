import { SparklesIcon } from '../shared/Icons';

interface Props {
  messageCount: number;
  deviceCount: number;
}

export default function AiUpsellCard({ messageCount, deviceCount }: Props) {
  const title = messageCount > 0
    ? `${messageCount.toLocaleString()} messages across ${deviceCount} device${deviceCount !== 1 ? 's' : ''}. What's the story?`
    : 'Unlock AI-powered insights from your data.';

  return (
    <div className="rounded-md border border-gray-200 px-5 py-4 flex items-center gap-4 hover:border-blue-300 transition-colors cursor-pointer mb-4">
      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center flex-shrink-0">
        <SparklesIcon className="text-white" size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900">{title}</div>
        <div className="text-xs text-gray-500">
          AI synthesis finds patterns, relationships, and insights you'd never spot manually
        </div>
      </div>
      <span className="text-xs text-blue-600 font-medium flex-shrink-0">Discover</span>
    </div>
  );
}
