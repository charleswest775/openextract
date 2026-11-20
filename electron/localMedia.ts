export {};
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
import { isInsideFolder } from './installFolder';

/**
 * Videos and sounds the window plays straight from disk, and the poster frames
 * it shows for videos.
 *
 * The engine never hands the window a file where it lies in a backup. It copies
 * the file out under its own name, into a folder of its own in the system's temp
 * folder (python/app_copies.py: "openextract-<part>-<engine's process id>-<random>"),
 * or, for an encrypted backup, gives the file ios-backup-core has already
 * decrypted into "iosbackup_<random>" when that keeps its extension (photos.py
 * get_file_for_app). Those folders are the only places the local-media://
 * protocol and media:thumbnail read from: the window shows backup content, and a
 * link or name in that content must never get it to read anything else on the
 * computer. Paths are compared as real paths, so a link inside a copy folder
 * that points elsewhere is refused, and macOS's /var (a link to /private/var)
 * or a Windows short name still match.
 *
 * The protocol answers Range requests itself (206 Partial Content with
 * Content-Range). Electron's net.fetch of a file:// URL ignores Range, and with
 * the headers passed on it sends the slice as a plain 200, so a <video> could
 * play but never seek: checked on Electron 30.
 */

// python/app_copies.py's folders, one per part of the app and engine
const APP_COPY_FOLDER = /^openextract-[a-z]+-\d+-[^\\/]+$/;
// ios-backup-core's backup.py: tempfile.mkdtemp(prefix="iosbackup_")
const DECRYPTED_FOLDER = /^iosbackup_[^\\/]+$/;

// What the protocol serves, by extension, with the type it's sent as.
const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.caf': 'audio/x-caf', '.amr': 'audio/amr',
};

// What media:thumbnail makes a picture of: videos and photos only. The system's
// previewer (Quick Look, the Windows shell) reads the file to draw it, and
// nothing else needs a poster.
const THUMBNAIL_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.3gp', '.webm', '.mkv', '.avi',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff',
]);

const THUMBNAIL_TIMEOUT_MS = 15_000;
const DEFAULT_THUMBNAIL_PX = 480;

function extensionOf(file: string): string {
  return path.extname(file).toLowerCase();
}

/**
 * The real path of `candidate` when it is a file inside one of the engine's copy
 * folders in one of `tempDirs`, else null. `tempDirs` are the system's temp
 * folders (the engine's and Electron's agree, but each is checked).
 *
 * The paths are this computer's own (real paths from the file system), so they're
 * compared by this computer's rules, whatever `platform` the caller passes for
 * deciding what the computer can do: comparing Windows paths by macOS rules would
 * refuse every one.
 */
export function appCopyPath(candidate: unknown, tempDirs: string[], _platform: string = process.platform): string | null {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) return null;
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null; // not there, or not readable
  }
  for (const dir of tempDirs) {
    let root: string;
    try {
      root = fs.realpathSync.native(dir);
    } catch {
      continue;
    }
    if (!isInsideFolder(real, root)) continue;
    const [top, ...below] = path.relative(root, real).split(path.sep);
    // A file in the folder (or below it), never the folder itself
    if (below.length > 0 && (APP_COPY_FOLDER.test(top) || DECRYPTED_FOLDER.test(top))) return real;
  }
  return null;
}

/** The file a local-media://media/<path> address names (percent-encoded), or null when it isn't one. */
export function localMediaFilePath(requestUrl: string, platform: string = process.platform): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'local-media:' || url.hostname !== 'media') return null;
  let filePath: string;
  try {
    filePath = decodeURIComponent(url.pathname);
  } catch {
    return null; // a stray % that isn't an escape
  }
  // local-media://media/C:/Users/... on Windows: the path starts after the slash
  if (platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(filePath)) filePath = filePath.slice(1);
  return filePath;
}

/**
 * The bytes a Range header asks for, as RFC 9110 reads it: null to send the
 * whole file (no header, or one this doesn't handle, such as several ranges),
 * 'unsatisfiable' when it starts past the end.
 */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    // The last N bytes
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return null; // "bytes=500-400" isn't a range: ignored
  if (start >= size) return 'unsatisfiable';
  return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

/** A file as an HTTP answer: all of it, or the part `rangeHeader` asks for. */
export async function serveFile(file: string, rangeHeader: string | null | undefined, method = 'GET'): Promise<Response> {
  const { size } = await fs.promises.stat(file);
  const range = parseRange(rangeHeader, size);
  const headers: Record<string, string> = {
    'Content-Type': MEDIA_TYPES[extensionOf(file)] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  headers['Content-Length'] = String(length);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = method === 'HEAD' || length === 0 ? null : Readable.toWeb(fs.createReadStream(file, { start, end }));
  return new Response(body, { status: range ? 206 : 200, headers });
}

/**
 * The local-media:// protocol: a video or sound the engine copied out for the
 * window, with seeking. Anything else is "not found", and is logged.
 */
export async function handleLocalMedia(
  request: { url: string; method?: string; headers?: { get(name: string): string | null } },
  tempDirs: string[],
  platform: string = process.platform,
): Promise<Response> {
  const wanted = localMediaFilePath(request.url, platform);
  const file = wanted ? appCopyPath(wanted, tempDirs, platform) : null;
  if (!file || !MEDIA_TYPES[extensionOf(file)]) {
    console.warn('[local-media] refused a file outside the app\'s copies, or not a video or sound:', wanted ?? request.url);
    return new Response('Not found', { status: 404 });
  }
  try {
    return await serveFile(file, request.headers?.get('range'), request.method);
  } catch (err) {
    console.warn('[local-media] could not read', file, err);
    return new Response('Not found', { status: 404 });
  }
}

/** The part of Electron's nativeImage this uses. */
export interface ThumbnailMaker {
  createThumbnailFromPath(path: string, size: { width: number; height: number }): Promise<{
    isEmpty(): boolean;
    toJPEG(quality: number): Buffer;
  }>;
}

/**
 * A still of a video (or a photo) the engine copied out, made by the system's
 * previewer (Quick Look on macOS, the shell on Windows), as a JPEG data: URL
 * at most `size` pixels on its longer side (Retina screens get twice that).
 * Null on Linux, which has no previewer Electron can use, for a file outside the
 * copy folders, and whenever the previewer can't draw it.
 */
export async function mediaThumbnail(
  filePath: unknown,
  size: unknown,
  { tempDirs, nativeImage, platform = process.platform, timeoutMs = THUMBNAIL_TIMEOUT_MS }:
    { tempDirs: string[]; nativeImage: ThumbnailMaker | undefined; platform?: string; timeoutMs?: number },
): Promise<string | null> {
  if (platform !== 'darwin' && platform !== 'win32') return null;
  if (typeof nativeImage?.createThumbnailFromPath !== 'function') return null;
  const file = appCopyPath(filePath, tempDirs, platform);
  if (!file || !THUMBNAIL_EXTENSIONS.has(extensionOf(file))) return null;
  const px = typeof size === 'number' && Number.isFinite(size) ? Math.min(1024, Math.max(16, Math.round(size))) : DEFAULT_THUMBNAIL_PX;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const image = await Promise.race([
      nativeImage.createThumbnailFromPath(file, { width: px, height: px }),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!image || image.isEmpty()) return null;
    const jpeg = image.toJPEG(80);
    return jpeg && jpeg.length > 0 ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null;
  } catch {
    return null; // "unable to retrieve thumbnail preview image for the given path"
  } finally {
    clearTimeout(timer);
  }
}
