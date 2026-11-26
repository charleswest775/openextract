import { useEffect, useState } from 'react';
import { Briefcase } from 'lucide-react';
import NoticeCard from './NoticeCard';
import { SUPPORT_BUSINESS_URL } from '../../lib/payItForward';

type Stage = 'ask' | 'opened';

/**
 * "Using it for paid work?": asked once, after a save, when this computer has saved from
 * many different iPhones in the past year (electron/businessUse.ts decides; the main
 * process sends it instead of the other cards on that export).
 *
 * OpenExtract stays free and MIT licensed, so this is a request, never a condition:
 * nothing in the app changes whatever the answer. "It's for work" opens the site's
 * business rates in the browser; "It's personal" and the × close it, and it doesn't
 * come back. The count is kept on this computer only, and the card says so.
 */
export default function BusinessUsePrompt() {
  const [devices, setDevices] = useState<number | null>(null);
  const [stage, setStage] = useState<Stage>('ask');

  useEffect(() => window.openextract?.onBusinessCard?.(n => {
    setDevices(n);
    setStage('ask');
  }), []);

  if (devices === null) return null;

  const close = () => setDevices(null);
  const personal = () => {
    window.openextract?.support?.answerBusiness?.('personal');
    close();
  };
  const work = () => {
    window.openextract?.support?.answerBusiness?.('work');
    window.openextract.openExternal(SUPPORT_BUSINESS_URL);
    setStage('opened');
  };

  if (stage === 'opened') {
    return (
      <NoticeCard title="Thanks for being straight with me" icon={<Briefcase size={16} />} onClose={close}>
        <p className="text-xs text-text-secondary leading-relaxed mb-3">
          The business rates are open in your browser. Your receipt will have your business name on it,
          so you can bill it to your client.
        </p>
        <p className="text-xs text-text-primary mb-3">— Charles</p>
        <div className="flex justify-end">
          <button className="hearth-primary-btn" onClick={close}>Close</button>
        </div>
      </NoticeCard>
    );
  }

  return (
    <NoticeCard title={`You've used OpenExtract on ${devices} iPhones in the past year`} icon={<Briefcase size={16} />} onClose={close} highlight>
      <p className="text-xs text-text-secondary leading-relaxed mb-2">
        Maybe you're the family's tech person, and that's great. If this is paid work, I ask businesses
        to pay <span className="text-text-primary font-medium">$50 a case</span> or{' '}
        <span className="text-text-primary font-medium">$200 a year</span>, with a receipt you can bill to
        your client. Nothing in the app changes either way.
        <span className="text-text-primary whitespace-nowrap"> — Charles</span>
      </p>
      <p className="text-[11px] text-text-tertiary mb-3">Counted only on this computer. Nothing is sent.</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button className="hearth-ghost-btn" onClick={personal}>It's personal</button>
        <button className="hearth-primary-btn" onClick={work}>It's for work</button>
      </div>
    </NoticeCard>
  );
}
