import { useCallback, useEffect, useState } from 'react';
import type { UpdatesState } from '../types';

/**
 * Live auto-update state from the main process. `state` is null until loaded, and stays
 * null outside Electron (e.g. the renderer running in a plain browser).
 */
export function useUpdates() {
  const [state, setState] = useState<UpdatesState | null>(null);
  const api = typeof window !== 'undefined' ? window.openextract?.updates : undefined;

  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.getState().then(s => { if (alive) setState(s); });
    const off = api.onStatus(status => setState(s => (s ? { ...s, status } : s)));
    return () => { alive = false; off(); };
  }, [api]);

  const setAutoCheck = useCallback(async (enabled: boolean) => {
    if (!api) return;
    setState(s => (s ? { ...s, autoCheck: enabled } : s));
    await api.setAutoCheck(enabled);
  }, [api]);

  return {
    state,
    setAutoCheck,
    check: () => api?.check(),
    download: () => api?.download(),
    install: () => api?.install(),
  };
}

export function releaseNotesUrl(releasesUrl: string, version?: string) {
  return version ? `${releasesUrl}/tag/v${version}` : releasesUrl;
}
