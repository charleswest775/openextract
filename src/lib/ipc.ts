/**
 * IPC client for communicating with the Python sidecar via Electron.
 * In dev mode without Electron, falls back to mock data.
 */

const isElectron = typeof window !== 'undefined' && window.openextract;

export async function sidecarCall<T = any>(method: string, params: any = {}): Promise<T> {
  if (!isElectron) {
    console.warn(`[Mock] sidecar.${method}`, params);
    throw new Error('Not running in Electron. Start with: npm run dev');
  }

  const result = await window.openextract.call(method, params);
  if (!result.success) {
    throw new Error(result.error || 'Unknown error');
  }
  return result.data as T;
}

/**
 * The engine exports that can be printed to PDF (electron/pdfExport.ts): each writes a
 * print-ready page that Electron prints with Chromium.
 */
export type PdfExportMethod =
  | 'export_conversation' | 'export_conversations' | 'export_whatsapp_chat' | 'export_whatsapp_chats'
  | 'export_person' | 'export_notes' | 'export_calls' | 'export_browser_history' | 'export_recovered_messages';

/** What a PDF save wrote: the PDFs, the engine's message count, and its record count when it gives one. */
export interface PdfExportResult {
  files: string[];
  message_count: number;
  count?: number;
  media_folder?: string;
  /** export_person: how many files were copied, weren't in the backup, or couldn't be copied. */
  media?: { copied: number; not_in_backup: number; failed: number };
  /** export_person: the parts that couldn't be read, by kind. */
  errors?: Record<string, string>;
}

/** Save an engine export (conversations, chats, notes, calls…) as PDF. Resolves to the PDF paths written. */
export async function exportMessagesPdf(method: PdfExportMethod, params: any): Promise<PdfExportResult> {
  if (!isElectron) {
    throw new Error('Not running in Electron. Start with: npm run dev');
  }
  const result = await window.openextract.exportPdf(method, params);
  if (!result.success || !result.data) {
    throw new Error(result.error || 'PDF export failed');
  }
  return result.data;
}

/**
 * Print a page the window built (the Timeline's saved page) to `<outputDir>/<baseName>.pdf`,
 * or "<baseName> (2).pdf" when that exists. Resolves to the PDF's path.
 */
export async function exportHtmlPdf(html: string, outputDir: string, baseName: string): Promise<{ file: string }> {
  if (!isElectron) {
    throw new Error('Not running in Electron. Start with: npm run dev');
  }
  const result = await window.openextract.exportHtmlPdf(html, outputDir, baseName);
  if (!result.success || !result.data) {
    throw new Error(result.error || 'PDF export failed');
  }
  return result.data;
}

export async function selectFolder(): Promise<string | null> {
  if (!isElectron) return null;
  return window.openextract.selectFolder();
}

export async function saveFolder(): Promise<string | null> {
  if (!isElectron) return null;
  return window.openextract.saveFolder();
}
