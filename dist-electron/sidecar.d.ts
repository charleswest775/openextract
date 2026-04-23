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
    private requestId;
    private pending;
    private buffer;
    private readonly TIMEOUT_MS;
    private logPath;
    /**
     * Called for every JSON-RPC *notification* received from the sidecar.
     * Notifications are one-way messages that have no `id` field.
     * Set this before calling start() to receive backup.progress events.
     */
    notificationHandler: ((notification: SidecarNotification) => void) | null;
    constructor(pythonPath: string, pythonArgs: string[], logPath: string);
    start(): Promise<void>;
    private processBuffer;
    call(method: string, params?: any, timeoutMs?: number): Promise<any>;
    stop(): void;
}
