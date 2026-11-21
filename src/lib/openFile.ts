/**
 * Handing a file copied out of the backup to the computer, so another app
 * opens it: WhatsApp's media and the Photos screen's videos.
 *
 * The engine never gives the app a file where it lies in the backup. It makes
 * a copy under the file's own name (python/app_copies.py) and says whether
 * that copy is safe to open.
 */

/** What the engine answers when asked for a copy to open (get_photo_path, get_whatsapp_attachment with as_file). */
export interface CopiedFile {
  path?: string;
  /**
   * The copy is a photo, video, audio file or document, which a viewer opens
   * without running anything. When it isn't true (a program, script, shortcut,
   * archive, or a name with no file type), don't open it: show it in its folder.
   */
  openable?: boolean;
  error?: string;
  empty_reason?: string | null;
}

/** What happened when a file was handed to the computer. */
export const SHOWN_IN_FOLDER = "OpenExtract doesn't open this kind of file itself, so it's shown in its folder.";

/** The two things the app can do with a copied file (window.openextract's openPath and showInFolder). */
export interface FileHandler {
  openPath: (path: string) => Promise<string>;
  showInFolder: (path: string) => Promise<void>;
}

/**
 * Hand a file copied out of the backup to the computer. Only a file the
 * engine says is safe to open (a photo, video, sound or document) is opened;
 * anything else, a program or a script whatever it is named, is shown in its
 * folder instead, because opening a program runs it. Resolves to what to tell
 * the person, or null when the file opened.
 */
export async function handOver(r: CopiedFile | null | undefined, files: FileHandler): Promise<string | null> {
  if (r?.empty_reason === 'not_in_backup') return "This file isn't in the backup";
  if (r?.error) return r.error;
  if (!r?.path) return "Couldn't copy the file out of the backup";
  if (r.openable !== true) {
    await files.showInFolder(r.path);
    return SHOWN_IN_FOLDER;
  }
  const problem = await files.openPath(r.path);
  return problem ? `Couldn't open it: ${problem}` : null;
}

/**
 * The address the window plays a copied video or sound from, in its own player:
 * local-media://media/<the copy's path>, each part percent-encoded, since a
 * name can hold spaces, "#", "%" or anything else. The main process serves
 * only files inside the engine's copy folders (electron/localMedia.ts), so
 * this is only for a `path` the engine answered with.
 */
export function localMediaUrl(filePath: string): string {
  // Windows paths ("C:\Users\...", "\\server\share\...") are split at either slash; elsewhere a
  // backslash can be part of a name
  const windows = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\');
  const parts = filePath.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
  return `local-media://media/${parts.map(encodeURIComponent).join('/')}`;
}
