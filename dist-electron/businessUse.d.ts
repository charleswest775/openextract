/**
 * "Using it for paid work?": a one-time question for people who save from many iPhones.
 *
 * OpenExtract stays free and MIT licensed, and nothing here blocks anything. Someone who
 * saves from many different iPhones in a year is likely doing it for clients (a repair
 * shop, an investigator, a paralegal), so the app asks them once whether it's paid work
 * and, if it is, points to the business rates on the site.
 *
 * What's kept, on this computer only: a hash of each iPhone's ID (never the ID itself,
 * the phone's name or the backup's folder) and when something was last saved from it.
 * Nothing is sent anywhere. Entries older than a year are dropped as they're counted.
 */
/** Different iPhones saved from in the past year before the question appears. */
export declare const BUSINESS_ASK_DEVICES = 6;
/** How far back saves count. */
export declare const DEVICE_WINDOW_MS: number;
/** Hashed iPhone ID → when something was last saved from it (ms). */
export type DeviceLog = Record<string, number>;
/** What the person said: paid work, personal, or nothing yet (or they closed the card). */
export type BusinessAnswer = 'work' | 'personal';
/**
 * A hash of the iPhone's ID. IDs come with and without dashes and in either case
 * (backup folders vs Info.plist), so they're normalised first.
 */
export declare function deviceKey(udid: string): string;
/** Notes a save from `udid` and returns the log (older entries dropped) and how many iPhones it holds. */
export declare function recordSave(log: unknown, udid: string, now: number): {
    log: DeviceLog;
    count: number;
};
/**
 * Whether this save should bring the question. Once only: after it has shown, it never
 * shows again, whatever the answer (or none). Someone who said they paid was told
 * "I won't ask again", so they aren't asked this either.
 */
export declare function shouldAskBusiness({ count, shown, paid }: {
    count: number;
    shown: boolean;
    paid: boolean;
}): boolean;
export declare function isBusinessAnswer(value: unknown): value is BusinessAnswer;
