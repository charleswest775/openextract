import { useEffect, useState, type ReactNode } from 'react';
import { useAskAi } from '../../hooks/useAskAi';
import {
  APP_NAMES, EXAMPLE_QUESTION, KEYS_LINE, PRICE_LINE,
  appNames, appStateLine, askAiShown, companiesLine, fullDiskAccessStep, markNoteSeen, progressLine, refreshAskAi, setAskAiHidden,
  statusLine,
  type AddonStatus, type AiAppId, type AskAiResult, type InstallProgress,
} from '../../lib/askAi';
import { ArrowLeftIcon, AskAiIcon, CheckIcon, CopyIcon, LockIcon } from '../shared/Icons';

interface Props {
  onBack: () => void;
}

type Note = { kind: 'error' | 'done'; text: string };

/** The settings file's backup, beside it (electron/aiAddon.ts CODEX_BACKUP). */
const CODEX_BACKUP = 'config.toml.openextract-backup';

/**
 * Ask AI: what OpenExtract AI does and costs, said before anything installs, then one card
 * per AI app found: Install (Claude), Connect (ChatGPT, after the person's OK to change its
 * settings file) or the command to copy (Claude Code). Nothing downloads until one of those
 * is clicked. Once installed, the add-on's own --status says how many free questions are
 * left, or whose key it has: the app itself counts nothing.
 */
export default function AskAiScreen({ onBack }: Props) {
  const state = useAskAi();
  const bridge = window.openextract?.askAi;
  const [busy, setBusy] = useState<AiAppId | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [notes, setNotes] = useState<Partial<Record<AiAppId, Note>>>({});
  const [askingChatGpt, setAskingChatGpt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<AddonStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    refreshAskAi();
  }, []);
  // Opening Ask AI is what the note on Home was for.
  const unseen = !!state?.enabled && !state.noteSeen;
  useEffect(() => {
    if (unseen) markNoteSeen();
  }, [unseen]);
  useEffect(() => bridge?.onProgress?.(setProgress), []);

  // Hidden, or nothing to show here any more: back to Home.
  useEffect(() => {
    if (state && !askAiShown(state)) onBack();
  }, [state]);

  const version = state?.enabled ? state.installed?.version ?? null : null;
  useEffect(() => {
    if (!version || !bridge?.status) return;
    let current = true;
    bridge.status()
      .then(result => {
        if (!current) return;
        setStatus(result.ok ? result.status : null);
        setStatusError(result.ok ? null : result.error);
      })
      .catch(() => {});
    return () => { current = false; };
  }, [version]);

  async function act(id: AiAppId, action: () => Promise<AskAiResult>, done: string) {
    setBusy(id);
    setProgress(null);
    setNotes(n => ({ ...n, [id]: undefined }));
    try {
      const result = await action();
      setNotes(n => ({ ...n, [id]: result.ok ? { kind: 'done', text: result.message ?? done } : { kind: 'error', text: result.error } }));
    } catch {
      setNotes(n => ({ ...n, [id]: { kind: 'error', text: 'Something went wrong. Try again.' } }));
    } finally {
      setBusy(null);
      setProgress(null);
      refreshAskAi();
    }
  }

  async function copy(command: string) {
    await window.openextract.copyText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function hide() {
    setAskAiHidden(true);
    onBack();
  }

  const header = (
    <div className="titlebar px-5 border-b border-rule flex items-center gap-3">
      <button onClick={onBack} className="hearth-ghost-btn !px-3 !py-1.5">
        <ArrowLeftIcon size={18} />
        Back
      </button>
      <h1 className="text-xl text-text-primary">Ask AI</h1>
      <span className="text-sm text-text-tertiary">Ask an AI app about your backups</span>
    </div>
  );

  if (!state?.enabled || !bridge) {
    return <div className="h-screen flex flex-col bg-base">{header}</div>;
  }

  const names = appNames(state.apps);
  const them = state.apps.length > 1 ? 'them' : 'it';

  const progressRow = (id: AiAppId) => busy === id && (
    <div className="mt-3 flex items-center gap-2 text-sm text-text-secondary" role="status">
      <div className="w-4 h-4 border-2 border-accent-line border-t-accent rounded-full animate-spin flex-shrink-0" />
      {progressLine(progress)}
    </div>
  );
  // macOS keeps Finder's backup folder behind Full Disk Access, which it asks of the AI app itself.
  const fullDiskAccessRow = (id: AiAppId) => {
    const step = fullDiskAccessStep(id, state);
    if (!step) return null;
    return (
      <div className="mt-3 p-3 rounded-lg bg-accent-wash/50 border border-accent-line flex items-start gap-2.5">
        <LockIcon size={16} className="text-accent flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text-primary mb-1">{step.title}</p>
          <p className="text-xs text-text-secondary mb-2.5">{step.text}</p>
          <button className="hearth-ghost-btn !py-1.5" onClick={() => bridge.openFullDiskAccess()}>Open Settings</button>
        </div>
      </div>
    );
  };
  const noteRow = (id: AiAppId, extra?: ReactNode) => {
    const note = notes[id];
    if (!note || busy === id) return null;
    return (
      <div className={`mt-3 text-sm ${note.kind === 'error' ? 'text-apple-error' : 'text-text-primary'}`} role={note.kind === 'error' ? 'alert' : 'status'}>
        {note.text}
        {note.kind === 'done' && extra}
      </div>
    );
  };

  const cards: Record<AiAppId, ReactNode> = {
    claude: (() => {
      const connected = !!state.claude?.connected;
      return (
        <AppCard key="claude" name={APP_NAMES.claude} line={appStateLine('claude', state)} connected={connected}
          action={!connected && (
            <button className="hearth-primary-btn" disabled={busy !== null}
              onClick={() => act('claude', () => bridge.connectClaude(),
                "Claude is showing its own Install window. Click Install there, then come back here.")}>
              Install
            </button>
          )}>
          {fullDiskAccessRow('claude')}
          {progressRow('claude')}
          {noteRow('claude', !connected && (
            <div className="mt-2">
              <button className="hearth-ghost-btn !py-1.5" onClick={() => refreshAskAi()}>Check again</button>
            </div>
          ))}
        </AppCard>
      );
    })(),
    chatgpt: (() => {
      const chatgpt = state.chatgpt;
      const connected = !!chatgpt?.connected;
      const stale = connected && !chatgpt?.current && !!state.installed;
      return (
        <AppCard key="chatgpt" name={APP_NAMES.chatgpt} line={appStateLine('chatgpt', state)} connected={connected}
          action={(!connected || stale) && !askingChatGpt && (
            <button className="hearth-primary-btn" disabled={busy !== null} onClick={() => setAskingChatGpt(true)}>
              {stale ? 'Connect again' : 'Connect'}
            </button>
          )}>
          {askingChatGpt && (
            <div className="mt-3 p-3 rounded-lg bg-accent-wash/50 border border-accent-line">
              <p className="text-sm text-text-primary mb-1">This adds one entry to ChatGPT's settings file.</p>
              <p className="text-xs text-text-secondary mb-3 break-words">
                The file is {chatgpt?.settingsFile}. A copy of it as it is now is kept beside it, named {CODEX_BACKUP}.
              </p>
              <div className="flex flex-wrap gap-2">
                <button className="hearth-primary-btn !py-1.5"
                  onClick={() => {
                    setAskingChatGpt(false);
                    act('chatgpt', () => bridge.connectChatGpt(true), 'Done. Quit ChatGPT and open it again to use OpenExtract AI.');
                  }}>
                  Add it
                </button>
                <button className="hearth-ghost-btn !py-1.5" onClick={() => setAskingChatGpt(false)}>Cancel</button>
              </div>
            </div>
          )}
          {fullDiskAccessRow('chatgpt')}
          {progressRow('chatgpt')}
          {noteRow('chatgpt')}
        </AppCard>
      );
    })(),
    'claude-code': (() => {
      const command = state.claudeCode?.command ?? null;
      return (
        <AppCard key="claude-code" name={APP_NAMES['claude-code']} line={appStateLine('claude-code', state)} connected={false}
          action={!command && (
            <button className="hearth-primary-btn" disabled={busy !== null}
              onClick={() => act('claude-code', () => bridge.install(), 'Installed.')}>
              Install
            </button>
          )}>
          {command && (
            <div className="mt-3 flex flex-col gap-2">
              <code className="block px-3 py-2 rounded-lg bg-sand text-xs font-mono text-text-primary break-all">{command}</code>
              <div>
                <button className="hearth-ghost-btn !py-1.5" onClick={() => copy(command)}>
                  {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                  {copied ? 'Copied' : 'Copy the command'}
                </button>
              </div>
            </div>
          )}
          {progressRow('claude-code')}
          {noteRow('claude-code')}
        </AppCard>
      );
    })(),
  };

  return (
    <div className="h-screen flex flex-col bg-base">
      {header}
      <div className="flex-1 overflow-y-auto px-7 py-8">
        <div className="max-w-2xl mx-auto flex flex-col gap-6">
          <section>
            <div className="hearth-eyebrow mb-2">New</div>
            <h2 className="text-4xl text-text-primary mb-3">Ask questions about your backups</h2>
            <p className="text-base text-text-secondary leading-relaxed">
              OpenExtract AI is an add-on for {names}. It lets {them} read your iPhone backups on this computer
              and answer your questions about them.
            </p>
            <p className="mt-3 text-base text-text-primary">
              For example: <span className="font-serif-italic">“{EXAMPLE_QUESTION}”</span>
            </p>
          </section>

          <section className="hearth-card p-5">
            <h3 className="text-base font-semibold text-text-primary mb-3">Before you install</h3>
            <ul className="flex flex-col gap-2.5 text-sm text-text-secondary leading-relaxed list-disc pl-5">
              <li>
                <span className="text-text-primary font-medium">{PRICE_LINE}</span> {KEYS_LINE}
              </li>
              <li>What the AI reads goes to that AI's company: {companiesLine(state.apps)}.</li>
              <li>It only reads your backups. It never changes them.</li>
              <li>Passwords never go to the AI.</li>
            </ul>
          </section>

          {state.installed && (
            <section className="hearth-card px-5 py-4 flex items-center gap-3" aria-label="OpenExtract AI">
              <AskAiIcon size={22} className="text-accent flex-shrink-0" />
              <div className="text-sm">
                <div className="text-text-primary font-medium">OpenExtract AI {state.installed.version} is installed</div>
                {status && <div className="text-text-secondary">{statusLine(status)}</div>}
                {statusError && <div className="text-apple-error">{statusError}</div>}
              </div>
            </section>
          )}

          <section className="flex flex-col gap-3">
            <h3 className="text-base font-semibold text-text-primary">Connect an AI app</h3>
            {state.apps.map(id => cards[id])}
          </section>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-4">
            <button className="text-sm text-text-secondary hover:text-text-primary hover:underline" onClick={hide}>
              Don't show this again
            </button>
            <span className="text-xs text-text-tertiary">You can turn Ask AI back on in Settings.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppCard({ name, line, connected, action, children }: {
  name: string;
  line: string;
  connected: boolean;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="hearth-card px-5 py-4" aria-label={name}>
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-medium text-text-primary">{name}</div>
          <div className={`text-sm flex items-center gap-1.5 ${connected ? 'text-apple-success' : 'text-text-secondary'}`}>
            {connected && <CheckIcon size={16} />}
            {line}
          </div>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
