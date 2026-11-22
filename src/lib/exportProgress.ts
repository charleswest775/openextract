// How far along a long save is (OE-14). While it saves, the engine sends
// export.progress notifications, a few a second at most (python/export_progress.py):
//   { kind: 'photos', done, total, failed }
// done counts files handled so far, saved or not; failed is how many of those weren't.

export interface ExportProgress {
  kind: string;
  done: number;
  total: number;
  failed: number;
}

/** The progress in an engine notification, if it's export.progress for this kind of save. */
export function exportProgressFor(
  kind: string,
  notification: { method?: string; params?: Record<string, any> } | null | undefined,
): ExportProgress | null {
  if (notification?.method !== 'export.progress') return null;
  const p = notification.params;
  if (p?.kind !== kind || !Number.isFinite(p.done) || !Number.isFinite(p.total) || p.total <= 0) return null;
  return { kind, done: p.done, total: p.total, failed: Number.isFinite(p.failed) ? p.failed : 0 };
}

// Saving Messages conversations or WhatsApp chats adds where in the save that is
// (ChatSaveProgress in python/export_progress.py):
//   { kind: 'whatsapp', done, total, phase: 'reading' | 'saving', chat, chats, percent }
// done of total are the messages of chat number `chat`. A PDF save is several engine calls
// and then printing, so the main process says which PDF it's on (PdfStep in electron/pdfExport.ts):
//   pdf.progress { kind, part, parts, printing?: { file, files } }

export interface ChatProgress extends ExportProgress {
  phase: 'reading' | 'saving';
  chat: number;
  chats: number;
  /** How much of this engine call that makes, 0 to 100. */
  percent: number;
}

interface PdfStep {
  part: number;
  parts: number;
  printing?: { file: number; files: number };
}

/** The newest word from the engine and from the PDF printer about one save of chats. */
export interface ChatSave {
  progress: ChatProgress | null;
  step: PdfStep | null;
}

export const NO_CHAT_SAVE: ChatSave = { progress: null, step: null };

/** `save` brought up to date with a notification; the same object if it isn't about this kind of save. */
export function chatSaveAfter(
  save: ChatSave,
  kind: string,
  notification: { method?: string; params?: Record<string, any> } | null | undefined,
): ChatSave {
  const p = notification?.params;
  if (notification?.method === 'pdf.progress' && p?.kind === kind && Number.isFinite(p.part) && Number.isFinite(p.parts)) {
    // A new step: what the engine last said was about the one before
    return { progress: null, step: { part: p.part, parts: p.parts, printing: p.printing } };
  }
  const counts = exportProgressFor(kind, notification);
  if (!counts || (p?.phase !== 'reading' && p?.phase !== 'saving')) return save;
  if (![p.chat, p.chats, p.percent].every(Number.isFinite)) return save;
  return { ...save, progress: { ...counts, phase: p.phase, chat: p.chat, chats: p.chats, percent: p.percent } };
}

// Of a PDF save: planning it is the first tenth, then each part's share is mostly the engine's, then printing.
const PLANNING = 10;
const ENGINE_SHARE = 0.8;

/**
 * The line and bar over a save of chats, or null before there's anything to say:
 * "Saving PDF 2 of 5: 1,201 of 15,000 messages…", "Saving chat 3 of 40: …", "Making PDF 2 of 5…".
 */
export function chatSaveStatus(
  { progress, step }: ChatSave,
  noun: 'conversation' | 'chat',
): { text: string; percent: number } | null {
  if (step?.printing) {
    const { file, files } = step.printing;
    const printed = ENGINE_SHARE + (1 - ENGINE_SHARE) * (file - 1) / files;
    const inSave = step.parts > 1 ? (step.part - 1 + ENGINE_SHARE) / step.parts : printed;
    return {
      text: files > 1 ? `Making PDF ${file.toLocaleString()} of ${files.toLocaleString()}…` : 'Making the PDF…',
      percent: Math.round(PLANNING + (100 - PLANNING) * inSave),
    };
  }

  const pdf = step && step.parts > 1 ? `PDF ${step.part.toLocaleString()} of ${step.parts.toLocaleString()}` : '';
  let percent = progress?.percent ?? 0;
  if (step) {
    const inPart = ENGINE_SHARE * percent / 100;
    percent = Math.round(PLANNING + (100 - PLANNING) * (step.part - 1 + inPart) / step.parts);
  }
  if (!progress) return step ? { text: pdf ? `Saving ${pdf}…` : 'Saving…', percent } : null;

  const { phase, done, total, chat, chats } = progress;
  const which = pdf || (chats > 1 ? `${noun} ${chat.toLocaleString()} of ${chats.toLocaleString()}` : '');
  if (phase === 'reading' && pdf) return { text: `Saving ${pdf}…`, percent };
  // The message it's on while saving, as Photos counts the photo it's on
  const n = phase === 'saving' ? Math.min(done + 1, total) : done;
  const messages = `${n.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? 'message' : 'messages'}`;
  const verb = phase === 'saving' ? 'Saving' : 'Reading';
  return { text: which ? `${verb} ${which}: ${messages}…` : `${verb} ${messages}…`, percent };
}

/** How much of the bar to fill, 0 to 100. */
export function percentDone(p: ExportProgress): number {
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}
