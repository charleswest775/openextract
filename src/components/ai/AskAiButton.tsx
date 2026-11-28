import { useAskAi } from '../../hooks/useAskAi';
import { askAiShown, openAskAi } from '../../lib/askAi';
import { AskAiIcon } from '../shared/Icons';

/**
 * Ask AI in the home screen's header, beside Help and Settings. Only in builds that have
 * Ask AI, with an AI app found on this computer, and until "Don't show this again".
 */
export default function AskAiButton() {
  const state = useAskAi();
  if (!askAiShown(state)) return null;
  return (
    <button
      onClick={openAskAi}
      className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
    >
      <AskAiIcon size={20} />
      Ask AI
    </button>
  );
}
