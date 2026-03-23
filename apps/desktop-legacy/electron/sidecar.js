"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PythonSidecar = void 0;
const { spawn } = require('child_process');
class PythonSidecar {
    constructor(pythonPath, pythonArgs) {
        this.process = null;
        this.requestId = 0;
        this.pending = new Map();
        this.buffer = '';
        this.TIMEOUT_MS = 60000; // 60s for slow operations like decryption
        this.pythonPath = pythonPath;
        this.pythonArgs = pythonArgs;
    }
    async start() {
        return new Promise((resolve, reject) => {
            this.process = spawn(this.pythonPath, this.pythonArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
            });
            this.process.stdout.on('data', (data) => {
                this.buffer += data.toString();
                this.processBuffer();
            });
            this.process.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    console.error(`[Python] ${msg}`);
                    require('fs').appendFileSync('python_log.txt', `[STDERR] ${msg}\n`);
                }
            });
            this.process.on('error', (err) => {
                console.error('Failed to start Python sidecar:', err);
                require('fs').appendFileSync('python_log.txt', `[ERROR STARTING] ${err.message}\n`);
                reject(err);
            });
            this.process.on('exit', (code) => {
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
                }
                else {
                    reject(new Error('Python sidecar failed to start'));
                }
            }, 500);
        });
    }
    processBuffer() {
        // Each JSON-RPC response is a single line
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || ''; // Keep incomplete line in buffer
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const response = JSON.parse(trimmed);
                const pending = this.pending.get(response.id);
                if (pending) {
                    clearTimeout(pending.timeout);
                    this.pending.delete(response.id);
                    if (response.error) {
                        pending.reject(new Error(response.error.message || 'Unknown error'));
                    }
                    else {
                        pending.resolve(response.result);
                    }
                }
            }
            catch (e) {
                console.error('Failed to parse sidecar response:', trimmed);
            }
        }
    }
    async call(method, params = {}) {
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
    stop() {
        if (this.process && !this.process.killed) {
            this.process.stdin.end();
            this.process.kill();
            this.process = null;
        }
    }
}
exports.PythonSidecar = PythonSidecar;
