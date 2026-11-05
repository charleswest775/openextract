// A stand-in for the Python engine (python/main.py), for scripts/sidecar.test.mjs.
// PythonSidecar spawns it as `node fake-engine.cjs <mode>`. It speaks the same
// JSON-RPC-over-stdio as the real engine; the request's method picks what it does,
// so a test can produce each situation the client has to cope with.
//
// Modes (argv[2]):
//   normal         announce {"status":"ready"} like the engine, then serve requests
//   crlf           the same, but end every line with \r\n (Windows text-mode stdout)
//   crash-on-start write to stderr and exit with code 7 before serving anything
//   close-stdin    close stdin straight away but keep running
'use strict';

const fs = require('fs');

const mode = process.argv[2] || 'normal';
const EOL = mode === 'crlf' ? '\r\n' : '\n';

// Stay alive until killed, even after stdin ends, so stop() has to really kill us.
setInterval(() => {}, 60_000);

const out = text => process.stdout.write(text);
const line = obj => out(JSON.stringify(obj) + EOL);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (mode === 'crash-on-start') {
  process.stderr.write('Traceback (most recent call last):\nModuleNotFoundError: No module named fake\n');
  setTimeout(() => process.exit(7), 20);
  return;
}
if (mode === 'close-stdin') {
  process.stdin.destroy();
  try {
    fs.closeSync(0);
  } catch {
    // Already closed by destroy() on some platforms.
  }
  return;
}

process.stderr.write('fake engine starting\n');
line({ status: 'ready' });

const held = [];
let seq = 0;

const handlers = {
  echo: (id, params) => line({ id, result: { id, seq: ++seq, params } }),

  env: id =>
    line({
      id,
      result: { PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED, OPENEXTRACT_LOG_PATH: process.env.OPENEXTRACT_LOG_PATH },
    }),

  pid: id => line({ id, result: process.pid }),

  // No answer until a `release` call.
  hold: (id, params) => held.push({ id, params }),

  // Answer every held call in reverse order, all in a single write, then this call.
  release: id => {
    const batch = held.splice(0).reverse();
    out(batch.map(h => JSON.stringify({ id: h.id, result: h.params }) + EOL).join(''));
    line({ id, result: { released: batch.length } });
  },

  delay: async (id, params) => {
    await sleep(params.ms);
    line({ id, result: params.result ?? 'late' });
  },

  error: (id, params) =>
    line({ id, error: params.message === undefined ? { code: -32000 } : { code: params.code ?? -32000, message: params.message } }),

  // One response written in several pieces with a pause between them.
  split: async (id, params) => {
    const bytes = Buffer.from(JSON.stringify({ id, result: params.payload }) + EOL, 'utf-8');
    const cuts = params.cuts ?? [];
    let start = 0;
    for (const cut of [...cuts, bytes.length]) {
      out(bytes.subarray(start, cut));
      start = cut;
      if (start < bytes.length) await sleep(params.gap ?? 30);
    }
  },

  // Answer with a big result; the pipe delivers it in many chunks on its own.
  big: (id, params) => line({ id, result: 'x'.repeat(params.size) }),

  notify: (id, params) => {
    for (let i = 1; i <= params.count; i++) {
      line({ jsonrpc: '2.0', method: 'backup.progress', params: { phase: 'backing_up', percent: i } });
    }
    line({ id, result: { notified: params.count } });
  },

  // Things a stray print, a library or a broken engine could put on stdout.
  noise: id => {
    out('WARN: decrypted 1234 bytes' + EOL);
    out(EOL + '   ' + EOL);
    out('{not json at all' + EOL);
    out('[1, 2' + EOL);
    out('null' + EOL);
    out('42' + EOL);
    line({ id: 999999, result: 'answer to a call nobody made' });
    line({ id: null, error: { code: -32700, message: 'Parse error' } });
    line({ status: 'info', message: 'debugpy listening' });
    line({ id, result: 'after the noise' });
  },

  stderr: (id, params) => {
    process.stderr.write(params.text);
    line({ id, result: 'ok' });
  },

  // Die mid-line, like a crash in native code.
  crash: (id, params) => {
    out('{"id": 424242, "resu');
    setTimeout(() => process.exit(params.code ?? 3), 10);
  },
};

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let req;
    try {
      req = JSON.parse(raw);
    } catch (err) {
      line({ id: null, error: { code: -32700, message: `Parse error: ${err.message}` } });
      continue;
    }
    const handler = handlers[req.method];
    if (!handler) line({ id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } });
    else handler(req.id, req.params ?? {});
  }
});
