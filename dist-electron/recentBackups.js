"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FOLDER_CHECK_MS = void 0;
exports.backupFolderState = backupFolderState;
exports.listedSessions = listedSessions;
const fs = require('fs');
const path = require('path');
// A network folder that's away can take most of a minute to answer, and the home screen waits
// for this list, so a folder that hasn't answered by then stays listed.
exports.FOLDER_CHECK_MS = 2000;
// The folder isn't there: ENOTDIR when part of the path is now a file.
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);
async function backupFolderState(dir, stat = fs.promises.stat, timeoutMs = exports.FOLDER_CHECK_MS) {
    if (typeof dir !== 'string' || !dir)
        return 'unknown';
    const check = async () => {
        try {
            await stat(dir);
            return 'here';
        }
        catch (e) {
            if (!NOT_THERE.has(e?.code))
                return 'unknown';
        }
        const parent = path.dirname(dir);
        if (!parent || parent === dir)
            return 'unknown';
        try {
            return (await stat(parent)).isDirectory() ? 'gone' : 'unknown';
        }
        catch {
            return 'unknown';
        }
    };
    let timer;
    const late = new Promise(resolve => {
        timer = setTimeout(() => resolve('unknown'), timeoutMs);
    });
    try {
        return await Promise.race([check(), late]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** The sessions to list: every one but those whose backup was deleted. Order is kept. */
async function listedSessions(sessions, stateOf = dir => backupFolderState(dir)) {
    const states = await Promise.all(sessions.map(s => stateOf(s?.backupDir).catch(() => 'unknown')));
    return sessions.filter((_, i) => states[i] !== 'gone');
}
