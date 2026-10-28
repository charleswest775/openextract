/**
 * PDF export of message conversations (GitHub issue #91).
 *
 * The Python sidecar writes a print-ready HTML file (the same layout as the
 * HTML export, with images converted to JPEG in an attachments/ folder) into
 * a temporary folder. We load that file in a hidden, locked-down window,
 * print it to PDF with Chromium, write the PDF to the folder the user chose,
 * and delete the temporary folder. No new dependencies, and nothing leaves
 * the computer: the hidden window may only read files inside that folder.
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

type Sidecar = { call: (method: string, params: any, timeoutMs?: number) => Promise<any> };

export type PdfExportMethod = 'export_conversation' | 'export_conversations';

export interface PdfExportResult {
  files: string[];
  message_count: number;
}

const STAGING_PREFIX = 'openextract-pdf-';

const ALLOWED_METHODS = new Set<PdfExportMethod>(['export_conversation', 'export_conversations']);

// Copying and converting every image in a long thread can take a while.
const SIDECAR_TIMEOUT_MS = 60 * 60 * 1000;

// In-memory session (no "persist:" prefix), separate from the app's own.
const PDF_PARTITION = 'openextract-pdf-export';

// Folders the hidden window is currently allowed to read from.
const activeStagingDirs = new Set<string>();
let sessionConfigured = false;

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function pdfSession(): any {
  const ses = session.fromPartition(PDF_PARTITION);
  if (!sessionConfigured) {
    // Block every request except files inside an active staging folder, so a
    // printed page can never reach the network or read other local files.
    ses.webRequest.onBeforeRequest((details: any, callback: (r: { cancel: boolean }) => void) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        if (url.protocol === 'file:') {
          const filePath = path.resolve(fileURLToPath(url));
          allowed = [...activeStagingDirs].some(dir => isInside(filePath, dir));
        }
      } catch {
        allowed = false;
      }
      callback({ cancel: !allowed });
    });
    // On Windows and Linux a new session downloads spell-check dictionaries
    // from Google unless it has no languages. This window never needs them.
    ses.setSpellCheckerEnabled(false);
    try {
      ses.setSpellCheckerLanguages([]);
    } catch {
      // No-op on macOS, which uses the system spell checker.
    }
    ses.setPermissionRequestHandler((_wc: any, _permission: string, callback: (ok: boolean) => void) => callback(false));
    sessionConfigured = true;
  }
  return ses;
}

/** Letter for the countries that use it, A4 everywhere else. */
function defaultPageSize(): 'Letter' | 'A4' {
  let country = '';
  try {
    country = (app.getLocaleCountryCode() || '').toUpperCase();
  } catch {
    // Not available on every platform; fall back to the locale string.
  }
  if (!country) {
    const parts = (app.getLocale() || '').split('-');
    country = (parts[1] || '').toUpperCase();
  }
  return ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'PR'].includes(country) ? 'Letter' : 'A4';
}

/** "Mom.pdf", or "Mom (2).pdf" if that exists, so we never overwrite a file. */
function uniquePath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${base} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

/** Render one local HTML file to a PDF file. */
async function htmlFileToPdf(htmlPath: string, pdfPath: string): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    width: 820,
    height: 1100,
    webPreferences: {
      session: pdfSession(),
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event: any) => event.preventDefault());
    // Resolves after the page's load event, so every <img> has loaded.
    await win.loadFile(htmlPath);
    const pdf: Buffer = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: defaultPageSize(),
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    });
    fs.writeFileSync(pdfPath, pdf);
  } finally {
    await closeWindow(win);
  }
}

/**
 * Close the hidden window and wait until it is gone. A plain destroy() can
 * leave the next export's window failing to load (seen with Electron 30), so
 * close gracefully and only destroy if that takes too long.
 */
function closeWindow(win: any): Promise<void> {
  if (win.isDestroyed()) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
      resolve();
    }, 5000);
    win.once('closed', () => {
      clearTimeout(timer);
      resolve();
    });
    win.close();
  });
}

/**
 * Delete temporary folders left behind by an export that never finished (for
 * example, the app was quit mid-export). They hold copies of message photos,
 * so they shouldn't linger. Call once at startup.
 */
export function removeStaleStagingDirs(maxAgeMs = 60 * 60 * 1000): void {
  try {
    const tempDir = app.getPath('temp');
    for (const name of fs.readdirSync(tempDir)) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      const dir = path.join(tempDir, name);
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory() && Date.now() - stat.mtimeMs > maxAgeMs && !activeStagingDirs.has(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // Not ours to worry about (permissions, already gone).
      }
    }
  } catch (err) {
    console.warn('[pdf-export] could not check for old temporary folders', err);
  }
}

/**
 * Run a conversation export as PDF. `params` are the same as for the HTML
 * export; `params.output_dir` is where the PDFs go.
 */
export async function exportMessagesPdf(
  sidecar: Sidecar,
  method: PdfExportMethod,
  params: any,
): Promise<PdfExportResult> {
  if (!ALLOWED_METHODS.has(method)) throw new Error(`PDF export is not available for ${method}`);
  const outputDir = params?.output_dir;
  if (!outputDir || !fs.existsSync(outputDir)) throw new Error('Choose a folder to save the PDF in.');

  const staging = fs.realpathSync(fs.mkdtempSync(path.join(app.getPath('temp'), STAGING_PREFIX)));
  activeStagingDirs.add(staging);
  try {
    const result = await sidecar.call(
      method,
      { ...params, format: 'pdf_source', output_dir: staging },
      SIDECAR_TIMEOUT_MS,
    );
    if (result?.error) throw new Error(result.error);

    const htmlFiles: string[] = result?.file ? [result.file] : (result?.files || []);
    const pdfFiles: string[] = [];
    for (const htmlFile of htmlFiles) {
      const resolved = fs.realpathSync(htmlFile);
      if (!isInside(resolved, staging)) throw new Error('Unexpected export file location');
      const target = uniquePath(path.join(outputDir, `${path.basename(resolved, path.extname(resolved))}.pdf`));
      await htmlFileToPdf(resolved, target);
      pdfFiles.push(target);
    }
    return { files: pdfFiles, message_count: result?.message_count ?? 0 };
  } finally {
    activeStagingDirs.delete(staging);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      console.warn('[pdf-export] could not remove temporary folder', staging, err);
    }
  }
}
