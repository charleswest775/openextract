import { useState } from 'react';
import { Heart } from 'lucide-react';
import { ExportIcon } from './Icons';
import { PRICE_STEP_AMOUNTS, PRICE_STEP_SUGGESTED, openThanks, priceStepUrl, type PriceStepAmount } from '../../lib/payItForward';
import type { FeedbackArea } from '../../lib/feedback';

/**
 * "What's this worth to you?": the price step in the Save window, between picking a format
 * and saving (SaveDialog decides when, with priceStepDue). It never stands in the way of the
 * save: "Save without paying" is a full button, not a hidden link, and paying opens the
 * payment page in the browser while the save starts right away. "Can't pay?" saves and opens
 * the thank-you note. "Already paid?" ends the asks for good, on trust, as on the card.
 *
 * "Apps like this cost $30 to $50" is from the site's iMazing alternatives page (iBackup
 * Viewer Pro $29.95 once, iMazing $49.99 a year); "fewer than 1 in 100 people pay" is
 * Charles's figure (2026-11). The Pay button isn't focused when the step opens, so Enter
 * pressed out of habit from the format step doesn't open a payment page.
 */
export default function PriceStep({ onContinue, onBack, thanksSent = false, area = 'export' }: {
  /** Goes on with the save the person chose. */
  onContinue: () => void;
  /** Back to the formats. */
  onBack: () => void;
  /** A thank-you already went out from this computer: no "Can't pay?" link. */
  thanksSent?: boolean;
  /** What's being saved, for the thank-you note. */
  area?: FeedbackArea;
}) {
  const [amount, setAmount] = useState<PriceStepAmount>(PRICE_STEP_SUGGESTED);
  const chosen = PRICE_STEP_AMOUNTS.find(a => a.id === amount)!;

  const pay = () => {
    window.openextract?.openExternal?.(priceStepUrl(amount));
    onContinue();
  };
  const sayThanks = () => {
    onContinue();
    openThanks(area);
  };
  const alreadyPaid = () => {
    window.openextract?.support?.markPaid?.();
    onContinue();
  };

  return (
    <div className="flex flex-col gap-4" data-price-step>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-accent-wash border border-accent-line flex items-center justify-center font-serif text-lg text-accent flex-shrink-0" aria-hidden="true">
          C
        </div>
        <h2 id="save-dialog-title" className="text-xl text-text-primary leading-tight">What's this worth to you?</h2>
      </div>

      <div className="space-y-2 text-sm text-text-secondary leading-relaxed">
        <p>OpenExtract is free, and this save is yours either way.</p>
        <p>
          Apps like this cost $30 to $50. I build and fix OpenExtract on my own time, and fewer than
          1 in 100 people pay. If it's getting you what you came for, please pay what it's worth.
          <span className="text-text-primary whitespace-nowrap"> — Charles</span>
        </p>
      </div>

      <div role="radiogroup" aria-label="Amount" className="grid grid-cols-4 gap-2">
        {PRICE_STEP_AMOUNTS.map(a => {
          const on = a.id === amount;
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setAmount(a.id)}
              className={`px-2 py-2.5 rounded-xl border text-center transition-colors ${
                on ? 'border-accent bg-accent-wash' : 'border-rule hover:bg-elevated'
              }`}
            >
              <span className="block text-[17px] font-medium text-text-primary">{a.label}</span>
              <span className="block text-[11px] text-text-tertiary mt-0.5 h-4 truncate">{a.note}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <button type="button" onClick={pay} className="hearth-primary-btn justify-center">
          <Heart size={15} fill="currentColor" aria-hidden="true" />
          {amount === 'any' ? 'Pay what you want and save' : `Pay ${chosen.label} and save`}
        </button>
        <button type="button" onClick={onContinue} className="hearth-ghost-btn justify-center">
          <ExportIcon size={18} />
          Save without paying
        </button>
      </div>

      <p className="-mt-1 text-center text-[11px] text-text-tertiary">
        The payment page opens in your browser. Your save starts right away.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-text-tertiary">
        <button type="button" onClick={onBack} className="hover:text-text-primary hover:underline">← Back</button>
        <span className="flex gap-4">
          {!thanksSent && (
            <button type="button" onClick={sayThanks} className="hover:text-text-primary hover:underline">Can't pay? Say thanks</button>
          )}
          <button type="button" onClick={alreadyPaid} className="hover:text-text-primary hover:underline">Already paid? Don't ask again</button>
        </span>
      </div>
    </div>
  );
}
