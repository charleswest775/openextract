import { useEffect, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import NoticeCard from './NoticeCard';
import { useUpdates } from '../../hooks/useUpdates';
import type { FixedReport } from '../../types';

/**
 * "The problem you reported is fixed." Closes the loop on reports sent from the
 * feedback form: the main process checks on open reports every few days
 * (electron/feedbackReports.ts), and this shows each fix once.
 */
export default function FixedReportNotice() {
  const [fixed, setFixed] = useState<FixedReport[]>([]);
  const { state: updates, check } = useUpdates();

  useEffect(() => {
    const api = window.openextract?.feedback;
    if (!api?.fixedReports) return;
    const load = () => api.fixedReports().then(setFixed).catch(() => {});
    load();
    return api.onFixed(load);
  }, []);

  const report = fixed[0];
  if (!report) return null;

  const dismiss = () => {
    window.openextract.feedback.markAnnounced(report.reference);
    setFixed(rest => rest.slice(1));
  };
  const getUpdate = () => {
    if (updates?.supported) check();
    else window.openextract.openExternal('https://www.openextract.app');
    dismiss();
  };
  const sent = new Date(report.sentAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

  return (
    <NoticeCard title="Fixed: a problem you reported" icon={<CircleCheck size={16} />} onClose={dismiss}>
      <p className="text-xs text-text-primary leading-relaxed mb-1">“{report.summary}”</p>
      <p className="text-xs text-text-secondary leading-relaxed mb-3">
        You sent this on {sent} ({report.reference}).{' '}
        {report.inThisVersion
          ? report.fixedIn
            ? `It's fixed in OpenExtract ${report.fixedIn}, which you have.`
            : "It's been fixed."
          : `It's fixed in OpenExtract ${report.fixedIn}. Update to get the fix.`}
        {' '}Thanks for telling us.
      </p>
      <div className="flex justify-end gap-2">
        {report.inThisVersion ? (
          <button className="hearth-primary-btn" onClick={dismiss}>Done</button>
        ) : (
          <>
            <button className="hearth-ghost-btn" onClick={dismiss}>Later</button>
            <button className="hearth-primary-btn" onClick={getUpdate}>Get the update</button>
          </>
        )}
      </div>
    </NoticeCard>
  );
}
