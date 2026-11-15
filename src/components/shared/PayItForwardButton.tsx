import { useEffect, useRef, useState } from 'react';
import { Heart } from 'lucide-react';
import { onExport, showAsk } from '../../lib/payItForward';

/**
 * "Pay it forward" in the title bar, on every screen. It stays still, except for
 * one soft glow (about two seconds) after each export, for people who haven't
 * said they paid; none under reduced motion (.pay-glow in index.css). Clicking
 * it shows the ask card.
 */
export default function PayItForwardButton({ labelClass = 'hidden lg:inline' }: { labelClass?: string }) {
  const [glowing, setGlowing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off = onExport(async () => {
      const status = await window.openextract?.support?.status?.().catch(() => null);
      if (status?.paid) return;
      setGlowing(false);
      // Restart the animation on the next frame, so back-to-back exports each glow.
      requestAnimationFrame(() => setGlowing(true));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setGlowing(false), 2600);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <button
      onClick={() => showAsk({ mode: 'header' })}
      title="Pay it forward"
      aria-label="Pay it forward"
      className={`pay-it-forward flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${glowing ? 'pay-glow' : ''}`}
    >
      <Heart size={16} fill="currentColor" aria-hidden="true" />
      <span className={labelClass}>Pay it forward</span>
    </button>
  );
}
