export {};
const { spawn } = require('child_process');

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
}

class PythonSidecar {
  private process: any = null;
  private pythonPath: string;
  private pythonArgs: string[];
  private requestId: number = 0;
  private pending: Map<number, PendingRequest> = new Map();
  private buffer: string = '';
  private readonly TIMEOUT_MS = 60000; // 60s for slow operations like decryption

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
        if (msg) console.error(`[Python] ${msg}`);
      });

      this.process.on('error', (err: Error) => {
        console.error('Failed to start Python sidecar:', err);
        reject(err);
      });

      this.process.on('exit', (code: number) => {
        console.log(`Python sidecar exited with code ${code}`);
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
    // Each JSON-RPC response is a single line
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const response = JSON.parse(trimmed);
        const pending = this.pending.get(response.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message || 'Unknown error'));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch (e) {
        console.error('Failed to parse sidecar response:', trimmed);
      }
    }
  }

  async call(method: string, params: any = {}): Promise<any> {
    if (!this.process || this.process.killed) {
      throw new Error('Python sidecar is not running');
    }

    const id = ++this.requestId;
    const request = JSON.stringify({ id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sidecar call timed out: ${method}`));
      }, this.TIMEOUT_MS);

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

module.exports = { PythonSidecar };
