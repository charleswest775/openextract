export {};
/** Whether opening this path would run a program (Windows ignores trailing dots and spaces). */
export declare function runsCode(filePath: unknown): boolean;
/**
 * Whether the file's name says what kind of file it is. A name with no extension
 * doesn't, so the computer can't pick an app for it, and macOS runs such a file when
 * it is marked executable, as every file on an exFAT or NTFS drive is: a video opened
 * straight from a backup's folder, where files have no extension, started Terminal (#297).
 */
export declare function hasFileType(filePath: string): boolean;
