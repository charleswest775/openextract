export {};
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  // How long the engine may spend on this call without a progress report, and the
  // timer for that. The timer is null while the call waits behind earlier ones
  // (see startClock) and starts over at each progress report (see restartClock).
  timeoutMs: number;
  timeout: NodeJS.Timeout | null;
  // The engine process the request went to. After a restart, the old engine's
  // exit must only reject the calls it was given, not the new engine's.
  proc: any;
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
  private requestId: number = 0;
  private pending: Map<number, PendingRequest> = new Map();
  private buffer: string = '';
  private readonly TIMEOUT_MS = 300000; // 5 min — backups can take a while
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
   * call's time limit starts only when every call sent to `proc` before it is done.
   * Otherwise thumbnails asked for during a long export would time out while they
   * wait their turn. A call that times out stops holding up the ones behind it, so
   * a stuck engine can't keep them waiting forever.
   */
  private startClock(proc: any): void {
    for (const [id, req] of this.pending) {
      if (req.proc !== proc) continue;
      if (!req.timeout) {
        req.timeout = setTimeout(() => {
          this.finish(id);
          req.reject(new Error(`Sidecar call timed out: ${req.method}`));
        }, req.timeoutMs);
      }
      return;
    }
  }

  /**
   * The engine sent a progress report, so the call it is working on is still going:
   * that call's time limit starts over. A backup or save can then run for as long as
   * it keeps reporting progress, and times out only after a whole limit with none.
   * (A big backup over a slow connection can take longer than its 2-hour limit.)
   */
  private restartClock(proc: any): void {
    for (const [, req] of this.pending) {
      if (req.proc !== proc) continue;
      if (req.timeout) clearTimeout(req.timeout);
      req.timeout = null;
      this.startClock(proc);
      return;
    }
  }

  /** Stop waiting for call `id` and start the clock of the next one in line. */
  private finish(id: number): PendingRequest | undefined {
    const req = this.pending.get(id);
    if (!req) return undefined;
    if (req.timeout) clearTimeout(req.timeout);
    this.pending.delete(id);
    this.startClock(req.proc);
    return req;
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
          if (this.notificationHandler) {
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
    const id = ++this.requestId;
    const request = JSON.stringify({ id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject, timeoutMs: timeoutMs ?? this.TIMEOUT_MS, timeout: null, proc });
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
