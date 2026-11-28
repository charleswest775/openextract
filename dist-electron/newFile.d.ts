/** A file's name from what the window sent: one file name, never a path, never empty. */
export declare function safeBaseName(name: unknown): string;
/**
 * Write `data` to `target`, or to "Mom (2).pdf" and so on when that's taken, and return
 * the path written. The name is claimed as the file is created ('wx'), not looked up
 * beforehand: printing takes minutes, and another save or the person can take it meanwhile.
 */
export declare function writeNewFile(target: string, data: string | Buffer): string;
