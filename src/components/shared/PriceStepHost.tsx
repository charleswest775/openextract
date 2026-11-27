import { useEffect, useState } from 'react';
import PriceStep from './PriceStep';
import { setPriceStepHost, type PriceStepRequest } from '../../lib/payItForward';

/**
 * The price step in a window of its own, for saves that don't go through the Save window
 * (photos, voicemail audio, anything with one format): askPriceFirst() opens it before the
 * folder picker. Going on (paying, saving free, saying thanks, "Already paid?") lets the save
 * continue; Back, Escape or a click outside goes back without saving. Mounted once, in App.
 */
export default function PriceStepHost() {
  const [request, setRequest] = useState<PriceStepRequest | null>(null);

  useEffect(() => setPriceStepHost(setRequest), []);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!request) return null;

  function finish(goOn: boolean) {
    request?.resolve(goOn);
    setRequest(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onClick={() => finish(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-dialog-title"
        className="w-full max-w-md rounded-2xl bg-surface border border-rule p-6 flex flex-col gap-4"
        style={{ boxShadow: '0 24px 48px rgba(30,26,22,0.22)' }}
        onClick={e => e.stopPropagation()}
      >
        <PriceStep onContinue={() => finish(true)} onBack={() => finish(false)} thanksSent={request.thanksSent} />
      </div>
    </div>
  );
}
