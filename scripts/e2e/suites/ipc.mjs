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
  'call', 'exportPdf', 'exportHtmlPdf', 'selectFolder', 'saveFolder', 'saveFile', 'writeFile', 'writeNewFile', 'openExternal', 'relaunch',
  'openPath', 'showInFolder', 'textSize.get', 'textSize.set', 'onNotification', 'getVersion',
  'updates.getState', 'updates.setAutoCheck', 'updates.askLater', 'updates.check', 'updates.download', 'updates.install', 'updates.onStatus',
  'getAppState', 'setFirstLaunchCompleted', 'addSession', 'removeSession', 'getRecentSessions', 'incrementExportCount',
  'onSharePrompt', 'support.status', 'support.snooze', 'support.markPaid',
  'onBusinessCard', 'support.answerBusiness',
  'feedback.getDiagnostics', 'feedback.send', 'feedback.savedEmail', 'feedback.fixedReports',
  'feedback.markAnnounced', 'feedback.onFixed', 'feedback.optOutOfExportCheck',
  'feedback.onExportCheck', 'copyText',
  // Media in the window (MediaAttachment.tsx, electron/localMedia.ts)
  'mediaThumbnail',
  // Older backups to the Trash (electron/olderBackups.ts)
  'trashOlderBackup',
  // Ask AI (electron/askAi.ts): off in every build these suites run
  'askAi.state', 'askAi.status', 'askAi.install', 'askAi.connectClaude', 'askAi.connectChatGpt',
  'askAi.setHidden', 'askAi.noteSeen', 'askAi.onProgress',
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
      shell.trashItem = async p => { globalThis.__opened.push(['trash', p]); };
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
      const written = await app.api('writeNewFile', scratch, 'new file', 'txt', 'first');
      const numbered = await app.api('writeNewFile', scratch, 'new file', 'txt', 'second');
      check('writeNewFile numbers the second instead of replacing the first', written.value === path.join(scratch, 'new file.txt')
        && numbered.value === path.join(scratch, 'new file (2).txt') && fs.readFileSync(written.value, 'utf-8') === 'first', { written, numbered });
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

      // Exports counter, the "Pay it forward" ask (introduction first) and the export check (once per run).
      await app.eval(() => {
        window.__share = [];
        window.__check = [];
        window.openextract.onSharePrompt((area, intro) => window.__share.push([area, intro]));
        window.openextract.feedback.onExportCheck((area, offerAsk) => window.__check.push([area, offerAsk]));
      });
      const n1 = (await app.api('incrementExportCount', 'messages')).value;
      const n2 = (await app.api('incrementExportCount', 'photos')).value;
      await app.api('incrementExportCount', 'notes');
      await sleep(300);
      const prompts = await app.eval(() => ({ share: window.__share, check: window.__check }));
      check('incrementExportCount counts; introduction, then the export check, then the short ask',
        n2 === n1 + 1 && prompts.share.length === 2 && prompts.check.length === 1, { n1, n2, prompts });
      check('the ask and the export check get the export\'s area; a fresh profile is asked',
        prompts.share[0]?.[0] === 'messages' && prompts.share[0]?.[1] === true && prompts.check[0]?.[0] === 'photos'
        && prompts.check[0]?.[1] === true && prompts.share[1]?.[0] === 'notes' && prompts.share[1]?.[1] === false, prompts);
      const before = (await app.api('support.status')).value;
      await app.api('support.snooze');
      await app.api('incrementExportCount', 'calls');
      await app.api('support.markPaid');
      const after = (await app.api('support.status')).value;
      await sleep(300);
      const quiet = await app.eval(() => window.__share.length);
      check('support.snooze quiets the ask; support.markPaid is remembered', before?.paid === false && after?.paid === true && quiet === 2,
        { before, after, quiet });
      await app.api('feedback.optOutOfExportCheck');

      // "Using it for paid work?" needs saves from 6 different iPhones (scripts/main-ipc.test.mjs
      // covers that); here: the listener registers, and an answer goes through.
      const unsubscribed = await app.eval(() => typeof window.openextract.onBusinessCard(() => {}) === 'function');
      const answered = await app.api('support.answerBusiness', 'personal');
      check('onBusinessCard registers; support.answerBusiness goes through', unsubscribed === true && !answered.__missing && !answered.__error, { unsubscribed, answered });

      // Ask AI: only in builds made with OPENEXTRACT_AI_INDEX_URL, and this isn't one (the harness
      // leaves the variable out). Every call answers that it's off; nothing is downloaded or opened.
      const aiState = await app.api('askAi.state');
      check('askAi.state: off in this build', JSON.stringify(aiState.value) === JSON.stringify({ enabled: false }), aiState);
      const aiCalls = [];
      for (const [fn, ...args] of [['askAi.status'], ['askAi.install'], ['askAi.connectClaude'], ['askAi.connectChatGpt', true]]) {
        aiCalls.push([fn, (await app.api(fn, ...args)).value]);
      }
      check("askAi: every action answers that it's off", aiCalls.every(([, v]) => v?.ok === false && /isn't part of this copy/.test(v.error ?? '')), aiCalls);
      await app.api('askAi.setHidden', true);
      await app.api('askAi.noteSeen');
      const aiListens = await app.eval(() => typeof window.openextract.askAi.onProgress(() => {}) === 'function');
      check('askAi.setHidden / noteSeen go through, onProgress registers, nothing is opened', aiListens && (await opened()).length === 0, aiListens);
      check('no Ask AI on the screen', !(await app.text()).includes('Ask AI'));

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
      await app.api('updates.askLater');
      const later = (await app.api('updates.getState')).value;
      check('updates.askLater puts the question off without saving a no', later.askLater === true && later.autoCheck === null, later);
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
      // Notes, calls and the other record lists print through the same bridge
      const notesDir = path.join(scratch, 'bridge-notes-pdf');
      fs.mkdirSync(notesDir, { recursive: true });
      const notesPdf = await app.api('exportPdf', 'export_notes', { udid: path.basename(b.dir), mode: 'merged', output_dir: notesDir });
      check('exportPdf prints every note into one PDF', notesPdf.value?.success && fs.existsSync(path.join(notesDir, 'Notes.pdf')) && notesPdf.value?.data?.count > 0,
        notesPdf.value?.error ?? fs.readdirSync(notesDir));
      // exportHtmlPdf: a page the window built (the Timeline's), printed the same way; never overwrites
      const pageDir = path.join(scratch, 'bridge-page-pdf');
      fs.mkdirSync(pageDir, { recursive: true });
      const html = '<!DOCTYPE html><html><body><h1>Timeline</h1><p>Zoë 🎉</p><img src="https://example.com/x.png"></body></html>';
      const page1 = await app.api('exportHtmlPdf', html, pageDir, 'timeline-export');
      const page2 = await app.api('exportHtmlPdf', html, pageDir, `..${path.sep}timeline-export`);
      check('exportHtmlPdf writes a PDF, and a second one beside it', page1.value?.success && page2.value?.success
        && fs.readdirSync(pageDir).sort().join() === 'timeline-export (2).pdf,timeline-export.pdf'
        && fs.readFileSync(path.join(pageDir, 'timeline-export.pdf')).subarray(0, 5).toString() === '%PDF-',
      page1.value?.error ?? page2.value?.error ?? fs.readdirSync(pageDir));
      const refused = await app.api('exportHtmlPdf', html, path.join(pageDir, 'not-there'), 'x');
      check('exportHtmlPdf refuses a folder that doesn\'t exist', refused.value?.success === false && /Choose a folder/.test(refused.value?.error ?? ''), refused.value);

      // ── Media in the window: a poster from a copy the engine made, and nothing from anywhere else ──
      // A photo copied out by get_photo_path lands in the engine's copy folder (python/app_copies.py),
      // as a video copied for a poster does.
      const photos = (await app.api('call', 'list_photos', { udid: path.basename(b.dir), offset: 0, limit: 1 })).value?.data;
      const photo = photos?.photos?.[0];
      const copied = photo && (await app.api('call', 'get_photo_path', { udid: path.basename(b.dir), file_hash: photo.file_hash })).value?.data;
      const drawn = copied?.path ? (await app.api('mediaThumbnail', copied.path, 64)).value : undefined;
      const previewer = process.platform === 'darwin' || process.platform === 'win32';
      check('mediaThumbnail draws a copy the engine made (nothing on Linux, which has no previewer)',
        previewer ? /^data:image\/jpeg;base64,/.test(drawn ?? '') : drawn === null, { path: copied?.path, drawn: drawn?.slice?.(0, 40) ?? drawn });
      const elsewhere = path.join(scratch, 'clip.mp4');
      fs.copyFileSync(file, elsewhere);
      check('mediaThumbnail draws nothing outside the engine\'s copy folders', (await app.api('mediaThumbnail', elsewhere, 64)).value === null);
      const served = await app.app.evaluate(async ({ net }, url) => (await net.fetch(url, { headers: { Range: 'bytes=0-9' } })).status,
        'local-media://media/' + elsewhere.split(path.sep).filter(Boolean).map(encodeURIComponent).join('/'));
      check('local-media:// serves nothing outside the engine\'s copy folders', served === 404, served);

      // Asking for a folder the engine doesn't offer: refused before any dialog, and nothing moves.
      const trashed = await app.api('trashOlderBackup', path.basename(b.dir), b.dir);
      check("trashOlderBackup moves nothing the engine doesn't offer",
        trashed.value?.status === 'refused' && !(await opened()).some(c => c[0] === 'trash') && fs.existsSync(b.dir), trashed);

      // relaunch and updates.check/download/install restart or reach the network, so they are
      // only checked for existence above. The updater's logic is unit tested in scripts/updater.test.mjs.
      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
    } finally {
      await app.close();
    }
  },
};
