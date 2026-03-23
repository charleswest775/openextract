export {};
const { spawn } = require('child_process');

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
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

  /**
   * Called for every JSON-RPC *notification* received from the sidecar.
   * Notifications are one-way messages that have no `id` field.
   * Set this before calling start() to receive backup.progress events.
   */
  public notificationHandler: ((notification: SidecarNotification) => void) | null = null;

  constructor(pythonPath: string, pythonArgs: string[]) {
    this.pythonPath = pythonPath;
    this.pythonArgs = pythonArgs;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.pythonPath, this.pythonArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      this.process.stdout.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.process.stderr.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.error(`[Python] ${msg}`);
          require('fs').appendFileSync('python_log.txt', `[STDERR] ${msg}\n`);
        }
      });

      this.process.on('error', (err: Error) => {
        console.error('Failed to start Python sidecar:', err);
        require('fs').appendFileSync('python_log.txt', `[ERROR STARTING] ${err.message}\n`);
        reject(err);
      });

      this.process.on('exit', (code: number) => {
        console.log(`Python sidecar exited with code ${code}`);
        require('fs').appendFileSync('python_log.txt', `[EXIT] code ${code}\n`);
        // Reject all pending requests
        for (const [id, req] of this.pending) {
          clearTimeout(req.timeout);
          req.reject(new Error(`Sidecar exited with code ${code}`));
        }
        this.pending.clear();
      });

      // Give the process a moment to start, then verify it's running
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          resolve();
        } else {
          reject(new Error('Python sidecar failed to start'));
        }
      }, 500);
    });
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
          if (this.notificationHandler) {
            this.notificationHandler(message as SidecarNotification);
          }
          continue;
        }

        // Normal response: match by id to a pending call.
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(message.id);
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
    if (!this.process || this.process.killed) {
      throw new Error('Python sidecar is not running');
    }

    const id = ++this.requestId;
    const request = JSON.stringify({ id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sidecar call timed out: ${method}`));
      }, timeoutMs ?? this.TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout });
      this.process.stdin.write(request);
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

