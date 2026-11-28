export {};
export interface ReportInput {
    kind: string;
    area: string;
    details: string;
    diagnostics: string;
    email?: string;
    /** Random hex made once per form, so a retry of the same report isn't filed twice. */
    token: string;
    /** Thank-yous only: OK to quote on openextract.app, without the sender's name. */
    quote?: boolean;
}
export interface KnownFix {
    id: string;
    title: string;
    text: string;
    url?: string;
}
export type SendResult = {
    ok: true;
    reference: string;
    knownFixes: KnownFix[];
} | {
    ok: false;
    error: string;
};
export interface FixedReport {
    reference: string;
    summary: string;
    sentAt: string;
    fixedIn?: string;
    /** The running version already has the fix. */
    inThisVersion: boolean;
}
interface Store {
    get(key: string, fallback?: any): any;
    set(key: string, value: any): void;
}
type Fetch = (url: string, init: any) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<any>;
}>;
/** -1, 0 or 1, comparing dotted version numbers ("0.9.10" is newer than "0.9.2"). */
export declare function compareVersions(a: string, b: string): number;
export declare class FeedbackReports {
    private store;
    private fetchFn;
    private appVersion;
    private site;
    constructor(store: Store, fetchFn: Fetch, appVersion: string, site?: string);
    private reports;
    private post;
    send(input: ReportInput): Promise<SendResult>;
    /**
     * Asks about reports that are still open, if a check is due. Returns true when
     * one turned out to be fixed. Network failures are ignored until the next check.
     */
    checkIfDue(now?: number): Promise<boolean>;
    /** Fixed reports the user hasn't been told about yet. */
    fixedToAnnounce(): FixedReport[];
    markAnnounced(reference: string): void;
}
