"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PythonSidecar = void 0;
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { randomUUID } = require('crypto');
/** What a call is told when the engine is stuck on an earlier one the app gave up on. */
function stillBusyMessage(method) {
    const saving = method.startsWith('export_') || method === 'plan_pdf_parts';
    const what = saving ? 'a save' : 'something';
    return `OpenExtract is still busy with ${what} that took too long, so it can't do this yet. `
        + 'Try again in a few minutes, or quit and reopen OpenExtract to stop it.';
}
class PythonSidecar {
    constructor(pythonPath, pythonArgs, logPath) {
        this.process = null;
        this.pending = new Map();
        this.buffer = '';
        this.TIMEOUT_MS = 300000; // 5 min — backups can take a while
        // The most that calls behind a given-up one wait for the engine to finish it (startClock).
        this.MAX_WAIT_AFTER_TIMEOUT_MS = 300000;
        /**
         * Called for every JSON-RPC *notification* received from the sidecar.
         * Notifications are one-way messages that have no `id` field.
         * Set this before calling start() to receive backup.progress events.
         */
        this.notificationHandler = null;
        this.pythonPath = pythonPath;
        this.pythonArgs = pythonArgs;
        this.logPath = logPath;
    }
    /** True while there is an engine to send calls to (false before start() and after stop() or a crash). */
    get running() {
        return !!this.process && !this.process.killed;
    }
    async start() {
        return new Promise((resolve, reject) => {
            const proc = spawn(this.pythonPath, this.pythonArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1', OPENEXTRACT_LOG_PATH: this.logPath },
            });
            this.process = proc;
            this.buffer = '';
            // Each chunk can end partway through a multi-byte UTF-8 character; the
            // decoder holds those bytes back until the rest of the character arrives.
            const decoder = new StringDecoder('utf8');
            proc.stdout.on('data', (data) => {
                if (proc !== this.process)
                    return; // an old engine's last words after a restart
                this.buffer += decoder.write(data);
                this.processBuffer();
            });
            proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    console.error(`[Python] ${msg}`);
                    require('fs').appendFileSync(this.logPath, `[STDERR] ${msg}\n`);
                }
            });
            // Writing to an engine that has just closed its end (it's exiting) fails
            // with EPIPE. Without a listener that error is thrown in the main process;
            // the call that wrote is rejected by its write callback in call().
            proc.stdin.on('error', (err) => {
                require('fs').appendFileSync(this.logPath, `[STDIN ERROR] ${err.message}\n`);
            });
            proc.on('error', (err) => {
                console.error('Failed to start Python sidecar:', err);
                require('fs').appendFileSync(this.logPath, `[ERROR STARTING] ${err.message}\n`);
                // A failed spawn emits "error" but never "exit", so let go of it here,
                // or later calls would be written to nothing and wait for their timeout.
                this.forget(proc, err.message);
                reject(err);
            });
            proc.on('exit', (code) => {
                console.log(`Python sidecar exited with code ${code}`);
                require('fs').appendFileSync(this.logPath, `[EXIT] code ${code}\n`);
                // `killed` stays false when the engine exits on its own (a crash), so
                // without this, later calls would be written to a dead process and
                // hang until their timeout instead of failing right away.
                this.forget(proc, `Sidecar exited with code ${code}`);
            });
            // Give the process a moment to start, then verify it's running
            setTimeout(() => {
                if (this.process === proc && !proc.killed) {
                    resolve();
                }
                else {
                    reject(new Error('Python sidecar failed to start'));
                }
            }, 500);
        });
    }
    /** The engine `proc` is gone: stop using it and reject the calls it was given. */
    forget(proc, reason) {
        if (this.process === proc)
            this.process = null;
        for (const [id, req] of this.pending) {
            if (req.proc !== proc)
                continue;
            if (req.timeout)
                clearTimeout(req.timeout);
            this.pending.delete(id);
            req.reject(new Error(reason));
        }
    }
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
    startClock(proc) {
        const req = this.working(proc);
        if (!req || req.timeout || req.stuck)
            return;
        req.timeout = req.gaveUp
            ? setTimeout(() => this.engineStuck(req), Math.min(req.timeoutMs, this.MAX_WAIT_AFTER_TIMEOUT_MS))
            : setTimeout(() => this.giveUp(req), req.timeoutMs);
    }
    /** The call `proc` is working on: the earliest it hasn't answered. */
    working(proc) {
        for (const [, req] of this.pending) {
            if (req.proc === proc)
                return req;
        }
        return undefined;
    }
    /** A call's time is up: tell whoever asked, but remember the engine is still on it. */
    giveUp(req) {
        req.timeout = null;
        req.gaveUp = true;
        req.reject(new Error(`Sidecar call timed out: ${req.method}`));
        this.startClock(req.proc);
    }
    /**
     * The wait for a given-up call is over too. The calls behind it are told why they
     * can't run, and so is any new one (call) until the engine answers; then calls work
     * again. The engine isn't restarted: that would close the open backup (and need its
     * password again) and leave the decrypted copies it would have cleaned up.
     */
    engineStuck(req) {
        req.timeout = null;
        req.stuck = true;
        for (const [, waiting] of this.pending) {
            if (waiting.proc !== req.proc || waiting.gaveUp)
                continue;
            waiting.gaveUp = true; // already sent, so the engine will still get to it
            waiting.reject(new Error(stillBusyMessage(req.method)));
        }
    }
    /**
     * The engine sent a progress report, so the call it is working on is still going:
     * that call's time limit starts over. A backup or save can then run for as long as
     * it keeps reporting progress, and times out only after a whole limit with none.
     * (A big backup over a slow connection can take longer than its 2-hour limit.)
     * Not for a call the app gave up on: the ones behind it wait only so long.
     */
    restartClock(proc) {
        const req = this.working(proc);
        if (!req || req.gaveUp)
            return;
        if (req.timeout)
            clearTimeout(req.timeout);
        req.timeout = null;
        this.startClock(proc);
    }
    /** The engine is done with call `id`: start the clock of the next one in line. */
    finish(id) {
        const req = this.pending.get(id);
        if (!req)
            return undefined;
        if (req.timeout)
            clearTimeout(req.timeout);
        this.pending.delete(id);
        this.startClock(req.proc);
        return req.gaveUp ? undefined : req;
    }
    processBuffer() {
        // Each JSON-RPC message is a single line terminated by \n
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || ''; // Keep the incomplete trailing line in buffer
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const message = JSON.parse(trimmed);
                // JSON-RPC *notifications* have no `id` field (or id === null/undefined)
                // and a `method` field.  Route them to notificationHandler rather than
                // trying to resolve a pending request.
                if (message.method !== undefined && message.id === undefined) {
                    this.restartClock(this.process);
                    // Progress of a call nobody waits for any more would show as the next save's.
                    if (this.notificationHandler && !this.working(this.process)?.gaveUp) {
                        this.notificationHandler(message);
                    }
                    continue;
                }
                // Normal response: match by id to a pending call.
                const pending = this.finish(message.id);
                if (pending) {
                    if (message.error) {
                        pending.reject(new Error(message.error.message || 'Unknown error'));
                    }
                    else {
                        pending.resolve(message.result);
                    }
                }
            }
            catch (e) {
                console.error('Failed to parse sidecar response:', trimmed);
            }
        }
    }
    async call(method, params = {}, timeoutMs) {
        if (!this.running) {
            throw new Error('Python sidecar is not running');
        }
        const proc = this.process;
        const busy = this.working(proc);
        if (busy?.stuck)
            throw new Error(stillBusyMessage(busy.method));
        // Unguessable. The window can make the engine write lines on this pipe (write_file to
        // /dev/stdout), and with ids it could count it could answer its own calls in the engine's
        // place, backup.check_older's "allowed" included (olderBackups.ts).
        const id = randomUUID();
        const request = JSON.stringify({ id, method, params }) + '\n';
        return new Promise((resolve, reject) => {
            this.pending.set(id, { method, resolve, reject, timeoutMs: timeoutMs ?? this.TIMEOUT_MS, timeout: null, gaveUp: false, stuck: false, proc });
            this.startClock(proc);
            proc.stdin.write(request, (err) => {
                if (!err || !this.finish(id))
                    return;
                reject(new Error('Python sidecar is not running'));
            });
        });
    }
    stop() {
        if (this.process && !this.process.killed) {
            this.process.stdin.end();
            this.process.kill();
            this.process = null;
        }
    }
}
exports.PythonSidecar = PythonSidecar;
