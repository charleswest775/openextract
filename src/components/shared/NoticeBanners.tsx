export interface ExportStatus {
  ok: boolean;
  text: string;
}

/** Load problems (warning banner) and the last export's outcome, shown under an explorer header. */
export default function NoticeBanners({ errors, status }: { errors: string[]; status: ExportStatus | null }) {
  return (
    <>
      {errors.length > 0 && (
        <div className="px-4 py-2.5 border-b border-amber-200 bg-amber-50 text-xs text-amber-800 space-y-1 flex-shrink-0">
          {errors.map((e) => <p key={e}>{e}</p>)}
        </div>
      )}
      {status && (
        <div className={`px-4 py-2.5 border-b border-rule bg-surface text-xs flex-shrink-0 ${
          status.ok ? 'text-apple-success' : 'text-apple-error'
        }`}>
          {status.text}
        </div>
      )}
    </>
  );
}
