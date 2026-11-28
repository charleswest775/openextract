export {};
export type UpdateState = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
export interface UpdateStatus {
    state: UpdateState;
    version?: string;
    percent?: number;
    error?: string;
    checkedAt?: string;
}
interface Store {
    get(key: string, fallback?: any): any;
    set(key: string, value: any): void;
}
interface Options {
    store: Store;
    getWindow: () => any;
    /** Runs before quitAndInstall, e.g. to stop the engine so its files can be replaced. */
    beforeInstall: () => Promise<void>;
}
export declare function initUpdater({ store, getWindow, beforeInstall }: Options): void;
