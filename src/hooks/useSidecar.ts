import { useState, useEffect } from 'react';
import { sidecarCall } from '../lib/ipc';

export function useSidecar() {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function ping() {
      try {
        await sidecarCall<{ status: string }>('ping');
        setConnected(true);
      } catch (err: any) {
        setError(err.message);
        setConnected(false);
      }
    }
    ping();
  }, []);

  return { connected, error };
}
