export {};
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
export declare function appCopyPath(candidate: unknown, tempDirs: string[], _platform?: string): string | null;
/** The file a local-media://media/<path> address names (percent-encoded), or null when it isn't one. */
export declare function localMediaFilePath(requestUrl: string, platform?: string): string | null;
/**
 * The bytes a Range header asks for, as RFC 9110 reads it: null to send the
 * whole file (no header, or one this doesn't handle, such as several ranges),
 * 'unsatisfiable' when it starts past the end.
 */
export declare function parseRange(header: string | null | undefined, size: number): {
    start: number;
    end: number;
} | 'unsatisfiable' | null;
/** A file as an HTTP answer: all of it, or the part `rangeHeader` asks for. */
export declare function serveFile(file: string, rangeHeader: string | null | undefined, method?: string): Promise<Response>;
/**
 * The local-media:// protocol: a video or sound the engine copied out for the
 * window, with seeking. Anything else is "not found", and is logged.
 */
export declare function handleLocalMedia(request: {
    url: string;
    method?: string;
    headers?: {
        get(name: string): string | null;
    };
}, tempDirs: string[], platform?: string): Promise<Response>;
/** The part of Electron's nativeImage this uses. */
export interface ThumbnailMaker {
    createThumbnailFromPath(path: string, size: {
        width: number;
        height: number;
    }): Promise<{
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
export declare function mediaThumbnail(filePath: unknown, size: unknown, { tempDirs, nativeImage, platform, timeoutMs }: {
    tempDirs: string[];
    nativeImage: ThumbnailMaker | undefined;
    platform?: string;
    timeoutMs?: number;
}): Promise<string | null>;
