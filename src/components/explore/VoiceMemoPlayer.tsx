import { useEffect, useState } from 'react';

interface Props {
  udid: string;
  memoId: number;
  autoPlay?: boolean;
}

type PlayerState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string };

/**
 * Plays a voice memo in the app, with "Open in default app" for recordings
 * that are too long to load here or in a format the player can't decode
 * (e.g. Apple Lossless).
 */
export default function VoiceMemoPlayer({ udid, memoId, autoPlay = false }: Props) {
  const [state, setState] = useState<PlayerState>({ status: 'loading' });
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setState({ status: 'loading' });
    window.openextract.call('get_voice_memo_audio', { udid, memo_id: memoId })
      .then((res: any) => {
        if (cancelled) return;
        const data = res.success ? res.data : null;
        if (!data || data.error) {
          setState({ status: 'error', message: data?.error || res.error || "Couldn't load this recording." });
          return;
        }
        const bin = atob(data.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        url = URL.createObjectURL(new Blob([bytes], { type: data.mime_type }));
        setState({ status: 'ready', url });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: "Couldn't load this recording." });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [udid, memoId]);

  async function openInDefaultApp() {
    setOpening(true);
    try {
      const res = await window.openextract.call('get_voice_memo_file', { udid, memo_id: memoId });
      if (res.success && res.data?.path) {
        await window.openextract.openPath(res.data.path);
      } else {
        setState({ status: 'error', message: res.data?.error || res.error || "Couldn't open this recording." });
      }
    } finally {
      setOpening(false);
    }
  }

  const openButton = (
    <button
      onClick={openInDefaultApp}
      disabled={opening}
      className="text-xs text-text-secondary underline underline-offset-2 hover:text-text-primary disabled:opacity-50"
    >
      Open in default app
    </button>
  );

  if (state.status === 'loading') {
    return <div className="text-sm text-text-tertiary animate-pulse h-10 flex items-center">Loading audio…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-text-secondary">{state.message}</span>
        {openButton}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <audio
        controls
        autoPlay={autoPlay}
        src={state.url}
        className="h-10 w-full max-w-md"
        onError={() => setState({ status: 'error', message: "This recording's format can't play here." })}
      />
      {openButton}
    </div>
  );
}
