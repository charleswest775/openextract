"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEVICE_WINDOW_MS = exports.BUSINESS_ASK_DEVICES = void 0;
exports.deviceKey = deviceKey;
exports.recordSave = recordSave;
exports.shouldAskBusiness = shouldAskBusiness;
exports.isBusinessAnswer = isBusinessAnswer;
const crypto_1 = require("crypto");
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
exports.BUSINESS_ASK_DEVICES = 6;
/** How far back saves count. */
exports.DEVICE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * A hash of the iPhone's ID. IDs come with and without dashes and in either case
 * (backup folders vs Info.plist), so they're normalised first.
 */
function deviceKey(udid) {
    const id = udid.replace(/-/g, '').toLowerCase();
    return (0, crypto_1.createHash)('sha256').update(id, 'utf8').digest('hex');
}
/** Notes a save from `udid` and returns the log (older entries dropped) and how many iPhones it holds. */
function recordSave(log, udid, now) {
    const kept = {};
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        for (const [key, at] of Object.entries(log)) {
            // A clock set backwards shouldn't make entries live forever, so future times count as now.
            if (typeof at === 'number' && Number.isFinite(at) && now - Math.min(at, now) < exports.DEVICE_WINDOW_MS)
                kept[key] = at;
        }
    }
    if (udid.trim())
        kept[deviceKey(udid.trim())] = now;
    return { log: kept, count: Object.keys(kept).length };
}
/**
 * Whether this save should bring the question. Once only: after it has shown, it never
 * shows again, whatever the answer (or none). Someone who said they paid was told
 * "I won't ask again", so they aren't asked this either.
 */
function shouldAskBusiness({ count, shown, paid }) {
    return !shown && !paid && count >= exports.BUSINESS_ASK_DEVICES;
}
function isBusinessAnswer(value) {
    return value === 'work' || value === 'personal';
}
