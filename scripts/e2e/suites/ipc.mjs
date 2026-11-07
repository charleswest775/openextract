// The bridge between the window and the rest of the app (electron/preload.ts): every function
// it exposes, called from the window as the app would, with native dialogs answered by the test.
// The unit tests (scripts/main-ipc.test.mjs) check the handlers with Electron stubbed; this
// checks the real wiring in a running app, including the engine behind `call`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check, launch, sleep } from '../harness.mjs';

// Every function on window.openextract, by its path. scripts/e2e-coverage.test.mjs fails if
// preload.ts exposes something not listed here.
export const BRIDGE = [
  'call', 'exportPdf', 'selectFolder', 'saveFolder', 'saveFile', 'writeFile', 'openExternal', 'relaunch',
  'openPath', 'showInFolder', 'textSize.get', 'textSize.set', 'onNotification', 'getVersion',
  'updates.getState', 'updates.setAutoCheck', 'updates.check', 'updates.download', 'updates.install', 'updates.onStatus',
  'getAppState', 'setFirstLaunchCompleted', 'addSession', 'removeSession', 'getRecentSessions', 'incrementExportCount',
  'onSharePrompt', 'feedback.getDiagnostics', 'feedback.send', 'feedback.savedEmail', 'feedback.fixedReports',
  'feedback.markAnnounced', 'feedback.onFixed', 'feedback.optOutOfExportCheck', 'feedback.thanksOffered',
  'feedback.onExportCheck', 'copyText',
];

export default {
  name: 'ipc',
  about: 'every function the window can call, through the real preload bridge',
  needs: ['maren-plain'],
  async run({ target, backups, scratch }) {
    const b = backups['maren-plain'];
    const app = await launch(target);
    // Record what the shell would have opened instead of opening it.
    await app.app.evaluate(({ shell }) => {
      globalThis.__opened = [];
      shell.openExternal = async url => { globalThis.__opened.push(['external', url]); };
      shell.openPath = async p => { globalThis.__opened.push(['path', p]); return ''; };
      shell.showItemInFolder = p => { globalThis.__opened.push(['folder', p]); };
    });
    const opened = () => app.app.evaluate(() => globalThis.__opened.splice(0));
    try {
      const exposed = await app.eval(() => {
        const out = [];
        const walk = (o, pre) => { for (const [k, v] of Object.entries(o)) { if (typeof v === 'function') out.push(pre + k); else if (v && typeof v === 'object') walk(v, pre + k + '.'); } };
        walk(window.openextract, '');
        return out.sort();
      });
      check('the bridge exposes exactly the functions this suite covers', JSON.stringify(exposed) === JSON.stringify([...BRIDGE].sort()), { exposed, covered: BRIDGE });
      check('window.openextract.platform is this OS', (await app.eval(() => window.openextract.platform)) === process.platform);
      check('no Node in the window', await app.eval(() => typeof require === 'undefined' && typeof process === 'undefined'));

      const v = await app.api('getVersion');
      check('getVersion', /^\d+\.\d+\.\d+/.test(v.value ?? ''), v);

      // Engine calls.
      const ping = await app.api('call', 'ping', {});
      check('call: ping reaches the engine', ping.value?.success && ping.value.data?.status === 'ok', ping);
      const bad = await app.api('call', 'no_such_method', {});
      check('call: an unknown method comes back as {success:false, error}', bad.value?.success === false && /Unknown method/.test(bad.value.error), bad);
      const notes = [];
      await app.eval(() => { window.__notes = []; window.openextract.onNotification(n => window.__notes.push(n)); });
      const list = await app.api('call', 'list_backups', { path: path.dirname(b.dir) });
      check('call: list_backups finds the backup', list.value?.success && JSON.stringify(list.value.data).includes(path.basename(b.dir)), list.value?.success);

      // Dialogs: answered by the test, cancelled, and their results passed through.
      await app.stubDialogs(scratch);
      check('selectFolder returns the chosen folder', (await app.api('selectFolder')).value === scratch);
      check('saveFolder returns the chosen folder', (await app.api('saveFolder')).value === scratch);
      const sf = await app.api('saveFile', { title: 'x', defaultPath: 'report.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
      check('saveFile returns the chosen path', sf.value === path.join(scratch, 'report.csv'), sf);
      await app.cancelDialogs();
      check('selectFolder returns null when cancelled', (await app.api('selectFolder')).value === null);
      check('saveFile returns null when cancelled', (await app.api('saveFile', {})).value === null);

      // Files.
      const file = path.join(scratch, 'ünïcode – 日本.txt');
      await app.api('writeFile', file, 'héllo\n🌲');
      check('writeFile writes UTF-8, unicode file names included', fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === 'héllo\n🌲');
      await app.api('openPath', file);
      await app.api('showInFolder', file);
      const shellCalls = await opened();
      check('openPath and showInFolder reach the shell', shellCalls.some(c => c[0] === 'path') && shellCalls.some(c => c[0] === 'folder'), shellCalls);

      // Links: web and mail links open; anything else from backup content is refused.
      for (const url of ['https://www.openextract.app/', 'mailto:someone@example.com']) await app.api('openExternal', url);
      for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'smb://evil/share', 'not a url', 'x-apple.systempreferences:com.apple.other']) await app.api('openExternal', url);
      const links = (await opened()).map(c => c[1]);
      check('openExternal opens web and mail links only', JSON.stringify(links) === JSON.stringify(['https://www.openextract.app/', 'mailto:someone@example.com']), links);

      // Text size.
      await app.api('textSize.set', 'larger');
      check('textSize.set / get', (await app.api('textSize.get')).value === 'larger');
      await app.api('textSize.set', 'enormous');
      check('textSize.set ignores sizes that don\'t exist', (await app.api('textSize.get')).value === 'larger');
      await app.api('textSize.set', 'default');

      // App state and recent backups.
      const s0 = await app.api('getAppState');
      check('getAppState on a fresh profile is first_visit', s0.value?.state === 'first_visit', s0);
      await app.api('setFirstLaunchCompleted');
      check('after the first launch it is returned_no_data', (await app.api('getAppState')).value?.state === 'returned_no_data');
      const session = { id: 'e2e-1', name: 'E2E iPhone', backupDir: b.dir, lastOpened: new Date().toISOString(), type: 'device', sizeGB: 1.5 };
      await app.api('addSession', session);
      await app.api('addSession', { ...session, id: 'e2e-2', lastOpened: new Date(Date.now() + 1000).toISOString() });
      await app.api('addSession', { id: 'e2e-1', name: 'Renamed' });
      const s1 = (await app.api('getAppState')).value;
      const renamed = s1.sessions.find(s => s.id === 'e2e-1');
      check('addSession merges by id; getAppState sorts newest first', s1.state === 'has_data' && s1.sessions.length === 2 && s1.sessions[0].id === 'e2e-2'
        && renamed?.name === 'Renamed' && renamed.backupDir === b.dir, s1.sessions);
      await app.api('removeSession', 'e2e-2');
      check('removeSession / getRecentSessions', (await app.api('getRecentSessions')).value.map(s => s.id).join() === 'e2e-1');
      await app.api('removeSession', 'e2e-1');

      // Exports counter, share prompt (once) and the export check (once per run).
      await app.eval(() => {
        window.__share = [];
        window.__check = [];
        window.openextract.onSharePrompt((area) => window.__share.push(area));
        window.openextract.feedback.onExportCheck((area, offerThanks) => window.__check.push([area, offerThanks]));
      });
      const n1 = (await app.api('incrementExportCount', 'messages')).value;
      const n2 = (await app.api('incrementExportCount', 'photos')).value;
      await app.api('incrementExportCount', 'notes');
      await sleep(300);
      const prompts = await app.eval(() => ({ share: window.__share, check: window.__check }));
      check('incrementExportCount counts; share prompt once, export check once', n2 === n1 + 1 && prompts.share.length === 1 && prompts.check.length === 1, { n1, n2, prompts });
      check('the share prompt and export check get the export\'s area; a fresh profile may be asked for thanks',
        prompts.share[0] === 'messages' && prompts.check[0]?.[0] === 'photos' && prompts.check[0]?.[1] === true, prompts);
      await app.api('feedback.thanksOffered');
      await app.api('feedback.optOutOfExportCheck');

      // Feedback: diagnostics and the saved email are local; sending is not exercised here
      // (it would reach openextract.app), see scripts/feedback.test.mjs.
      const d = await app.api('feedback.getDiagnostics', `Failed at ${b.dir}`);
      check('feedback.getDiagnostics scrubs the backup folder out of a reported error', !JSON.stringify(d.value).includes(b.dir), d.value);
      check('feedback.savedEmail', typeof (await app.api('feedback.savedEmail')).value === 'string');
      check('feedback.fixedReports', Array.isArray((await app.api('feedback.fixedReports')).value));
      await app.api('feedback.markAnnounced', 'none');

      // Updates: state only; a fresh profile never checks by itself.
      const u = (await app.api('updates.getState')).value;
      check('updates.getState: no automatic check on a fresh profile', u && u.autoCheck !== true, u);
      await app.api('updates.setAutoCheck', false);
      check('updates.setAutoCheck(false) is remembered', (await app.api('updates.getState')).value.autoCheck === false);
      const listeners = await app.eval(() => { window.openextract.updates.onStatus(() => {}); window.openextract.feedback.onFixed(() => {}); return true; });
      check('event subscriptions (onStatus, onFixed) attach', listeners);

      // Clipboard.
      await app.api('copyText', 'copied by e2e ✓');
      const clip = await app.app.evaluate(({ clipboard }) => clipboard.readText());
      check('copyText puts text on the clipboard', clip === 'copied by e2e ✓', clip);

      // exportPdf through the bridge (the UI path is in the exports suite).
      const open = await app.api('call', 'open_backup', { udid: path.basename(b.dir), backup_dir: b.dir });
      check('call: open_backup', open.value?.success, open.value?.error);
      const convos = (await app.api('call', 'list_conversations', { udid: path.basename(b.dir) })).value?.data;
      const first = Array.isArray(convos) ? convos[0] : convos?.conversations?.[0];
      const pdfDir = path.join(scratch, 'bridge-pdf');
      fs.mkdirSync(pdfDir, { recursive: true });
      const pdf = await app.api('exportPdf', 'export_conversation', { udid: path.basename(b.dir), chat_id: first?.chat_id ?? first?.id, output_dir: pdfDir, display_name: first?.display_name });
      check('exportPdf writes a PDF', pdf.value?.success && fs.readdirSync(pdfDir).some(f => f.endsWith('.pdf')), pdf.value?.error ?? fs.readdirSync(pdfDir));

      // relaunch and updates.check/download/install restart or reach the network, so they are
      // only checked for existence above. The updater's logic is unit tested in scripts/updater.test.mjs.
      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
    } finally {
      await app.close();
    }
  },
};
