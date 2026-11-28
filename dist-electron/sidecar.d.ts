export {};
/** Shape of a JSON-RPC notification (no id field). */
export interface SidecarNotification {
    jsonrpc: string;
    method: string;
    params: Record<string, any>;
}
export declare class PythonSidecar {
    private process;
    private pythonPath;
    private pythonArgs;
    private pending;
    private buffer;
    private readonly TIMEOUT_MS;
    private readonly MAX_WAIT_AFTER_TIMEOUT_MS;
    private logPath;
    /**
     * Called for every JSON-RPC *notification* received from the sidecar.
     * Notifications are one-way messages that have no `id` field.
     * Set this before calling start() to receive backup.progress events.
     */
    notificationHandler: ((notification: SidecarNotification) => void) | null;
    constructor(pythonPath: string, pythonArgs: string[], logPath: string);
    /** True while there is an engine to send calls to (false before start() and after stop() or a crash). */
    get running(): boolean;
    start(): Promise<void>;
    /** The engine `proc` is gone: stop using it and reject the calls it was given. */
    private forget;
    /**
     * The engine works on one call at a time, in the order they were sent, so a
     * call's time limit starts only when the engine has answered every call sent to
     * `proc` before it. Otherwise thumbnails asked for during a long export would time
     * out while they wait their turn.
     *
     * That holds for a call the app gave up on, too. The engine doesn't know, and is
     * still working on it: a screen opened after a save timed out used to time out
     * itself, 5 minutes later, without the engine ever having seen it. The ones behind
     * wait for that answer as long again as the call's own limit, and 5 minutes at
     * most, so a stuck engine can't keep them waiting forever (engineStuck).
     */
    private startClock;
    /** The call `proc` is working on: the earliest it hasn't answered. */
    private working;
    /** A call's time is up: tell whoever asked, but remember the engine is still on it. */
    private giveUp;
    /**
     * The wait for a given-up call is over too. The calls behind it are told why they
     * can't run, and so is any new one (call) until the engine answers; then calls work
     * again. The engine isn't restarted: that would close the open backup (and need its
     * password again) and leave the decrypted copies it would have cleaned up.
     */
    private engineStuck;
    /**
     * The engine sent a progress report, so the call it is working on is still going:
     * that call's time limit starts over. A backup or save can then run for as long as
     * it keeps reporting progress, and times out only after a whole limit with none.
     * (A big backup over a slow connection can take longer than its 2-hour limit.)
     * Not for a call the app gave up on: the ones behind it wait only so long.
     */
    private restartClock;
    /** The engine is done with call `id`: start the clock of the next one in line. */
    private finish;
    private processBuffer;
    call(method: string, params?: any, timeoutMs?: number): Promise<any>;
    stop(): void;
}
