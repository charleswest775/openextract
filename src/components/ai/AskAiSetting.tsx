import { useAskAi } from '../../hooks/useAskAi';
import { appNames, setAskAiHidden, settingShown } from '../../lib/askAi';

/**
 * Settings' "Show Ask AI on the home screen": undoes "Don't show this again". Only in builds
 * that have Ask AI, on a computer with an AI app it can use; nothing anywhere else.
 */
export default function AskAiSetting() {
  const state = useAskAi();
  if (!settingShown(state)) return null;
  return (
    <>
      <div className="hearth-eyebrow mb-2">Ask AI</div>
      <label className="flex items-start gap-2.5 mb-1 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 accent-[var(--accent)]"
          checked={!state.hidden}
          onChange={e => setAskAiHidden(!e.target.checked)}
        />
        <span className="text-sm text-text-primary">Show Ask AI on the home screen</span>
      </label>
      <p className="text-xs text-text-tertiary mb-6 pl-[26px]">
        Lets {appNames(state.apps)} answer questions about your backups, with the OpenExtract AI add-on.
      </p>
    </>
  );
}
