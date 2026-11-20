/**
 * Every PDF the app saves (GitHub issue #91): conversations, WhatsApp chats,
 * a person's history, notes, call history, web history, recovered messages,
 * and pages the window builds itself (the Timeline).
 *
 * The Python sidecar writes a print-ready HTML file (the same layout as the
 * HTML export, with images converted to JPEG in an attachments/ folder) into
 * a temporary folder; a page the window built is written there by us. We load
 * that file in a hidden, locked-down window, print it to PDF with Chromium,
 * write the PDF to the folder the user chose, and delete the temporary
 * folder. No new dependencies, and nothing leaves the computer: the hidden
 * window may only read files inside that folder.
 *
 * Chromium prints a whole page at once, so a page too big for it, or with more
 * photos than one PDF can hold, is refused before printing, in plain words.
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

type Sidecar = { call: (method: string, params: any, timeoutMs?: number) => Promise<any> };

// The engine exports that write print-ready HTML (format: 'pdf_source'), with any images
// in attachments/. Nothing else may be asked of the engine through here.
export type PdfExportMethod =
  | 'export_conversation' | 'export_conversations' | 'export_whatsapp_chat' | 'export_whatsapp_chats'
  | 'export_person' | 'export_notes' | 'export_calls' | 'export_browser_history' | 'export_recovered_messages';

export interface PdfExportResult {
  files: string[];
  message_count: number;
  /** How many records the engine says it saved (notes, calls, page visits), when it says. */
  count?: number;
  /** Where export_person copied a person's photos and files (it's given media_dir). */
  media_folder?: string;
  /** export_person: how many files were copied, weren't in the backup, or couldn't be copied. */
  media?: { copied: number; not_in_backup: number; failed: number };
  /** export_person: the parts that couldn't be read (e.g. WhatsApp), in plain words, by kind. */
  errors?: Record<string, string>;
}

/** export_person's file counts, when the engine sent numbers. */
function mediaCounts(m: any): PdfExportResult['media'] | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);
  return { copied: n(m.copied), not_in_backup: n(m.not_in_backup), failed: n(m.failed) };
}

/** export_person's unreadable parts, keeping only text. */
function partErrors(e: any): Record<string, string> | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const out = Object.fromEntries(Object.entries(e).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  return Object.keys(out).length ? out : undefined;
}

const STAGING_PREFIX = 'openextract-pdf-';

const ALLOWED_METHODS = new Set<PdfExportMethod>([
  'export_conversation', 'export_conversations', 'export_whatsapp_chat', 'export_whatsapp_chats',
  'export_person', 'export_notes', 'export_calls', 'export_browser_history', 'export_recovered_messages',
]);

// Chromium lays out and prints a whole page at once, in one renderer process. Past a few
// tens of millions of characters that takes minutes and gigabytes, and then the renderer
// runs out of memory (Electron 30: a Timeline of 100,000 events, ~55 million characters,
// took 37 s and ~4 GB; 200,000 ran ~3 minutes and crashed; 50,000 printed reliably). The
// Timeline counts its events before it builds the page (saveData.ts writeTimeline); this
// is the backstop for any page. The engine's pages are files, measured in bytes (UTF-8:
// at least one per character).
const MAX_PAGE_CHARS = 28 * 1024 * 1024;
const MAX_PAGE_BYTES = MAX_PAGE_CHARS;
// The pictures one page shows, as the engine staged them for printing (JPEGs, 1600 px at
// most, about half a megabyte each): some 3,000 photos, every one of them in the PDF.
const MAX_PICTURE_BYTES = 1.5 * 1024 * 1024 * 1024;

/** The limits above, for the tests. */
export const PDF_LIMITS = { pageChars: MAX_PAGE_CHARS, pageBytes: MAX_PAGE_BYTES, pictureBytes: MAX_PICTURE_BYTES };

const TOO_MUCH_PAGE = 'This is too much for one PDF. Narrow it down and try again.';
const TOO_MUCH_ENGINE_PAGE = 'This is too much for one PDF. Save it as a web page instead, which has no limit.';
const TOO_MANY_PICTURES = 'Too many photos for one PDF. Save it as a web page instead, which keeps every photo and video beside it.';
// The hidden window's renderer died while it loaded or printed the page: nearly always
// because it ran out of memory on a page that was too big.
const PRINTING_STOPPED = "Printing this PDF stopped, most likely because it's too much for one PDF. Save it as a web page instead, or save less at a time.";
// Once a renderer has died with printToPDF asked of it, every later printToPDF in this
// run of the app fails ("Printing failed"), in any window or session, until the app is
// restarted (Electron 30.5.1; reloading the window doesn't help).
const RESTART_BEFORE_NEXT_PDF = 'Quit and reopen OpenExtract before saving another PDF.';
const PDFS_NEED_RESTART = 'Quit and reopen OpenExtract to save PDFs again: printing stopped working after an earlier PDF was too big. Everything else still saves as usual.';
let printingBroken = false;

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
  let rendererGone = false;
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event: any) => event.preventDefault());
    win.webContents.on('render-process-gone', () => {
      rendererGone = true;
    });
    let pdf: Buffer;
    let printing = false;
    try {
      // Resolves after the page's load event, so every <img> has loaded.
      await win.loadFile(htmlPath);
      printing = true;
      pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: defaultPageSize(),
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      });
    } catch (err) {
      // printToPDF then fails with "Failed to generate PDF: Printing failed"; say what happened.
      if (rendererGone || win.webContents.isCrashed?.()) {
        if (!printing) throw new Error(PRINTING_STOPPED);
        printingBroken = true;
        throw new Error(`${PRINTING_STOPPED} ${RESTART_BEFORE_NEXT_PDF}`);
      }
      throw err;
    }
    try {
      fs.writeFileSync(pdfPath, pdf);
    } catch (err) {
      // No half-written PDF (a full disk): the name was free, so the file is ours.
      try {
        fs.rmSync(pdfPath, { force: true });
      } catch {
        // Nothing more to do; the error below is what the user sees.
      }
      throw err;
    }
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

/**
 * Bytes in the files under `dir` (links not followed), leaving out `except`.
 * Stops counting once past `limit`: the answer is then only "more than that".
 */
function filesSize(dir: string, except: string, limit: number): number {
  let total = 0;
  const pending = [dir];
  while (pending.length && total <= limit) {
    const current = pending.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && full !== except) total += fs.lstatSync(full).size;
      if (total > limit) break;
    }
  }
  return total;
}

/**
 * Refuse, before anything is printed, what Chromium can't print in one go: a page
 * that's too big, or (for a page of its own) more pictures than one PDF can hold.
 * Several pages share one attachments/ folder, so there the pictures can't be
 * told apart by page and aren't counted.
 */
function checkPrintable(pages: string[], staging: string): void {
  for (const page of pages) {
    if (fs.statSync(page).size > MAX_PAGE_BYTES) throw new Error(TOO_MUCH_ENGINE_PAGE);
  }
  if (pages.length === 1 && filesSize(staging, pages[0], MAX_PICTURE_BYTES) > MAX_PICTURE_BYTES) {
    throw new Error(TOO_MANY_PICTURES);
  }
}

/** A name as the folder knows it: Macs and Windows ignore case, and a Mac how an accent is encoded. */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** The names in a folder (as nameKey), or null if it can't be read. */
function namesIn(dir: string): Set<string> | null {
  try {
    return new Set(fs.readdirSync(dir).map(nameKey));
  } catch {
    return null;
  }
}

/** True when two paths are the same folder on disk, however they're spelled. */
function sameFolder(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    // Some network drives report no file ids; compare real paths there.
    if (sa.ino !== BigInt(0) && sb.ino !== BigInt(0)) return sa.dev === sb.dev && sa.ino === sb.ino;
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * Remove the folder of originals export_person copied for a PDF that couldn't be
 * made, so nothing is left behind and trying again doesn't copy everything into
 * "(2)". Only that exact folder, and only when it is a real folder (not a link)
 * directly inside the chosen folder that wasn't there before this export began:
 * the engine names a new one every time, so this is never the user's own.
 */
function removeNewMediaFolder(mediaFolder: unknown, chosenDir: string, namesBefore: Set<string> | null): void {
  if (typeof mediaFolder !== 'string' || !path.isAbsolute(mediaFolder) || !namesBefore) return;
  const folder = path.resolve(mediaFolder);
  const name = path.basename(folder);
  if (!name || namesBefore.has(nameKey(name))) return;
  try {
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    if (!sameFolder(path.dirname(folder), chosenDir)) return;
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (err) {
    console.warn('[pdf-export] could not remove the folder of copied files', folder, err);
  }
}

/**
 * Run an engine export as PDF. `params` are the same as for the HTML export;
 * `params.output_dir` is where the PDFs go. The engine is given a staging
 * folder instead; any other folder in `params` (export_person's media_dir,
 * where a person's photos and files are copied) is passed on as it is. If
 * export_person's PDF can't be made, the folder of originals it copied into
 * the chosen folder is removed again.
 */
export async function exportMessagesPdf(
  sidecar: Sidecar,
  method: PdfExportMethod,
  params: any,
): Promise<PdfExportResult> {
  if (!ALLOWED_METHODS.has(method)) throw new Error(`PDF export is not available for ${method}`);
  const outputDir = params?.output_dir;
  if (!outputDir || !fs.existsSync(outputDir)) throw new Error('Choose a folder to save the PDF in.');
  // Before the engine copies anything: the PDF couldn't be printed anyway
  if (printingBroken) throw new Error(PDFS_NEED_RESTART);

  // What's in the chosen folder before a person's originals are copied into it
  const namesBefore = method === 'export_person' ? namesIn(outputDir) : null;
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(app.getPath('temp'), STAGING_PREFIX)));
  activeStagingDirs.add(staging);
  let result: any;
  try {
    result = await sidecar.call(
      method,
      { ...params, format: 'pdf_source', output_dir: staging },
      SIDECAR_TIMEOUT_MS,
    );
    if (result?.error) throw new Error(result.error);
    // Notes say { status: 'error', message }; calls and web history { success: false, error }
    if (result?.status === 'error' || result?.success === false) {
      throw new Error(result.message || 'The export did not finish.');
    }

    const htmlFiles: string[] = result?.file ? [result.file] : (result?.files || []);
    const pages = htmlFiles.map(htmlFile => {
      const resolved = fs.realpathSync(htmlFile);
      if (!isInside(resolved, staging)) throw new Error('Unexpected export file location');
      return resolved;
    });
    checkPrintable(pages, staging);
    const pdfFiles: string[] = [];
    for (const page of pages) {
      const target = uniquePath(path.join(outputDir, `${path.basename(page, path.extname(page))}.pdf`));
      await htmlFileToPdf(page, target);
      pdfFiles.push(target);
    }
    return {
      files: pdfFiles,
      message_count: result?.message_count ?? 0,
      ...(typeof result?.count === 'number' ? { count: result.count } : {}),
      ...(typeof result?.media_folder === 'string' ? { media_folder: result.media_folder } : {}),
      ...(mediaCounts(result?.media) ? { media: mediaCounts(result?.media) } : {}),
      ...(partErrors(result?.errors) ? { errors: partErrors(result?.errors) } : {}),
    };
  } catch (err) {
    if (method === 'export_person') removeNewMediaFolder(result?.media_folder, outputDir, namesBefore);
    throw err;
  } finally {
    activeStagingDirs.delete(staging);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      console.warn('[pdf-export] could not remove temporary folder', staging, err);
    }
  }
}

// What can't be in a file name: folders, characters Windows refuses, control characters
// and the marks that reverse the direction of text (python/record_document.py's rule).
// eslint-disable-next-line no-control-regex
const FILE_NAME_UNSAFE = /[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/** A PDF's name from what the window sent: one file name, never a path, never empty. */
export function safeBaseName(name: unknown): string {
  const cleaned = String(name ?? '').replace(FILE_NAME_UNSAFE, ' ').replace(/\s+/g, ' ').trim()
    // A leading dot hides a file on a Mac; Windows drops trailing dots and spaces
    .replace(/^[.\s]+/, '').slice(0, 120).replace(/[.\s]+$/, '');
  if (!cleaned) return 'export';
  // Names Windows keeps for devices, with or without an extension ("CON.pdf")
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|\s|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Print a page the window built (the Timeline, saved as a PDF) to
 * `<outputDir>/<baseName>.pdf`, or "<baseName> (2).pdf" when that exists. The
 * page is printed exactly as the engine's are: in the hidden window with no
 * JavaScript, no network and no files outside its own staging folder, which
 * is deleted afterwards.
 */
export async function exportHtmlToPdf(html: unknown, outputDir: unknown, baseName: unknown): Promise<{ file: string }> {
  if (typeof html !== 'string') throw new Error('There was no page to save as a PDF.');
  if (html.length > MAX_PAGE_CHARS) throw new Error(TOO_MUCH_PAGE);
  if (typeof outputDir !== 'string' || !outputDir || !fs.existsSync(outputDir)) throw new Error('Choose a folder to save the PDF in.');
  if (printingBroken) throw new Error(PDFS_NEED_RESTART);

  const target = uniquePath(path.join(outputDir, `${safeBaseName(baseName)}.pdf`));
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(app.getPath('temp'), STAGING_PREFIX)));
  activeStagingDirs.add(staging);
  try {
    const page = path.join(staging, 'page.html');
    fs.writeFileSync(page, html, 'utf-8');
    await htmlFileToPdf(page, target);
    return { file: target };
  } finally {
    activeStagingDirs.delete(staging);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      console.warn('[pdf-export] could not remove temporary folder', staging, err);
    }
  }
}
