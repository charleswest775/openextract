// Tests for electron/pdfExport.ts: the temporary staging folders, PDF file naming
// (never overwrite), what is asked of the engine, the locked-down hidden window and
// its request filter. Chromium's printing is stubbed, so these check the main
// process's side of the export, not the PDF itself.
// Run with: node --test scripts/pdf-export.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElectron, loadElectronModule, freshDir, quietConsole } from './test-helpers/electron-env.mjs';

const quiet = quietConsole(['[pdf-export]']);
process.on('exit', () => quiet.restore());

const PREFIX = 'openextract-pdf-';
const HOUR = 60 * 60 * 1000;

/** A fresh pdfExport module with its own temp folder and output folder. */
function setup({ countryCode = 'US', locale = 'en-US', temp } = {}) {
  temp ??= freshDir('pdf-temp');
  const outputDir = freshDir('pdf-out');
  const env = createElectron({ paths: { temp }, countryCode, locale });
  const { module: pdf } = loadElectronModule('pdfExport', { electron: env.electron });
  return { env, pdf, temp, outputDir };
}

/**
 * A stand-in for the engine's pdf_source export: writes the HTML files (and an
 * attachment) into the staging folder it is given, and answers like the engine.
 */
function fakeEngine(files = ['Mom.html'], { messageCount = 12, onCall } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs, stagingExisted: fs.existsSync(params.output_dir) });
      if (onCall) {
        const answer = await onCall(params);
        if (answer !== undefined) return answer;
      }
      const written = files.map(rel => {
        const file = path.join(params.output_dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '<html><body><img src="attachments/a.jpg"></body></html>');
        return file;
      });
      fs.mkdirSync(path.join(params.output_dir, 'attachments'), { recursive: true });
      fs.writeFileSync(path.join(params.output_dir, 'attachments', 'a.jpg'), 'jpeg');
      return files.length === 1 && method === 'export_conversation'
        ? { file: written[0], message_count: messageCount }
        : { files: written, message_count: messageCount };
    },
  };
}

const stagingDirsIn = temp => fs.readdirSync(temp).filter(n => n.startsWith(PREFIX));

function makeOld(dir, ageMs) {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, t, t);
}

describe('removeStaleStagingDirs', () => {
  test('removes old staging folders and leaves new ones, other folders and files alone', () => {
    const { pdf, temp } = setup();
    const mk = (name, ageMs, isDir = true) => {
      const p = path.join(temp, name);
      if (isDir) {
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, 'photo.jpg'), 'x');
      } else fs.writeFileSync(p, 'x');
      if (ageMs) makeOld(p, ageMs);
      return p;
    };
    mk(`${PREFIX}old`, 2 * HOUR);
    mk(`${PREFIX}new`, 0);
    mk(`${PREFIX}file`, 2 * HOUR, false);
    mk('someone-elses-old-dir', 2 * HOUR);
    pdf.removeStaleStagingDirs();
    assert.deepEqual(fs.readdirSync(temp).sort(), [`${PREFIX}file`, `${PREFIX}new`, 'someone-elses-old-dir']);

    // A shorter age catches the newer one too.
    makeOld(path.join(temp, `${PREFIX}new`), 10 * 60 * 1000);
    pdf.removeStaleStagingDirs(5 * 60 * 1000);
    assert.deepEqual(stagingDirsIn(temp), [`${PREFIX}file`]);
  });

  test('a temp folder that can\'t be read is not an error', () => {
    const { pdf } = setup({ temp: path.join(freshDir('pdf-temp'), 'does-not-exist') });
    const before = quiet.lines.length;
    assert.doesNotThrow(() => pdf.removeStaleStagingDirs());
    assert.match(quiet.lines.slice(before).join('\n'), /could not check for old temporary folders/);
  });

  test('doesn\'t remove the staging folder of an export that is still running', async () => {
    const { pdf, temp, outputDir } = setup();
    const engine = fakeEngine(['Mom.html'], {
      onCall: params => {
        pdf.removeStaleStagingDirs(-1); // everything counts as old
        assert.ok(fs.existsSync(params.output_dir), 'the running export\'s folder was removed');
      },
    });
    const result = await pdf.exportMessagesPdf(engine, 'export_conversation', { output_dir: outputDir });
    assert.equal(result.files.length, 1);
    assert.deepEqual(stagingDirsIn(temp), []);
  });

  // e.g. macOS /var -> /private/var
  test(
    'doesn\'t remove a running export\'s folder when the temp path isn\'t canonical',
    async () => {
      const real = freshDir('pdf-temp-real');
      const link = path.join(freshDir('pdf-temp-link'), 'temp');
      fs.symlinkSync(real, link, 'junction'); // a junction needs no admin rights on Windows
      const { pdf, outputDir } = setup({ temp: link });
      let survived;
      const engine = fakeEngine(['Mom.html'], {
        onCall: params => {
          pdf.removeStaleStagingDirs(-1);
          survived = fs.existsSync(params.output_dir);
          if (!survived) return { error: 'staging folder was removed mid-export' };
        },
      });
      await pdf.exportMessagesPdf(engine, 'export_conversation', { output_dir: outputDir }).catch(() => {});
      assert.equal(survived, true);
    },
  );
});

describe('exportMessagesPdf', () => {
  test('only the two conversation exports are allowed, and the engine isn\'t asked otherwise', async () => {
    const { pdf, outputDir } = setup();
    const engine = fakeEngine();
    for (const method of ['list_messages', 'write_file', 'export_calls', '__proto__', '']) {
      await assert.rejects(pdf.exportMessagesPdf(engine, method, { output_dir: outputDir }), {
        message: `PDF export is not available for ${method}`,
      });
    }
    assert.equal(engine.calls.length, 0);
  });

  test('a missing output folder is refused with a message the user can act on', async () => {
    const { pdf, temp } = setup();
    const engine = fakeEngine();
    for (const params of [undefined, {}, { output_dir: '' }, { output_dir: path.join(temp, 'nope') }]) {
      await assert.rejects(pdf.exportMessagesPdf(engine, 'export_conversation', params), {
        message: 'Choose a folder to save the PDF in.',
      });
    }
    assert.equal(engine.calls.length, 0);
    assert.deepEqual(stagingDirsIn(temp), []);
  });

  test('asks the engine for print-ready HTML in a fresh staging folder, and cleans it up', async () => {
    const { env, pdf, temp, outputDir } = setup();
    const engine = fakeEngine(['Mom.html'], { messageCount: 42 });
    const params = { backup_dir: 'B', chat_id: 7, include_attachments: true, output_dir: outputDir };
    const result = await pdf.exportMessagesPdf(engine, 'export_conversation', params);

    assert.equal(engine.calls.length, 1);
    const call = engine.calls[0];
    assert.equal(call.method, 'export_conversation');
    assert.equal(call.timeoutMs, HOUR);
    assert.equal(call.stagingExisted, true);
    assert.deepEqual({ ...call.params, output_dir: undefined }, { backup_dir: 'B', chat_id: 7, include_attachments: true, format: 'pdf_source', output_dir: undefined });
    assert.equal(path.dirname(call.params.output_dir), temp);
    assert.ok(path.basename(call.params.output_dir).startsWith(PREFIX));
    assert.equal(params.output_dir, outputDir, 'the caller\'s params were changed');

    assert.deepEqual(result, { files: [path.join(outputDir, 'Mom.pdf')], message_count: 42 });
    assert.ok(fs.existsSync(result.files[0]));
    assert.deepEqual(stagingDirsIn(temp), [], 'the staging folder (with copies of photos) was left behind');

    // The hidden window loaded the staged HTML, printed it and was closed.
    assert.equal(env.windows.length, 1);
    const win = env.windows[0];
    assert.deepEqual(win.loaded, [['file', path.join(call.params.output_dir, 'Mom.html')]]);
    assert.equal(win.closeCalled, true);
    assert.equal(win.isDestroyed(), true);
    assert.deepEqual(win.webContents.printOptions, {
      printBackground: true,
      pageSize: 'Letter',
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
    });
  });

  test('never overwrites: an existing Mom.pdf makes the next one Mom (2).pdf, then Mom (3).pdf', async () => {
    const { pdf, outputDir } = setup();
    fs.writeFileSync(path.join(outputDir, 'Mom.pdf'), 'the first one');
    fs.writeFileSync(path.join(outputDir, 'Mom (2).pdf'), 'the second one');
    const result = await pdf.exportMessagesPdf(fakeEngine(), 'export_conversation', { output_dir: outputDir });
    assert.deepEqual(result.files, [path.join(outputDir, 'Mom (3).pdf')]);
    assert.equal(fs.readFileSync(path.join(outputDir, 'Mom.pdf'), 'utf-8'), 'the first one');
    assert.equal(fs.readFileSync(path.join(outputDir, 'Mom (2).pdf'), 'utf-8'), 'the second one');
  });

  test('several conversations, two with the same name, dots and accents in names', async () => {
    const { pdf, outputDir } = setup();
    const names = [path.join('a', 'Mom.html'), path.join('b', 'Mom.html'), 'Dr. Who.html', 'Zoë & José 🙂.html'];
    const result = await pdf.exportMessagesPdf(fakeEngine(names), 'export_conversations', { output_dir: outputDir });
    assert.deepEqual(
      result.files.map(f => path.basename(f)),
      ['Mom.pdf', 'Mom (2).pdf', 'Dr. Who.pdf', 'Zoë & José 🙂.pdf'],
    );
    for (const f of result.files) assert.equal(path.dirname(f), outputDir);
    assert.deepEqual(fs.readdirSync(outputDir).sort(), [...result.files.map(f => path.basename(f))].sort());
  });

  test('an engine error is passed on, and nothing is left behind', async () => {
    const { env, pdf, temp, outputDir } = setup();
    const answers = fakeEngine([], { onCall: () => ({ error: 'This conversation has no messages' }) });
    await assert.rejects(pdf.exportMessagesPdf(answers, 'export_conversation', { output_dir: outputDir }), {
      message: 'This conversation has no messages',
    });
    const throws = { call: async () => { throw new Error('Sidecar call timed out: export_conversation'); } };
    await assert.rejects(pdf.exportMessagesPdf(throws, 'export_conversation', { output_dir: outputDir }), /timed out/);
    assert.deepEqual(stagingDirsIn(temp), []);
    assert.deepEqual(fs.readdirSync(outputDir), []);
    assert.equal(env.windows.length, 0);
  });

  test('an engine answer pointing outside the staging folder is refused before any window opens', async () => {
    const { env, pdf, temp, outputDir } = setup();
    const elsewhere = path.join(freshDir('pdf-elsewhere'), 'secret.html');
    fs.writeFileSync(elsewhere, '<html></html>');
    const engine = fakeEngine([], { onCall: () => ({ file: elsewhere, message_count: 1 }) });
    await assert.rejects(pdf.exportMessagesPdf(engine, 'export_conversation', { output_dir: outputDir }), {
      message: 'Unexpected export file location',
    });
    // A sibling folder whose name merely starts with the staging folder's name doesn't count as inside.
    const sibling = fakeEngine([], {
      onCall: params => {
        const evil = `${params.output_dir}-evil`;
        fs.mkdirSync(evil);
        fs.writeFileSync(path.join(evil, 'x.html'), '');
        return { files: [path.join(evil, 'x.html')] };
      },
    });
    await assert.rejects(pdf.exportMessagesPdf(sibling, 'export_conversations', { output_dir: outputDir }), {
      message: 'Unexpected export file location',
    });
    assert.equal(env.windows.length, 0);
    assert.deepEqual(fs.readdirSync(outputDir), []);
    assert.deepEqual(stagingDirsIn(temp).filter(n => !n.endsWith('-evil')), []);
  });

  test('a symlink in the staging folder that points outside it is refused', async t => {
    const { env, pdf, outputDir } = setup();
    const outside = path.join(freshDir('pdf-elsewhere'), 'secret.html');
    fs.writeFileSync(outside, '<html></html>');
    let linked = true;
    const engine = fakeEngine([], {
      onCall: params => {
        const link = path.join(params.output_dir, 'Mom.html');
        try {
          fs.symlinkSync(outside, link, 'file');
        } catch (err) {
          if (err.code !== 'EPERM') throw err;
          linked = false; // Windows without Developer Mode can't make file symlinks
          return { error: 'skip' };
        }
        return { file: link };
      },
    });
    const run = pdf.exportMessagesPdf(engine, 'export_conversation', { output_dir: outputDir });
    if (!linked) {
      await run.catch(() => {});
      return t.skip('this account can\'t create symlinks');
    }
    await assert.rejects(run, { message: 'Unexpected export file location' });
    assert.equal(env.windows.length, 0);
  });

  test('when printing fails the window is still closed, the staging folder removed and no PDF written', async () => {
    const { env, pdf, temp, outputDir } = setup();
    env.hooks.printToPDF = async () => {
      throw new Error('Printing failed');
    };
    await assert.rejects(pdf.exportMessagesPdf(fakeEngine(), 'export_conversation', { output_dir: outputDir }), {
      message: 'Printing failed',
    });
    assert.equal(env.windows.length, 1);
    assert.equal(env.windows[0].isDestroyed(), true);
    assert.deepEqual(stagingDirsIn(temp), []);
    assert.deepEqual(fs.readdirSync(outputDir), []);
  });

  test('page size: Letter for the US and Canada, A4 elsewhere, falling back to the locale', async () => {
    const cases = [
      [{ countryCode: 'US' }, 'Letter'],
      [{ countryCode: 'de' }, 'A4'],
      [{ countryCode: 'PH' }, 'Letter'],
      [{ countryCode: () => { throw new Error('not on this platform'); }, locale: 'en-CA' }, 'Letter'],
      [{ countryCode: '', locale: 'fr' }, 'A4'],
      [{ countryCode: '', locale: 'es-MX' }, 'Letter'],
      [{ countryCode: '', locale: '' }, 'A4'],
    ];
    for (const [options, expected] of cases) {
      const { env, pdf, outputDir } = setup(options);
      await pdf.exportMessagesPdf(fakeEngine(), 'export_conversation', { output_dir: outputDir });
      assert.equal(env.windows[0].webContents.printOptions.pageSize, expected, JSON.stringify(options));
    }
  });
});

describe('the hidden window', () => {
  test('is locked down: no JavaScript, sandboxed, isolated, no popups or navigation', async () => {
    const { env, pdf, outputDir } = setup();
    await pdf.exportMessagesPdf(fakeEngine(), 'export_conversation', { output_dir: outputDir });
    const win = env.windows[0];
    const prefs = win.options.webPreferences;
    assert.equal(win.options.show, false);
    assert.equal(prefs.javascript, false);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.spellcheck, false);
    assert.equal(prefs.preload, undefined);
    // Its own in-memory session, not the app's (no "persist:" prefix).
    assert.equal(prefs.session.name, 'openextract-pdf-export');
    assert.deepEqual(win.webContents.windowOpenHandler(), { action: 'deny' });
    let prevented = false;
    win.webContents.emit('will-navigate', { preventDefault: () => (prevented = true) }, 'https://example.com');
    assert.equal(prevented, true);
  });

  test('its session may only read files inside the running export\'s staging folder', async () => {
    const { env, pdf, outputDir } = setup();
    const ses = env.sessions.get('openextract-pdf-export') ?? null;
    assert.equal(ses, null, 'the session is set up on first use, not at load');
    const other = path.join(freshDir('pdf-other'), 'notes.txt');
    fs.writeFileSync(other, 'private');

    const decide = url => {
      const filter = env.sessions.get('openextract-pdf-export').beforeRequest[0];
      let answer;
      filter({ url }, r => (answer = r));
      return answer.cancel ? 'blocked' : 'allowed';
    };
    let staging;
    const seenDuringLoad = {};
    env.hooks.loadFile = async (_win, htmlPath) => {
      staging = path.dirname(htmlPath);
      Object.assign(seenDuringLoad, {
        page: decide(pathToFileURL(htmlPath).href),
        attachment: decide(pathToFileURL(path.join(staging, 'attachments', 'a.jpg')).href),
        dotdot: decide(pathToFileURL(staging).href + '/../' + path.basename(staging) + '-x/y.jpg'),
        stagingItself: decide(pathToFileURL(staging).href),
        otherFile: decide(pathToFileURL(other).href),
        sibling: decide(pathToFileURL(`${staging}-evil`).href + '/a.jpg'),
        web: decide('https://tracker.example.com/pixel.gif'),
        http: decide('http://127.0.0.1:5179/'),
        data: decide('data:image/png;base64,AAAA'),
        garbage: decide('::not a url::'),
      });
    };
    await pdf.exportMessagesPdf(fakeEngine(), 'export_conversation', { output_dir: outputDir });
    assert.deepEqual(seenDuringLoad, {
      page: 'allowed',
      attachment: 'allowed',
      dotdot: 'blocked',
      stagingItself: 'blocked',
      otherFile: 'blocked',
      sibling: 'blocked',
      web: 'blocked',
      http: 'blocked',
      data: 'blocked',
      garbage: 'blocked',
    });
    // Once the export is done, its folder is closed off again.
    assert.equal(decide(pathToFileURL(path.join(staging, 'Mom.html')).href), 'blocked');

    const session = env.sessions.get('openextract-pdf-export');
    let granted;
    session.permissionHandlers[0](null, 'media', ok => (granted = ok));
    assert.equal(granted, false);
    assert.deepEqual(session.spellChecker, [['enabled', false], ['languages', []]]);

    // The filter is installed once, not once per export.
    await pdf.exportMessagesPdf(fakeEngine(), 'export_conversation', { output_dir: outputDir });
    assert.equal(session.beforeRequest.length, 1);
    assert.equal(session.permissionHandlers.length, 1);
  });
});
