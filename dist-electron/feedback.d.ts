export {};
/**
 * Facts for the in-app feedback form. Everything here stays in memory until
 * the user opens the form, sees it, edits it, and clicks Send
 * (feedbackReports.ts). Nothing is sent otherwise.
 *
 * Nothing from inside a backup is kept: no message text, contact names,
 * file paths or device names. Error messages and log lines can still mention
 * those, so they go through scrubText() before the renderer sees them.
 */
export interface BackupFacts {
    /** Hardware model, e.g. "iPhone14,2". Not the user's name for the phone. */
    model?: string;
    iosVersion?: string;
    encrypted?: boolean;
    sizeGB?: number | null;
    /** The backup stopped partway (OE-31), so sections may fail for that reason alone. */
    unfinished?: boolean;
    /** How many files the backup lists aren't in its folder (OE-102), from check_backup_files. */
    missingFiles?: number;
}
export interface RecentFailure {
    at: string;
    method: string;
    message: string;
    count: number;
}
export interface FeedbackDiagnostics {
    appVersion: string;
    os: string;
    backup: BackupFacts | null;
    /** Engine calls made for the open backup, by outcome (names only). */
    loaded: string[];
    failed: string[];
    recentErrors: RecentFailure[];
    logExcerpt: string;
    /** The error the user clicked "Report this problem" on, scrubbed. */
    reportedError?: string;
}
/** The line that starts a time the app was opened, in the engine log. */
export declare function sessionMark(appVersion: string, now: Date): string;
/** Where the log of the time before is kept: python_log.txt's is python_log.previous.txt. */
export declare function previousLogPath(logPath: string): string;
/**
 * Remove personal details from text the user is about to see in the feedback
 * form. `secrets` maps literal strings (home folder, device name, …) to the
 * placeholder that replaces them. Longest first, so a backup folder inside the
 * home folder becomes <backup folder>, not ~/….
 */
export declare function scrubText(text: string, secrets: Map<string, string>): string;
/**
 * The engine log mixes timings, stray prints and errors. Only error entries
 * (tracebacks, failed starts, crashes) are worth sending, and stray prints can
 * contain backup content, so everything else is left out.
 *
 * `logText` may hold more than one time the app was opened, each under its
 * "[START] …" line, the last being this time. When an error that is kept is from
 * an earlier one, the errors are put under "The last time OpenExtract was open:" and
 * "This time:", so whoever reads the report can tell which is which. The "[START] …"
 * lines themselves, with their dates, are not sent.
 */
export declare function extractLogExcerpt(logText: string): string;
export declare class FeedbackRecorder {
    private logPath;
    private appVersion;
    private failures;
    private outcomes;
    private backup;
    private secrets;
    /** Where this time's entries start in the log: 0 unless an older log couldn't be moved out of the way. */
    private sessionStart;
    /** This time's "[START] …" line, once beginSession() has written it. */
    private sessionMark;
    /** The log of the time before, when beginSession() moved it there. */
    private previousLog;
    constructor(logPath: string, appVersion: string);
    /**
     * Call once as the app starts, before the engine does and writes to the log. The log
     * of the time before is moved aside (replacing the one before that, so two are kept
     * and the log can't grow without end), and this time's begins with its "[START] …" line.
     *
     * If the old log can't be moved (another OpenExtract has it open, or the folder can't
     * be written), this time's entries go after it in the same file and are told apart by
     * where they start.
     */
    beginSession(now?: Date): void;
    /** The engine log a report draws on: the time before (if this version wrote it), then this time. */
    private recentLog;
    private addSecret;
    /** Called by the sidecar bridge after every engine call. Params are read for folders and ids only, never stored. */
    recordCall(method: string, params: any, outcome: {
        ok: true;
        result: any;
    } | {
        ok: false;
        error: string;
    }): void;
    diagnostics(reportedError?: string): FeedbackDiagnostics;
}
