// Tests for electron/sidecar.ts, the JSON-RPC client the main process uses to talk
// to the engine. Most run against a fake engine (test-helpers/fake-engine.cjs, run
// with this Node), and one against the real python/main.py when a Python with the
// engine's dependencies is around.
// Run with: node --test scripts/sidecar.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, freshDir, loadElectronModule, quietConsole, waitFor, isAlive } from './test-helpers/electron-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = path.join(here, 'test-helpers', 'fake-engine.cjs');

const { module: sidecarModule, dir: sidecarDir } = loadElectronModule('sidecar');
const { PythonSidecar } = sidecarModule;

const quiet = quietConsole(['[Python]', 'Python sidecar exited', 'Failed to parse sidecar response', 'Failed to start Python sidecar']);
// Restored at exit, not in after(): an engine's exit can be reported after the last test.
process.on('exit', () => quiet.restore());

function fakeSidecar(mode = 'normal') {
  const logPath = path.join(freshDir('sidecar-log'), 'python_log.txt');
  const sidecar = new PythonSidecar(process.execPath, [FAKE_ENGINE, mode], logPath);
  return { sidecar, logPath };
}

const readLog = logPath => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '');

describe('PythonSidecar with a running engine', () => {
  let sidecar;
  let logPath;
  before(async () => {
    ({ sidecar, logPath } = fakeSidecar());
    await sidecar.start();
  });
  after(() => sidecar.stop());

  test('passes the log path and unbuffered output to the engine', async () => {
    const env = await sidecar.call('env');
    assert.equal(env.OPENEXTRACT_LOG_PATH, logPath);
    assert.equal(env.PYTHONUNBUFFERED, '1');
  });

  test('ids are unique and increasing across many concurrent calls, and each call gets its own answer', async () => {
    const first = await Promise.all(Array.from({ length: 200 }, (_, i) => sidecar.call('echo', { i })));
    first.forEach((r, i) => assert.equal(r.params.i, i, `call ${i} got another call's answer`));
    const ids = first.map(r => r.id);
    assert.equal(new Set(ids).size, ids.length, 'an id was used twice');
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], `id ${ids[i]} after ${ids[i - 1]}`);
    // The engine saw them in the same order they were made.
    for (let i = 1; i < first.length; i++) assert.ok(first[i].seq > first[i - 1].seq);

    const second = await Promise.all(Array.from({ length: 50 }, () => sidecar.call('echo')));
    assert.ok(Math.min(...second.map(r => r.id)) > Math.max(...ids), 'ids were reused');
  });

  test('answers arriving out of order resolve the right calls', async () => {
    const order = [];
    const held = [1, 2, 3, 4, 5].map(n => sidecar.call('hold', { n }).then(r => (order.push(n), r)));
    const released = await sidecar.call('release');
    assert.deepEqual(released, { released: 5 });
    const results = await Promise.all(held);
    assert.deepEqual(results.map(r => r.n), [1, 2, 3, 4, 5]);
    assert.deepEqual(order, [5, 4, 3, 2, 1]);
  });

  test('one answer split across several stdout chunks is put back together', async t => {
    const payload = { text: 'split '.repeat(20), nested: { list: [1, 2, 3] } };
    const chunks = [];
    const onData = d => chunks.push(d.length);
    sidecar.process.stdout.on('data', onData);
    try {
      const result = await sidecar.call('split', { payload, cuts: [1, 9, 40, 80], gap: 30 });
      assert.deepEqual(result, payload);
    } finally {
      sidecar.process.stdout.off('data', onData);
    }
    // Only informational: a busy machine can merge the pieces into fewer chunks.
    if (chunks.length < 2) t.diagnostic(`the split answer arrived in ${chunks.length} chunk(s)`);
  });

  test('a large answer that the pipe delivers in many chunks parses', async () => {
    const result = await sidecar.call('big', { size: 1_500_000 });
    assert.equal(result.length, 1_500_000);
  });

  test(
    'a multi-byte UTF-8 character split between two chunks survives',
    {
      todo:
        'LATENT BUG: sidecar.ts does `this.buffer += data.toString()` per chunk, so a character split across ' +
        'chunks becomes U+FFFD. The real engine only writes ASCII today (json.dumps escapes non-ASCII), ' +
        'so this only bites if that changes. Fix: stdout.setEncoding("utf8") or a StringDecoder.',
    },
    async () => {
      const payload = 'Zoë 🙂 café';
      // Cut the answer line in the middle of "ë" and in the middle of the emoji.
      const id = sidecar.requestId + 1;
      const line = Buffer.from(JSON.stringify({ id, result: payload }) + '\n', 'utf-8');
      const cuts = [line.indexOf(Buffer.from('ë')) + 1, line.indexOf(Buffer.from('🙂')) + 2];
      assert.equal(await sidecar.call('split', { payload, cuts, gap: 40 }), payload);
    },
  );

  test('notifications go to notificationHandler, in order, and resolve nothing', async () => {
    const seen = [];
    sidecar.notificationHandler = n => seen.push(n);
    try {
      const pendingHold = sidecar.call('hold', { n: 'still waiting' });
      const result = await sidecar.call('notify', { count: 3 });
      assert.deepEqual(result, { notified: 3 });
      assert.deepEqual(
        seen.map(n => [n.method, n.params.percent]),
        [['backup.progress', 1], ['backup.progress', 2], ['backup.progress', 3]],
      );
      // The held call wasn't resolved by any of them.
      let settled = false;
      pendingHold.then(() => (settled = true), () => (settled = true));
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(settled, false);
      await sidecar.call('release');
      assert.deepEqual(await pendingHold, { n: 'still waiting' });
    } finally {
      sidecar.notificationHandler = null;
    }
  });

  test('notifications with no handler set are dropped without breaking anything', async () => {
    assert.equal(sidecar.notificationHandler, null);
    assert.deepEqual(await sidecar.call('notify', { count: 2 }), { notified: 2 });
  });

  test('an error answer rejects with the engine\'s message, and the engine keeps working', async () => {
    await assert.rejects(sidecar.call('error', { message: 'This backup is encrypted' }), err => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'This backup is encrypted');
      return true;
    });
    await assert.rejects(sidecar.call('error', {}), { message: 'Unknown error' });
    await assert.rejects(sidecar.call('no_such_method'), { message: 'Unknown method: no_such_method' });
    assert.equal((await sidecar.call('echo', { ok: 1 })).params.ok, 1);
  });

  test('lines that aren\'t JSON-RPC answers are skipped, and later calls still work', async () => {
    const before = quiet.lines.length;
    assert.equal(await sidecar.call('noise'), 'after the noise');
    const logged = quiet.lines.slice(before).join('\n');
    assert.match(logged, /Failed to parse sidecar response: WARN: decrypted/);
    assert.match(logged, /\{not json at all/);
    assert.equal((await sidecar.call('echo', { after: true })).params.after, true);
    assert.equal(sidecar.pending.size, 0);
  });

  test('a call that runs past its timeout rejects, and its late answer is ignored', async () => {
    const started = Date.now();
    await assert.rejects(sidecar.call('hold', { late: true }, 100), { message: 'Sidecar call timed out: hold' });
    assert.ok(Date.now() - started >= 95, 'timed out early');
    assert.equal(sidecar.pending.size, 0);

    // `release` answers the timed-out call (late) and this one; only this one may resolve.
    const waiting = sidecar.call('hold', { mine: true });
    assert.deepEqual(await sidecar.call('release'), { released: 2 });
    assert.deepEqual(await waiting, { mine: true });
    assert.equal(sidecar.pending.size, 0);
  });

  test('the engine\'s stderr is appended to the log file', async () => {
    await waitFor(() => readLog(logPath).includes('[STDERR] fake engine starting'), { what: 'startup stderr in the log' });
    await sidecar.call('stderr', { text: 'Traceback (most recent call last):\nValueError: bad manifest\n' });
    // A chunk boundary may fall between the two lines, so look for each on its own.
    await waitFor(
      () => readLog(logPath).includes('[STDERR] Traceback (most recent call last):') && readLog(logPath).includes('ValueError: bad manifest'),
      { what: 'the traceback in the log' },
    );
  });
});

// Not in the concurrent group below: it relies on the engine dying within start()'s 500 ms wait.
test('an engine that dies while starting fails start(), and calls fail straight away', async () => {
  const { sidecar, logPath } = fakeSidecar('crash-on-start');
  await assert.rejects(sidecar.start(), { message: 'Python sidecar failed to start' });
  await assert.rejects(sidecar.call('echo'), { message: 'Python sidecar is not running' });
  const log = readLog(logPath);
  assert.match(log, /\[EXIT\] code 7/);
  assert.match(log, /ModuleNotFoundError/);
});

// Each of these starts its own engine (start() waits 500 ms), so they run side by side.
describe('PythonSidecar engine lifecycle', { concurrency: true }, () => {
  test('Windows-style \\r\\n line endings parse, for answers and notifications', async () => {
    const { sidecar } = fakeSidecar('crlf');
    await sidecar.start();
    try {
      const seen = [];
      sidecar.notificationHandler = n => seen.push(n.params.percent);
      assert.deepEqual(await sidecar.call('notify', { count: 2 }), { notified: 2 });
      assert.deepEqual(seen, [1, 2]);
      assert.equal((await sidecar.call('echo', { s: 'crlf' })).params.s, 'crlf');
      await assert.rejects(sidecar.call('error', { message: 'boom' }), { message: 'boom' });
    } finally {
      sidecar.stop();
    }
  });

  test('an engine crash rejects every pending call, and later calls fail straight away', async () => {
    const { sidecar, logPath } = fakeSidecar();
    await sidecar.start();
    const pending = [1, 2, 3].map(n => sidecar.call('hold', { n }));
    const crash = sidecar.call('crash', { code: 3 });
    const results = await Promise.allSettled([...pending, crash]);
    for (const r of results) {
      assert.equal(r.status, 'rejected');
      assert.equal(r.reason.message, 'Sidecar exited with code 3');
    }
    assert.equal(sidecar.pending.size, 0);

    const started = Date.now();
    await assert.rejects(sidecar.call('echo'), { message: 'Python sidecar is not running' });
    assert.ok(Date.now() - started < 1000);
    assert.match(readLog(logPath), /\[EXIT\] code 3/);
    sidecar.stop(); // no-op once it's gone
  });

  test('an engine that can\'t be launched fails start() and is logged', async () => {
    const logPath = path.join(freshDir('sidecar-log'), 'python_log.txt');
    const missing = path.join(freshDir('missing'), process.platform === 'win32' ? 'openextract-engine.exe' : 'openextract-engine');
    const sidecar = new PythonSidecar(missing, [], logPath);
    await assert.rejects(sidecar.start(), err => /ENOENT/.test(err.code || err.message));
    assert.match(readLog(logPath), /\[ERROR STARTING\]/);
  });

  test(
    'after a failed launch, calls fail straight away instead of waiting for their timeout',
    {
      todo:
        'BUG: when spawn() fails (missing/blocked engine binary) Node emits "error" but no "exit", so ' +
        'this.process stays set and every call() writes to a dead stdin and hangs until its timeout ' +
        '(5 minutes by default) instead of rejecting with "Python sidecar is not running". ' +
        'Fix: set this.process = null in the "error" handler too.',
    },
    async () => {
      const logPath = path.join(freshDir('sidecar-log'), 'python_log.txt');
      const missing = path.join(freshDir('missing'), 'openextract-engine');
      const sidecar = new PythonSidecar(missing, [], logPath);
      await sidecar.start().catch(() => {});
      await assert.rejects(sidecar.call('ping', {}, 600), { message: 'Python sidecar is not running' });
    },
  );

  test('stop() kills the engine, rejects what was pending, and later calls fail', async () => {
    const { sidecar } = fakeSidecar();
    await sidecar.start();
    const pid = await sidecar.call('pid');
    assert.equal(pid, sidecar.process.pid);
    const pending = sidecar.call('hold', {});
    sidecar.stop();
    // The fake engine ignores the end of stdin and stays up, so only a real kill stops it.
    await assert.rejects(pending, { message: /^Sidecar exited with code/ });
    await waitFor(() => !isAlive(pid), { what: `engine pid ${pid} to exit` });
    await assert.rejects(sidecar.call('echo'), { message: 'Python sidecar is not running' });
    sidecar.stop(); // twice is fine
  });

  test(
    'writing to an engine whose stdin has closed doesn\'t crash the main process',
    {
      todo:
        'BUG: sidecar.ts has no "error" listener on the engine\'s stdin, so a write after the engine closes ' +
        'its end (e.g. it has just crashed and "exit" hasn\'t arrived yet) throws an uncaught "write EPIPE" ' +
        'in the main process (seen on macOS and Linux; on Windows this setup doesn\'t trigger it). ' +
        'Fix: this.process.stdin.on("error", ...) and reject the call.',
    },
    async () => {
      // Run in a separate Node so an uncaught exception can't take the test runner down.
      const driver = path.join(freshDir('epipe'), 'driver.cjs');
      fs.writeFileSync(
        driver,
        `const { PythonSidecar } = require(${JSON.stringify(path.join(sidecarDir, 'sidecar.js'))});
  console.log = console.error = () => {};
  const s = new PythonSidecar(process.execPath, [${JSON.stringify(FAKE_ENGINE)}, 'close-stdin'], ${JSON.stringify(path.join(path.dirname(driver), 'log.txt'))});
  let uncaught = null;
  const done = call => { process.stdout.write(JSON.stringify({ uncaught, call })); s.stop(); process.exit(0); };
  process.on('uncaughtException', e => { uncaught = e.message; done('n/a'); });
  s.start()
    .then(() => s.call('echo', {}, 1500))
    .then(() => done('resolved'), e => setTimeout(() => done('rejected: ' + e.message), 200));
  `,
      );
      const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'inherit'] });
      let output = '';
      child.stdout.on('data', d => (output += d));
      const guard = setTimeout(() => child.kill(), 15_000); // never hang the run
      await new Promise(resolve => child.on('close', resolve));
      clearTimeout(guard);
      const report = JSON.parse(output);
      assert.equal(report.uncaught, null, `uncaught exception: ${report.uncaught}`);
      assert.match(report.call, /^rejected/);
    },
  );
});

// ── The real engine ─────────────────────────────────────────────────────────

function findEnginePython() {
  const venv = process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  const candidates = [process.env.OPENEXTRACT_TEST_PYTHON, venv, 'python3', 'python'].filter(Boolean);
  const tried = [];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) {
      tried.push(`${candidate} (missing)`);
      continue;
    }
    const probe = spawnSync(candidate, ['-c', 'import ios_backup_core'], {
      cwd: path.join(root, 'python'),
      encoding: 'utf-8',
      timeout: 60_000,
    });
    if (probe.status === 0) return { python: candidate };
    tried.push(`${candidate} (${probe.error ? probe.error.code : 'no ios_backup_core'})`);
  }
  return { python: null, tried };
}

const engine = findEnginePython();
const noEngine = engine.python
  ? false
  : `no Python with the engine's dependencies found; set OPENEXTRACT_TEST_PYTHON to one. Tried: ${engine.tried.join(', ')}`;

describe('PythonSidecar with the real engine (python/main.py)', { skip: noEngine }, () => {
  let sidecar;
  let logPath;
  before(async () => {
    logPath = path.join(freshDir('real-engine'), 'python_log.txt');
    sidecar = new PythonSidecar(engine.python, [path.join(root, 'python', 'main.py')], logPath);
    await sidecar.start();
  });
  after(() => sidecar?.stop());

  test('ping answers', async () => {
    const result = await sidecar.call('ping', {}, 60_000);
    assert.equal(result.status, 'ok');
    assert.equal(typeof result.version, 'string');
  });

  test('an unknown method rejects with the engine\'s message', async () => {
    await assert.rejects(sidecar.call('definitely_not_a_method', {}, 60_000), {
      message: 'Unknown method: definitely_not_a_method',
    });
  });

  test(
    'non-ASCII text in a request reaches the engine intact',
    {
      todo:
        process.platform === 'win32'
          ? 'BUG (Windows): the engine reads stdin with the ANSI code page (cp1252), not UTF-8, because ' +
            'sidecar.ts sets neither PYTHONUTF8=1 nor PYTHONIOENCODING=utf-8 and main.py doesn\'t reconfigure stdin. ' +
            'Paths and text with accents or emoji arrive garbled.'
          : false,
    },
    async () => {
      // The engine echoes an unknown method's name in its error, so the name makes a round trip.
      const name = 'zoë_café_🙂';
      await assert.rejects(sidecar.call(name, {}, 60_000), { message: `Unknown method: ${name}` });
    },
  );

  test('stop() ends the engine', async () => {
    const pid = sidecar.process.pid;
    sidecar.stop();
    await waitFor(() => !isAlive(pid), { what: 'the engine to exit' });
    await assert.rejects(sidecar.call('ping'), { message: 'Python sidecar is not running' });
  });
});
