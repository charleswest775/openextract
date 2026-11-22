export {};
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { randomUUID } = require('crypto');

// A call stays here until the engine answers it, also after the app has given up on it
// (gaveUp): the engine is still working on it, and nothing after it can start till then.
interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  // How long the engine may spend on this call without a progress report, and the
  // timer for that. The timer is null while the call waits behind earlier ones
  // (see startClock) and starts over at each progress report (see restartClock).
  timeoutMs: number;
  timeout: NodeJS.Timeout | null;
  // The app stopped waiting and rejected the call; any answer is ignored (giveUp).
  gaveUp: boolean;
  // The engine has been on this given-up call too long for others to wait for it (engineStuck).
  stuck: boolean;
  // The engine process the request went to. After a restart, the old engine's
  // exit must only reject the calls it was given, not the new engine's.
  proc: any;
}

/** What a call is told when the engine is stuck on an earlier one the app gave up on. */
function stillBusyMessage(method: string): string {
  const saving = method.startsWith('export_') || method === 'plan_pdf_parts';
  const what = saving ? 'a save' : 'something';
  return `OpenExtract is still busy with ${what} that took too long, so it can't do this yet. `
    + 'Try again in a few minutes, or quit and reopen OpenExtract to stop it.';
}

/** Shape of a JSON-RPC notification (no id field). */
export interface SidecarNotification {
  jsonrpc: string;
  method: string;
  params: Record<string, any>;
}

export class PythonSidecar {
  private process: any = null;
  private pythonPath: string;
  private pythonArgs: string[];
  private pending: Map<string, PendingRequest> = new Map();
  private buffer: string = '';
  private readonly TIMEOUT_MS = 300000; // 5 min — backups can take a while
  // The most that calls behind a given-up one wait for the engine to finish it (startClock).
  private readonly MAX_WAIT_AFTER_TIMEOUT_MS = 300000;
  private logPath: string;

  /**
   * Called for every JSON-RPC *notification* received from the sidecar.
   * Notifications are one-way messages that have no `id` field.
   * Set this before calling start() to receive backup.progress events.
   */
  public notificationHandler: ((notification: SidecarNotification) => void) | null = null;

  constructor(pythonPath: string, pythonArgs: string[], logPath: string) {
    this.pythonPath = pythonPath;
    this.pythonArgs = pythonArgs;
    this.logPath = logPath;
  }

  /** True while there is an engine to send calls to (false before start() and after stop() or a crash). */
  get running(): boolean {
    return !!this.process && !this.process.killed;
  }

  async start(): Promise<void> {
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
      proc.stdout.on('data', (data: Buffer) => {
        if (proc !== this.process) return; // an old engine's last words after a restart
        this.buffer += decoder.write(data);
        this.processBuffer();
      });

      proc.stderr.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.error(`[Python] ${msg}`);
          require('fs').appendFileSync(this.logPath, `[STDERR] ${msg}\n`);
        }
      });

      // Writing to an engine that has just closed its end (it's exiting) fails
      // with EPIPE. Without a listener that error is thrown in the main process;
      // the call that wrote is rejected by its write callback in call().
      proc.stdin.on('error', (err: Error) => {
        require('fs').appendFileSync(this.logPath, `[STDIN ERROR] ${err.message}\n`);
      });

      proc.on('error', (err: Error) => {
        console.error('Failed to start Python sidecar:', err);
        require('fs').appendFileSync(this.logPath, `[ERROR STARTING] ${err.message}\n`);
        // A failed spawn emits "error" but never "exit", so let go of it here,
        // or later calls would be written to nothing and wait for their timeout.
        this.forget(proc, err.message);
        reject(err);
      });

      proc.on('exit', (code: number) => {
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
        } else {
          reject(new Error('Python sidecar failed to start'));
        }
      }, 500);
    });
  }

  /** The engine `proc` is gone: stop using it and reject the calls it was given. */
  private forget(proc: any, reason: string): void {
    if (this.process === proc) this.process = null;
    for (const [id, req] of this.pending) {
      if (req.proc !== proc) continue;
      if (req.timeout) clearTimeout(req.timeout);
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
  private startClock(proc: any): void {
    const req = this.working(proc);
    if (!req || req.timeout || req.stuck) return;
    req.timeout = req.gaveUp
      ? setTimeout(() => this.engineStuck(req), Math.min(req.timeoutMs, this.MAX_WAIT_AFTER_TIMEOUT_MS))
      : setTimeout(() => this.giveUp(req), req.timeoutMs);
  }

  /** The call `proc` is working on: the earliest it hasn't answered. */
  private working(proc: any): PendingRequest | undefined {
    for (const [, req] of this.pending) {
      if (req.proc === proc) return req;
    }
    return undefined;
  }

  /** A call's time is up: tell whoever asked, but remember the engine is still on it. */
  private giveUp(req: PendingRequest): void {
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
  private engineStuck(req: PendingRequest): void {
    req.timeout = null;
    req.stuck = true;
    for (const [, waiting] of this.pending) {
      if (waiting.proc !== req.proc || waiting.gaveUp) continue;
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
  private restartClock(proc: any): void {
    const req = this.working(proc);
    if (!req || req.gaveUp) return;
    if (req.timeout) clearTimeout(req.timeout);
    req.timeout = null;
    this.startClock(proc);
  }

  /** The engine is done with call `id`: start the clock of the next one in line. */
  private finish(id: string): PendingRequest | undefined {
    const req = this.pending.get(id);
    if (!req) return undefined;
    if (req.timeout) clearTimeout(req.timeout);
    this.pending.delete(id);
    this.startClock(req.proc);
    return req.gaveUp ? undefined : req;
  }

  private processBuffer(): void {
    // Each JSON-RPC message is a single line terminated by \n
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep the incomplete trailing line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed);

        // JSON-RPC *notifications* have no `id` field (or id === null/undefined)
        // and a `method` field.  Route them to notificationHandler rather than
        // trying to resolve a pending request.
        if (message.method !== undefined && message.id === undefined) {
          this.restartClock(this.process);
          // Progress of a call nobody waits for any more would show as the next save's.
          if (this.notificationHandler && !this.working(this.process)?.gaveUp) {
            this.notificationHandler(message as SidecarNotification);
          }
          continue;
        }

        // Normal response: match by id to a pending call.
        const pending = this.finish(message.id);
        if (pending) {
          if (message.error) {
            pending.reject(new Error(message.error.message || 'Unknown error'));
          } else {
            pending.resolve(message.result);
          }
        }
      } catch (e) {
        console.error('Failed to parse sidecar response:', trimmed);
      }
    }
  }

  async call(method: string, params: any = {}, timeoutMs?: number): Promise<any> {
    if (!this.running) {
      throw new Error('Python sidecar is not running');
    }

    const proc = this.process;
    const busy = this.working(proc);
    if (busy?.stuck) throw new Error(stillBusyMessage(busy.method));
    // Unguessable. The window can make the engine write lines on this pipe (write_file to
    // /dev/stdout), and with ids it could count it could answer its own calls in the engine's
    // place, backup.check_older's "allowed" included (olderBackups.ts).
    const id: string = randomUUID();
    const request = JSON.stringify({ id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject, timeoutMs: timeoutMs ?? this.TIMEOUT_MS, timeout: null, gaveUp: false, stuck: false, proc });
      this.startClock(proc);
      proc.stdin.write(request, (err: Error | null | undefined) => {
        if (!err || !this.finish(id)) return;
        reject(new Error('Python sidecar is not running'));
      });
    });
  }

  stop(): void {
    if (this.process && !this.process.killed) {
      this.process.stdin.end();
      this.process.kill();
      this.process = null;
    }
  }
}
