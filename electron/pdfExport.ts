/**
 * PDF export of message conversations (GitHub issue #91) and WhatsApp chats.
 *
 * The Python sidecar writes a print-ready HTML file (the same layout as the
 * HTML export, with images converted to JPEG in an attachments/ folder) into
 * a temporary folder. We load that file in a hidden, locked-down window,
 * print it to PDF with Chromium, write the PDF to the folder the user chose,
 * and delete the temporary folder. No new dependencies, and nothing leaves
 * the computer: the hidden window may only read files inside that folder.
 *
 * A PDF holds its photos whole, so a long chat's can be gigabytes. The engine
 * plans the save first (plan_pdf_parts, python/pdf_parts.py): a chat too big
 * for one sensible file is split by year, and each part is saved here as its
 * own engine call, folder and PDF. The result says what was split and why.
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

type Sidecar = { call: (method: string, params: any, timeoutMs?: number) => Promise<any> };

// Messages conversations and WhatsApp chats: the engine writes both as print-ready HTML
// with their images in attachments/ (format: 'pdf_source').
export type PdfExportMethod = 'export_conversation' | 'export_conversations' | 'export_whatsapp_chat' | 'export_whatsapp_chats';

/** A conversation whose PDF was split by year, for telling the person why. */
export interface PdfSplit {
  /** Whose PDF: the conversation's name, or null for everything saved into one file ("merged"). */
  name: string | null;
  /** The parts, in order: "2023", "2019–2021", "Jan–Jun 2024". */
  labels: string[];
  messages: number;
  images: number;
  /** About how big one PDF of all of it would have been. */
  estimate: { pages: number; megabytes: number };
}

export interface PdfExportResult {
  files: string[];
  message_count: number;
  /** Conversations split into several PDFs; empty when every PDF fit in one file. */
  splits: PdfSplit[];
}

const STAGING_PREFIX = 'openextract-pdf-';

const ALLOWED_METHODS = new Set<PdfExportMethod>([
  'export_conversation', 'export_conversations', 'export_whatsapp_chat', 'export_whatsapp_chats',
]);

// Copying and converting every image in a long thread can take a while. A save
// split by year has this long for each part.
const SIDECAR_TIMEOUT_MS = 60 * 60 * 1000;

// Planning reads every message once, but converts nothing.
const PLAN_TIMEOUT_MS = 30 * 60 * 1000;

// "Save all" methods, and the one-chat method each split conversation is saved with.
const ONE_CHAT_METHOD: Partial<Record<PdfExportMethod, PdfExportMethod>> = {
  export_conversations: 'export_conversation',
  export_whatsapp_chats: 'export_whatsapp_chat',
};

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
    // Real path, as the running exports' folders in activeStagingDirs are (the temp
    // path can go through a symlink or junction, e.g. macOS /var -> /private/var).
    const tempDir = fs.realpathSync(app.getPath('temp'));
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

/** One engine call of a PDF save, and the PDFs it makes. */
interface PdfJob {
  method: PdfExportMethod;
  params: any;
}

interface PlanGroup {
  chat_ids: number[];
  split: boolean;
  messages: number;
  images: number;
  estimate: { pages: number; megabytes: number };
  parts: Array<{ label: string | null } & Record<string, unknown>>;
}

/**
 * Ask the engine how this save should be split, and turn that into engine calls.
 * Nothing to split (or a plan that couldn't be made) is the one call asked for.
 */
async function planJobs(
  sidecar: Sidecar,
  method: PdfExportMethod,
  params: any,
): Promise<{ jobs: PdfJob[]; splits: PdfSplit[] }> {
  const asked = { jobs: [{ method, params }], splits: [] };
  const oneMethod = ONE_CHAT_METHOD[method];
  const merged = !!oneMethod && params.mode === 'merged';
  const chatIds: number[] = oneMethod ? (params.chat_ids || []) : [params.chat_id];
  let groups: PlanGroup[];
  try {
    const plan = await sidecar.call('plan_pdf_parts', {
      udid: params.udid,
      source: method.includes('whatsapp') ? 'whatsapp' : 'messages',
      chat_ids: chatIds,
      mode: merged ? 'merged' : 'separate',
      date_from: params.date_from,
      date_to: params.date_to,
      query: params.query,
    }, PLAN_TIMEOUT_MS);
    groups = plan?.groups;
  } catch (err) {
    // The save itself then reports whatever is wrong (or works, in one file).
    console.warn('[pdf-export] could not plan the save', err);
    return asked;
  }
  if (!Array.isArray(groups) || !groups.some(g => g?.split)) return asked;

  const names: Record<string, string> = params.conversation_names || {};
  const nameOf = (chatId: number): string | null => (oneMethod ? names[chatId] : params.display_name) ?? null;
  const jobs: PdfJob[] = [];
  const splits: PdfSplit[] = [];
  for (const group of groups) {
    if (group.split) {
      splits.push({
        name: merged ? null : nameOf(group.chat_ids[0]),
        labels: group.parts.map(p => p.label ?? ''),
        messages: group.messages,
        images: group.images,
        estimate: group.estimate,
      });
    }
    if (merged || !oneMethod) {
      for (const part of group.parts) jobs.push({ method, params: { ...params, part } });
      continue;
    }
    // One conversation of a "Save all", in its own file(s).
    const { chat_ids: _ids, conversation_names: _names, mode: _mode, ...common } = params;
    const chatId = group.chat_ids[0];
    for (const part of group.parts) {
      jobs.push({ method: oneMethod, params: { ...common, chat_id: chatId, display_name: names[chatId], part } });
    }
  }
  return { jobs, splits };
}

/** Run one engine call into a fresh temporary folder and print what it wrote. */
async function runJob(sidecar: Sidecar, job: PdfJob, outputDir: string): Promise<{ files: string[]; message_count: number }> {
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(app.getPath('temp'), STAGING_PREFIX)));
  activeStagingDirs.add(staging);
  try {
    const result = await sidecar.call(
      job.method,
      { ...job.params, format: 'pdf_source', output_dir: staging },
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

  const { jobs, splits } = await planJobs(sidecar, method, params);
  const files: string[] = [];
  let messageCount = 0;
  for (const job of jobs) {
    try {
      const done = await runJob(sidecar, job, outputDir);
      files.push(...done.files);
      messageCount += done.message_count;
    } catch (err: any) {
      // Parts already saved stay saved: say so, so nobody saves them again.
      if (files.length === 0) throw err;
      const message = String(err?.message ?? err).replace(/\.?$/, '.');
      throw new Error(`${message} The first ${files.length === 1 ? 'PDF was' : `${files.length} PDFs were`} saved before this happened.`);
    }
  }
  return { files, message_count: messageCount, splits };
}
