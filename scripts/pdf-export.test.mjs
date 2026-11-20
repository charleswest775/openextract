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
  test('only the exports that write a print-ready page are allowed, and the engine isn\'t asked otherwise', async () => {
    const { pdf, outputDir } = setup();
    const engine = fakeEngine();
    for (const method of [
      'list_messages', 'write_file', 'export_photos', 'export_voicemails', 'export_bundle', 'export_podcasts',
      'export_whatsapp', 'get_whatsapp_messages', 'list_calls', 'list_notes', '__proto__', 'toString', '',
    ]) {
      await assert.rejects(pdf.exportMessagesPdf(engine, method, { output_dir: outputDir }), {
        message: `PDF export is not available for ${method}`,
      });
    }
    assert.equal(engine.calls.length, 0);
  });

  test('a person, notes, call history, web history and recovered messages print the same way', async () => {
    const { pdf, temp, outputDir } = setup();
    const cases = [
      ['export_person', ['Karin Lindqvist, Jul 5 2024 - Jun 21 2026.html'], {
        message_count: 120, media_folder: '/Users/jane/Desktop/Karin_attachments',
        media: { copied: 40, not_in_backup: 2, failed: 0 }, errors: { whatsapp: "WhatsApp's chats couldn't be read", junk: 7 },
      }],
      ['export_notes', ['Groceries.html', 'Trip.html'], { count: 2 }],
      ['export_calls', ['call_history.html'], { count: 1532 }],
      ['export_browser_history', ['browser_history_export.html'], { count: 40 }],
      ['export_recovered_messages', ['recovered_messages.html'], { message_count: 5 }],
    ];
    for (const [method, files, extra] of cases) {
      const engine = fakeEngine(files, {
        onCall: params => {
          const written = files.map(name => {
            fs.writeFileSync(path.join(params.output_dir, name), '<html></html>');
            return path.join(params.output_dir, name);
          });
          return written.length === 1 ? { file: written[0], ...extra } : { files: written, ...extra };
        },
      });
      const result = await pdf.exportMessagesPdf(engine, method, { udid: 'u', output_dir: outputDir, media_dir: outputDir });
      assert.deepEqual(engine.calls.map(c => [c.method, c.params.format, c.params.media_dir]), [[method, 'pdf_source', outputDir]], method);
      assert.notEqual(engine.calls[0].params.output_dir, outputDir, 'the engine writes into staging');
      assert.deepEqual(result.files, files.map(f => path.join(outputDir, f.replace(/\.html$/, '.pdf'))), method);
      assert.equal(result.message_count, extra.message_count ?? 0, method);
      // A count of records and a person's media folder are passed on when the engine gives them
      assert.equal(result.count, extra.count, method);
      assert.equal(result.media_folder, extra.media_folder, method);
      // A person's file counts and unreadable parts too (only text kept from the parts)
      assert.deepEqual(result.media, extra.media, method);
      assert.deepEqual(result.errors, extra.errors ? { whatsapp: extra.errors.whatsapp } : undefined, method);
    }
    assert.deepEqual(stagingDirsIn(temp), []);
  });

  test('the engine saying it saved nothing is an error, not an empty success', async () => {
    const { env, pdf, outputDir } = setup();
    const answers = [
      [{ status: 'error', message: 'No matching notes found.' }, 'No matching notes found.'],
      [{ success: false, error: 'No calls found to export.' }, 'No calls found to export.'],
      [{ success: false }, 'The export did not finish.'],
      [{ status: 'error' }, 'The export did not finish.'],
    ];
    for (const [answer, message] of answers) {
      await assert.rejects(pdf.exportMessagesPdf(fakeEngine([], { onCall: () => answer }), 'export_notes', { output_dir: outputDir }), { message });
    }
    assert.equal(env.windows.length, 0);
    assert.deepEqual(fs.readdirSync(outputDir), []);
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

  test('WhatsApp chats print the same way, through their own engine methods', async () => {
    const { pdf, temp, outputDir } = setup();
    // An iMessage "Riley.pdf" saved earlier in the same folder is kept
    fs.writeFileSync(path.join(outputDir, 'Riley.pdf'), 'from Messages');
    const one = fakeEngine(['Riley.html'], { messageCount: 9 });
    const result = await pdf.exportMessagesPdf(one, 'export_whatsapp_chat', { udid: 'u', chat_id: 3, output_dir: outputDir });
    assert.deepEqual(one.calls.map(c => [c.method, c.params.format, c.params.chat_id]), [['export_whatsapp_chat', 'pdf_source', 3]]);
    assert.deepEqual(result, { files: [path.join(outputDir, 'Riley (2).pdf')], message_count: 9 });
    assert.equal(fs.readFileSync(path.join(outputDir, 'Riley.pdf'), 'utf-8'), 'from Messages');

    const many = fakeEngine(['Riley (2).html', 'Hiking crew.html'], { messageCount: 30 });
    const merged = await pdf.exportMessagesPdf(many, 'export_whatsapp_chats', { udid: 'u', chat_ids: [3, 4], output_dir: outputDir });
    assert.equal(many.calls[0].method, 'export_whatsapp_chats');
    assert.deepEqual(merged.files.map(f => path.basename(f)), ['Riley (2) (2).pdf', 'Hiking crew.pdf']);
    assert.equal(merged.message_count, 30);
    assert.deepEqual(stagingDirsIn(temp), []);
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

describe('exportHtmlToPdf (a page the window built: the Timeline)', () => {
  const PAGE = '<!DOCTYPE html><html><body><h1>Timeline</h1><p>Zoë 🎉 مرحبا</p></body></html>';

  test('prints the page from a staging folder of its own, in the locked-down window, and cleans up', async () => {
    const { env, pdf, temp, outputDir } = setup();
    let seen = null;
    env.hooks.loadFile = async (_win, file) => {
      seen = { file, page: fs.readFileSync(file, 'utf-8'), staging: stagingDirsIn(temp) };
    };
    const result = await pdf.exportHtmlToPdf(PAGE, outputDir, 'timeline-export');
    assert.deepEqual(result, { file: path.join(outputDir, 'timeline-export.pdf') });
    assert.ok(fs.readFileSync(result.file, 'latin1').startsWith('%PDF-'));
    // The page went to a fresh staging folder, exactly as sent
    assert.equal(seen.page, PAGE);
    assert.equal(path.basename(seen.file), 'page.html');
    assert.ok(path.basename(path.dirname(seen.file)).startsWith(PREFIX));
    assert.equal(seen.staging.length, 1);
    assert.deepEqual(stagingDirsIn(temp), [], 'the staging folder was left behind');
    assert.deepEqual(fs.readdirSync(outputDir), ['timeline-export.pdf']);
    // The same window as the engine's pages
    const win = env.windows[0];
    assert.equal(win.options.webPreferences.javascript, false);
    assert.equal(win.options.webPreferences.session.name, 'openextract-pdf-export');
    assert.equal(win.isDestroyed(), true);
  });

  test('its staging folder is readable while it prints, and closed off afterwards', async () => {
    const { env, pdf, outputDir } = setup();
    let during, page;
    env.hooks.loadFile = async (_win, file) => {
      page = file;
      const filter = env.sessions.get('openextract-pdf-export').beforeRequest[0];
      filter({ url: pathToFileURL(file).href }, r => (during = r.cancel ? 'blocked' : 'allowed'));
    };
    await pdf.exportHtmlToPdf(PAGE, outputDir, 'x');
    assert.equal(during, 'allowed');
    let after;
    env.sessions.get('openextract-pdf-export').beforeRequest[0]({ url: pathToFileURL(page).href }, r => (after = r.cancel ? 'blocked' : 'allowed'));
    assert.equal(after, 'blocked');
  });

  test('never overwrites: Theo.pdf, then Theo (2).pdf', async () => {
    const { pdf, outputDir } = setup();
    fs.writeFileSync(path.join(outputDir, 'Theo.pdf'), 'the first one');
    const result = await pdf.exportHtmlToPdf(PAGE, outputDir, 'Theo');
    assert.equal(result.file, path.join(outputDir, 'Theo (2).pdf'));
    assert.equal(fs.readFileSync(path.join(outputDir, 'Theo.pdf'), 'utf-8'), 'the first one');
  });

  test('the name it is given can only name a file in the chosen folder', async () => {
    const { pdf, outputDir } = setup();
    const cases = [
      [`..${path.sep}..${path.sep}evil`, 'evil'],
      ['/etc/passwd', 'etc passwd'],
      ['C:\\Windows\\win.ini', 'C Windows win.ini'],
      ['Mom: cell?', 'Mom cell'],
      ['  ..hidden.  ', 'hidden'],
      ['CON', '_CON'],
      ['\u202eexe.pdf', 'exe.pdf'],
      ['', 'export'],
      [null, 'export'],
      ['...', 'export'],
      ['Zoë 🎂', 'Zoë 🎂'],
    ];
    for (const [given, want] of cases) {
      assert.equal(pdf.safeBaseName(given), want, JSON.stringify(given));
      const result = await pdf.exportHtmlToPdf(PAGE, outputDir, given);
      assert.equal(path.dirname(result.file), outputDir, JSON.stringify(given));
    }
    assert.equal(pdf.safeBaseName('a'.repeat(300)).length, 120);
  });

  test('refuses what it can\'t print, before any window opens', async () => {
    const { env, pdf, temp, outputDir } = setup();
    await assert.rejects(pdf.exportHtmlToPdf(undefined, outputDir, 'x'), { message: 'There was no page to save as a PDF.' });
    await assert.rejects(pdf.exportHtmlToPdf({ toString: () => PAGE }, outputDir, 'x'), { message: 'There was no page to save as a PDF.' });
    for (const dir of [undefined, '', path.join(temp, 'nope'), 42]) {
      await assert.rejects(pdf.exportHtmlToPdf(PAGE, dir, 'x'), { message: 'Choose a folder to save the PDF in.' });
    }
    assert.equal(env.windows.length, 0);
    assert.deepEqual(stagingDirsIn(temp), []);
  });

  test('when printing fails nothing is left behind', async () => {
    const { env, pdf, temp, outputDir } = setup();
    env.hooks.printToPDF = async () => { throw new Error('Printing failed'); };
    await assert.rejects(pdf.exportHtmlToPdf(PAGE, outputDir, 'x'), { message: 'Printing failed' });
    assert.equal(env.windows[0].isDestroyed(), true);
    assert.deepEqual(stagingDirsIn(temp), []);
    assert.deepEqual(fs.readdirSync(outputDir), []);
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

// ── What one PDF can hold (Chromium prints a whole page at once, in one renderer) ──

const TOO_MUCH_PAGE = 'This is too much for one PDF. Narrow it down and try again.';
const TOO_MUCH_ENGINE_PAGE = 'This is too much for one PDF. Save it as a web page instead, which has no limit.';
const TOO_MANY_PICTURES = 'Too many photos for one PDF. Save it as a web page instead, which keeps every photo and video beside it.';
const PRINTING_STOPPED = "Printing this PDF stopped, most likely because it's too much for one PDF. Save it as a web page instead, or save less at a time.";
const PRINTING_STOPPED_RESTART = `${PRINTING_STOPPED} Quit and reopen OpenExtract before saving another PDF.`;
const PDFS_NEED_RESTART = 'Quit and reopen OpenExtract to save PDFs again: printing stopped working after an earlier PDF was too big. Everything else still saves as usual.';

/** printToPDF as Electron does it when the page's renderer dies part way (out of memory). */
async function rendererDiesWhilePrinting(win) {
  win.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 0 });
  throw new Error('Failed to generate PDF: Printing failed');
}

// The photo limit, lowered for a test on its own copy of the module (setup() loads a fresh one)
const SMALL_PICTURE_LIMIT = 64 * 1024;

/** A file of `size` bytes without writing them (sparse where the file system can). */
function fileOfSize(file, size, start = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, start);
  fs.truncateSync(file, size);
  return file;
}

/** An engine answer: one page of `pageBytes` (or a small one) and pictures of these sizes in attachments/. */
function stagePage(params, { name = 'Mom.html', pageBytes, pictures = [] } = {}) {
  const page = path.join(params.output_dir, name);
  if (pageBytes) fileOfSize(page, pageBytes, '<html>');
  else fs.writeFileSync(page, '<html><body><img src="attachments/0.jpg"></body></html>');
  pictures.forEach((size, i) => fileOfSize(path.join(params.output_dir, 'attachments', `${name}-${i}.jpg`), size));
  return page;
}

describe('size limits', () => {
  test('the limits: about 28 million characters a page, 1.5 GB of photos', () => {
    const { pdf } = setup();
    assert.ok(pdf.PDF_LIMITS.pageChars >= 25_000_000 && pdf.PDF_LIMITS.pageChars <= 30_000_000, String(pdf.PDF_LIMITS.pageChars));
    assert.equal(pdf.PDF_LIMITS.pageBytes, pdf.PDF_LIMITS.pageChars);
    assert.equal(pdf.PDF_LIMITS.pictureBytes, 1.5 * 1024 ** 3);
  });

  test('a page the window built that is too big to print is refused before any window opens', async () => {
    const { env, pdf, temp, outputDir } = setup();
    const { pageChars } = pdf.PDF_LIMITS;
    await assert.rejects(pdf.exportHtmlToPdf('x'.repeat(pageChars + 1), outputDir, 'timeline-export'), { message: TOO_MUCH_PAGE });
    assert.equal(env.windows.length, 0);
    assert.deepEqual(stagingDirsIn(temp), []);
    assert.deepEqual(fs.readdirSync(outputDir), []);
    // Right at the limit it prints
    const result = await pdf.exportHtmlToPdf('x'.repeat(pageChars), outputDir, 'timeline-export');
    assert.equal(result.file, path.join(outputDir, 'timeline-export.pdf'));
    assert.deepEqual(stagingDirsIn(temp), []);
  });

  test('an engine page too big to print is refused before any window opens, and nothing is left behind', async () => {
    const { env, pdf, temp, outputDir } = setup();
    const { pageBytes } = pdf.PDF_LIMITS;
    for (const method of ['export_conversation', 'export_whatsapp_chat', 'export_calls', 'export_notes']) {
      const engine = fakeEngine([], { onCall: params => ({ file: stagePage(params, { pageBytes: pageBytes + 1 }), message_count: 1 }) });
      await assert.rejects(pdf.exportMessagesPdf(engine, method, { output_dir: outputDir }), { message: TOO_MUCH_ENGINE_PAGE }, method);
    }
    // One page of several that's too big stops them all, before the first is printed
    const several = fakeEngine([], {
      onCall: params => ({ files: [stagePage(params, { name: 'a.html' }), stagePage(params, { name: 'b.html', pageBytes: pageBytes + 1 })] }),
    });
    await assert.rejects(pdf.exportMessagesPdf(several, 'export_conversations', { output_dir: outputDir }), { message: TOO_MUCH_ENGINE_PAGE });
    assert.equal(env.windows.length, 0);
    assert.deepEqual(stagingDirsIn(temp), []);
    assert.deepEqual(fs.readdirSync(outputDir), []);

    // Right at the limit it prints
    const atLimit = fakeEngine([], { onCall: params => ({ file: stagePage(params, { pageBytes }), message_count: 1 }) });
    const result = await pdf.exportMessagesPdf(atLimit, 'export_conversation', { output_dir: outputDir });
    assert.deepEqual(result.files, [path.join(outputDir, 'Mom.pdf')]);
  });

  test('a page with more photos than one PDF holds is refused before it is printed', async () => {
    const { env, pdf, temp, outputDir } = setup();
    pdf.PDF_LIMITS.pictureBytes = SMALL_PICTURE_LIMIT; // this copy of the module only: small files stand in for 1.5 GB
    const { pictureBytes } = pdf.PDF_LIMITS;
    const half = pictureBytes / 2;
    const over = fakeEngine([], { onCall: params => ({ file: stagePage(params, { pictures: [half, half + 1] }), message_count: 2 }) });
    await assert.rejects(pdf.exportMessagesPdf(over, 'export_conversation', { output_dir: outputDir }), { message: TOO_MANY_PICTURES });
    const whatsapp = fakeEngine([], { onCall: params => ({ files: [stagePage(params, { pictures: [pictureBytes + 1] })], message_count: 2 }) });
    await assert.rejects(pdf.exportMessagesPdf(whatsapp, 'export_whatsapp_chats', { output_dir: outputDir }), { message: TOO_MANY_PICTURES });
    assert.equal(env.windows.length, 0);
    assert.deepEqual(stagingDirsIn(temp), []);
    assert.deepEqual(fs.readdirSync(outputDir), []);

    // Right at the limit (the page itself not counted) it prints
    const atLimit = fakeEngine([], { onCall: params => ({ file: stagePage(params, { pictures: [half, half] }), message_count: 2 }) });
    const result = await pdf.exportMessagesPdf(atLimit, 'export_conversation', { output_dir: outputDir });
    assert.deepEqual(result.files, [path.join(outputDir, 'Mom.pdf')]);
    assert.equal(env.windows.length, 1);
  });

  test('several pages share one attachments folder, so their photos aren\'t added up', async () => {
    const { env, pdf, outputDir } = setup();
    pdf.PDF_LIMITS.pictureBytes = SMALL_PICTURE_LIMIT;
    const { pictureBytes } = pdf.PDF_LIMITS;
    const engine = fakeEngine([], {
      onCall: params => ({
        files: [stagePage(params, { name: 'Riley.html', pictures: [pictureBytes * 0.75] }), stagePage(params, { name: 'Sam.html', pictures: [pictureBytes * 0.75] })],
        message_count: 2,
      }),
    });
    const result = await pdf.exportMessagesPdf(engine, 'export_conversations', { output_dir: outputDir, mode: 'separate' });
    assert.deepEqual(result.files.map(f => path.basename(f)), ['Riley.pdf', 'Sam.pdf']);
    assert.equal(env.windows.length, 2);
  });

  test('when the print renderer dies (out of memory), it says so, and no PDF is tried again until the app is reopened', async () => {
    const { env, pdf, temp, outputDir } = setup();
    env.hooks.printToPDF = rendererDiesWhilePrinting;
    await assert.rejects(pdf.exportMessagesPdf(fakeEngine(), 'export_conversation', { output_dir: outputDir }), { message: PRINTING_STOPPED_RESTART });
    assert.equal(env.windows[0].isDestroyed(), true);
    assert.deepEqual(stagingDirsIn(temp), []);
    assert.deepEqual(fs.readdirSync(outputDir), []);

    // Electron can't print again in this run of the app: refused before the engine is asked or a window opens
    env.hooks.printToPDF = async () => Buffer.from('%PDF-1.4\n');
    const engine = fakeEngine();
    await assert.rejects(pdf.exportMessagesPdf(engine, 'export_conversation', { output_dir: outputDir }), { message: PDFS_NEED_RESTART });
    await assert.rejects(pdf.exportMessagesPdf(engine, 'export_person', { output_dir: outputDir, media_dir: outputDir }), { message: PDFS_NEED_RESTART });
    await assert.rejects(pdf.exportHtmlToPdf('<p>x</p>', outputDir, 'timeline-export'), { message: PDFS_NEED_RESTART });
    assert.equal(engine.calls.length, 0);
    assert.equal(env.windows.length, 1);
    assert.deepEqual(stagingDirsIn(temp), []);
    assert.deepEqual(fs.readdirSync(outputDir), []);
  });

  test('the Timeline\'s page too, and a renderer reported crashed without the event', async () => {
    const { env, pdf, outputDir } = setup();
    env.hooks.printToPDF = rendererDiesWhilePrinting;
    await assert.rejects(pdf.exportHtmlToPdf('<p>x</p>', outputDir, 'timeline-export'), { message: PRINTING_STOPPED_RESTART });
    await assert.rejects(pdf.exportHtmlToPdf('<p>x</p>', outputDir, 'timeline-export'), { message: PDFS_NEED_RESTART });

    const other = setup();
    other.env.hooks.printToPDF = async win => {
      win.webContents.isCrashed = () => true;
      throw new Error('Failed to generate PDF: Printing failed');
    };
    await assert.rejects(other.pdf.exportMessagesPdf(fakeEngine(), 'export_conversation', { output_dir: other.outputDir }), { message: PRINTING_STOPPED_RESTART });
  });

  test('a renderer that dies while the page loads, before printing, says so; later PDFs still print', async () => {
    const { env, pdf, temp, outputDir } = setup();
    env.hooks.printToPDF = async () => assert.fail('never printed');
    env.hooks.loadFile = async win => {
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 });
      throw new Error('ERR_FAILED (-2) loading file');
    };
    await assert.rejects(pdf.exportHtmlToPdf('<p>x</p>', outputDir, 'timeline-export'), { message: PRINTING_STOPPED });
    assert.equal(env.windows[0].isDestroyed(), true);
    assert.deepEqual(stagingDirsIn(temp), []);

    env.hooks.loadFile = async () => {};
    env.hooks.printToPDF = async () => Buffer.from('%PDF-1.4\n');
    const result = await pdf.exportHtmlToPdf('<p>x</p>', outputDir, 'timeline-export');
    assert.equal(result.file, path.join(outputDir, 'timeline-export.pdf'));
  });

  test('a failure that isn\'t the renderer dying is passed on as it is, and the next PDF prints', async () => {
    const { env, pdf, outputDir } = setup();
    env.hooks.printToPDF = async () => { throw new Error('Printing failed'); };
    await assert.rejects(pdf.exportHtmlToPdf('<p>x</p>', outputDir, 'x'), { message: 'Printing failed' });
    env.hooks.printToPDF = async () => Buffer.from('%PDF-1.4\n');
    assert.equal((await pdf.exportHtmlToPdf('<p>x</p>', outputDir, 'x')).file, path.join(outputDir, 'x.pdf'));
  });
});

// ── A person's PDF: the originals are copied straight into the chosen folder ──

const PERSON_BASE = 'Theo Navarro, Jul 5 2024 - Nov 17 2026';

/**
 * A stand-in for export_person's pdf_source save: the page (and its print pictures)
 * in staging, every original copied into "<media_dir>/<base>_attachments", which it
 * reports as media_folder. `report` changes what's reported (and may make it).
 */
function personEngine({ pageBytes, pictures = [], report } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      const page = stagePage(params, { name: `${PERSON_BASE}.html`, pageBytes, pictures });
      const folder = path.join(params.media_dir, `${PERSON_BASE}_attachments`);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, '43-IMG_4127.HEIC'), 'the original photo');
      fs.mkdirSync(path.join(folder, 'nested'));
      fs.writeFileSync(path.join(folder, 'nested', 'deep.txt'), 'x');
      return {
        file: page, message_count: 3, counts: { message: 3, whatsapp: 0, call: 0, voicemail: 0 },
        media: { copied: 1, not_in_backup: 0, failed: 0 }, errors: {},
        media_folder: report ? report(folder, params) : folder,
      };
    },
  };
}

/** Every file and folder under `dir`, relative, sorted; links aren't followed. */
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(entry.isSymbolicLink() ? `${r} -> link` : entry.isDirectory() ? `${r}/` : r);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(d, entry.name), r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** A chosen folder that already holds the user's own things, an earlier save's folder among them. */
function chosenWithThings(outputDir) {
  fs.writeFileSync(path.join(outputDir, 'notes.txt'), 'mine');
  const earlier = path.join(outputDir, 'Theo Navarro, Jan 1 2020 - Feb 2 2021_attachments');
  fs.mkdirSync(earlier);
  fs.writeFileSync(path.join(earlier, '7-IMG_0001.jpeg'), 'an earlier save');
  return tree(outputDir);
}

const personParams = outputDir => ({ udid: 'u', output_dir: outputDir, media_dir: outputDir, display_name: 'Theo Navarro', chat_ids: [17] });

describe('a person\'s PDF that can\'t be made', () => {
  test('saved: the PDF and the folder of originals stay', async () => {
    const { pdf, temp, outputDir } = setup();
    const before = chosenWithThings(outputDir);
    const result = await pdf.exportMessagesPdf(personEngine(), 'export_person', personParams(outputDir));
    assert.deepEqual(result.files, [path.join(outputDir, `${PERSON_BASE}.pdf`)]);
    assert.equal(result.media_folder, path.join(outputDir, `${PERSON_BASE}_attachments`));
    assert.deepEqual(tree(outputDir), [...before,
      `${PERSON_BASE}.pdf`, `${PERSON_BASE}_attachments/`, `${PERSON_BASE}_attachments/43-IMG_4127.HEIC`,
      `${PERSON_BASE}_attachments/nested/`, `${PERSON_BASE}_attachments/nested/deep.txt`].sort());
    assert.deepEqual(stagingDirsIn(temp), []);
  });

  test('printing fails: the folder of originals it copied is taken away again, and nothing else', async () => {
    const { env, pdf, temp, outputDir } = setup();
    const before = chosenWithThings(outputDir);
    env.hooks.printToPDF = async () => { throw new Error('Printing failed'); };
    await assert.rejects(pdf.exportMessagesPdf(personEngine(), 'export_person', personParams(outputDir)), { message: 'Printing failed' });
    assert.deepEqual(tree(outputDir), before);
    assert.deepEqual(stagingDirsIn(temp), []);
    // So trying again can use the same name, not "(2)" (the engine's stand-in would fail if the folder were there)
    env.hooks.printToPDF = async () => Buffer.from('%PDF-1.4\n');
    const again = await pdf.exportMessagesPdf(personEngine(), 'export_person', personParams(outputDir));
    assert.equal(again.media_folder, path.join(outputDir, `${PERSON_BASE}_attachments`));
  });

  test('the print renderer dies: the same, with the plain message; trying again copies nothing', async () => {
    const { env, pdf, outputDir } = setup();
    const before = chosenWithThings(outputDir);
    env.hooks.printToPDF = rendererDiesWhilePrinting;
    await assert.rejects(pdf.exportMessagesPdf(personEngine(), 'export_person', personParams(outputDir)), { message: PRINTING_STOPPED_RESTART });
    assert.deepEqual(tree(outputDir), before);
    const again = personEngine();
    await assert.rejects(pdf.exportMessagesPdf(again, 'export_person', personParams(outputDir)), { message: PDFS_NEED_RESTART });
    assert.equal(again.calls.length, 0);
    assert.deepEqual(tree(outputDir), before);
  });

  test('too many photos, or a page too big: refused before printing, the folder of originals taken away', async () => {
    const { env, pdf, temp, outputDir } = setup();
    const before = chosenWithThings(outputDir);
    pdf.PDF_LIMITS.pictureBytes = SMALL_PICTURE_LIMIT;
    const { pictureBytes, pageBytes } = pdf.PDF_LIMITS;
    const tooManyPhotos = personEngine({ pictures: [pictureBytes / 2, pictureBytes / 2 + 1] });
    await assert.rejects(pdf.exportMessagesPdf(tooManyPhotos, 'export_person', personParams(outputDir)), { message: TOO_MANY_PICTURES });
    assert.deepEqual(tree(outputDir), before);
    const tooBig = personEngine({ pageBytes: pageBytes + 1 });
    await assert.rejects(pdf.exportMessagesPdf(tooBig, 'export_person', personParams(outputDir)), { message: TOO_MUCH_ENGINE_PAGE });
    assert.deepEqual(tree(outputDir), before);
    assert.equal(env.windows.length, 0);
    assert.deepEqual(stagingDirsIn(temp), []);
  });

  test('an engine answer that can\'t be printed for any other reason takes the folder away too', async () => {
    const { env, pdf, outputDir } = setup();
    const before = chosenWithThings(outputDir);
    const elsewhere = path.join(freshDir('pdf-elsewhere'), 'secret.html');
    fs.writeFileSync(elsewhere, '<html></html>');
    const engine = personEngine();
    const call = engine.call;
    engine.call = async (method, params) => ({ ...(await call(method, params)), file: elsewhere });
    await assert.rejects(pdf.exportMessagesPdf(engine, 'export_person', personParams(outputDir)), { message: 'Unexpected export file location' });
    assert.deepEqual(tree(outputDir), before);
    assert.equal(env.windows.length, 0);
  });

  test('only that new folder, directly in the chosen folder, is ever removed', async t => {
    const { env, pdf, outputDir } = setup();
    env.hooks.printToPDF = async () => { throw new Error('Printing failed'); };
    const outside = freshDir('pdf-outside');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'not in the chosen folder');
    const sibling = `${outputDir}-sibling_attachments`;
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'beside the chosen folder');
    fs.mkdirSync(path.join(outputDir, 'Keep_attachments'));
    fs.writeFileSync(path.join(outputDir, 'Keep_attachments', 'keep.txt'), 'there before the export');
    fs.mkdirSync(path.join(outputDir, 'Zoë_attachments')); // the accent as one character (NFC)
    fs.writeFileSync(path.join(outputDir, 'Zoë_attachments', 'keep.txt'), 'there before the export');
    let canLink = true;

    const reports = {
      'a folder somewhere else': () => outside,
      'a folder beside the chosen folder, by ..': () => path.join(outputDir, '..', path.basename(sibling)),
      'a sibling whose name starts like the chosen folder': () => sibling,
      'the chosen folder itself': (_folder, params) => params.media_dir,
      'its parent': (_folder, params) => path.dirname(params.media_dir),
      'a folder inside a new folder': (_folder, params) => {
        const deeper = path.join(params.media_dir, 'new-sub', 'Theo_attachments');
        fs.mkdirSync(deeper, { recursive: true });
        fs.writeFileSync(path.join(deeper, 'keep.txt'), 'two levels down');
        return deeper;
      },
      'a folder that was there before': (_folder, params) => path.join(params.media_dir, 'Keep_attachments'),
      'one that was there before, in other case': (_folder, params) => path.join(params.media_dir, 'KEEP_ATTACHMENTS'),
      'one that was there before, its accent spelled another way': (_folder, params) => path.join(params.media_dir, 'Zoë_attachments'),
      'a relative path': () => 'Keep_attachments',
      'a file, not a folder': (_folder, params) => {
        const file = path.join(params.media_dir, 'new-file.txt');
        fs.writeFileSync(file, 'new, but a file');
        return file;
      },
      'a new link to a folder somewhere else': (_folder, params) => {
        const link = path.join(params.media_dir, 'Linked_attachments');
        try {
          fs.symlinkSync(outside, link, 'junction'); // a junction needs no admin rights on Windows
        } catch {
          canLink = false;
        }
        return link;
      },
      'not text': () => 42,
      'nothing': () => '',
    };
    for (const [what, report] of Object.entries(reports)) {
      await assert.rejects(pdf.exportMessagesPdf(personEngine({ report }), 'export_person', personParams(outputDir)), { message: 'Printing failed' }, what);
      // The folder the engine really made is the test's to clear; everything else must still be there
      fs.rmSync(path.join(outputDir, `${PERSON_BASE}_attachments`), { recursive: true, force: true });
      assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf-8'), 'not in the chosen folder', what);
      assert.equal(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf-8'), 'beside the chosen folder', what);
      assert.ok(fs.existsSync(path.join(outputDir, 'Keep_attachments', 'keep.txt')), what);
      assert.ok(fs.existsSync(path.join(outputDir, 'Zoë_attachments', 'keep.txt')), what);
    }
    assert.ok(fs.existsSync(path.join(outputDir, 'new-sub', 'Theo_attachments', 'keep.txt')));
    assert.ok(fs.existsSync(path.join(outputDir, 'new-file.txt')));
    if (canLink) assert.ok(fs.lstatSync(path.join(outputDir, 'Linked_attachments')).isSymbolicLink());
    else t.diagnostic('this account can\'t create links; that case was not checked');
  });

  test('other exports never remove a folder, and an engine that stops part way has nothing removed', async () => {
    const { env, pdf, outputDir } = setup();
    env.hooks.printToPDF = async () => { throw new Error('Printing failed'); };
    // A conversation's answer naming a new folder in the chosen folder: not export_person's, kept
    await assert.rejects(pdf.exportMessagesPdf(personEngine(), 'export_conversation', personParams(outputDir)), { message: 'Printing failed' });
    assert.ok(fs.existsSync(path.join(outputDir, `${PERSON_BASE}_attachments`, '43-IMG_4127.HEIC')));
    fs.rmSync(path.join(outputDir, `${PERSON_BASE}_attachments`), { recursive: true });

    // The engine stopped part way (a timeout): nothing was reported, so nothing is touched
    const partial = {
      async call(_method, params) {
        fs.mkdirSync(path.join(params.media_dir, `${PERSON_BASE}_attachments`));
        throw new Error('Sidecar call timed out: export_person');
      },
    };
    await assert.rejects(pdf.exportMessagesPdf(partial, 'export_person', personParams(outputDir)), /timed out/);
    assert.deepEqual(tree(outputDir), [`${PERSON_BASE}_attachments/`]);
  });
});
