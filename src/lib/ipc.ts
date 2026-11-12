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

/** The engine exports that can be printed to PDF: Messages conversations and WhatsApp chats. */
export type PdfExportMethod = 'export_conversation' | 'export_conversations' | 'export_whatsapp_chat' | 'export_whatsapp_chats';

/** Export one or more conversations (or WhatsApp chats) as PDF. Resolves to the PDF paths written. */
export async function exportMessagesPdf(
  method: PdfExportMethod,
  params: any,
): Promise<{ files: string[]; message_count: number }> {
  if (!isElectron) {
    throw new Error('Not running in Electron. Start with: npm run dev');
  }
  const result = await window.openextract.exportPdf(method, params);
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
