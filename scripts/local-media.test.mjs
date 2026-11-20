// Tests for electron/localMedia.ts: which files the window may play or make a poster of
// (only the engine's copies, python/app_copies.py, compared as real paths), the
// local-media:// protocol's answers (Range requests, so a video can seek), and
// media:thumbnail's poster frames. main-ipc.test.mjs checks main.ts wires them up;
// scripts/e2e/suites/ipc.mjs runs them in the real app. A run in real Electron 30 (H.264
// .mp4 and HEVC .mov played, sought and given posters) is described in localMedia.ts.
// Run with: node --test scripts/local-media.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDir, loadElectronModule } from './test-helpers/electron-env.mjs';
import { loadTs } from './test-helpers/load-ts.mjs';

const { module: media } = loadElectronModule('localMedia');
const { appCopyPath, localMediaFilePath, parseRange, serveFile, handleLocalMedia, mediaThumbnail } = media;
const { localMediaUrl } = loadTs('src/lib/openFile.ts');

const quiet = (() => {
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => { if (String(args[0]).startsWith('[local-media]')) lines.push(args.join(' ')); else warn(...args); };
  process.on('exit', () => { console.warn = warn; });
  return lines;
})();

/**
 * A temp folder as the engine leaves it: copy folders for Messages and Photos, an
 * encrypted backup's decrypted files, and things that only look like those.
 */
function tempFolder() {
  const temp = freshDir('temp');
  const make = (rel, content = '0123456789') => {
    const file = path.join(temp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const outside = path.join(freshDir('home'), 'Secret.mov');
  fs.writeFileSync(outside, 'not for the window');
  const t = {
    temp,
    outside,
    messages: make('openextract-messages-4242-ab12cd/udid-1/7/IMG_0007.MOV'),
    photos: make('openextract-photos-77-x9/udid-1/46ad145c3bed7be5/IMG_0042.mov'),
    decrypted: make('iosbackup_k2j3/3f786850e387550fdab836ed7e6dc881de23001b.mp4'),
    notCopy: make('openextract-pdf-abc123/page.mp4'),
    noPid: make('openextract-messages-ab12cd/IMG_1.mov'),
    looseFile: make('IMG_0008.mov'),
    textFile: make('openextract-messages-4242-ab12cd/udid-1/8/notes.txt'),
  };
  t.folder = path.join(temp, 'openextract-messages-4242-ab12cd');
  // A link inside a copy folder that points outside it, and a copy folder that is itself a link
  t.link = path.join(temp, 'openextract-messages-4242-ab12cd', 'udid-1', 'link.mov');
  fs.symlinkSync(outside, t.link);
  t.linkedFolder = path.join(temp, 'openextract-whatsapp-4242-zz');
  fs.symlinkSync(path.dirname(outside), t.linkedFolder, 'dir');
  return t;
}

let symlinksWork = true;
try {
  const probe = freshDir('probe');
  fs.symlinkSync(probe, path.join(probe, 'self'), 'dir');
} catch {
  symlinksWork = false; // Windows without Developer Mode can't make links
}

describe('appCopyPath: only the engine\'s copies', () => {
  test('files in a copy folder (any part of the app) or an encrypted backup\'s decrypted folder', { skip: !symlinksWork && 'needs symlinks' }, () => {
    const t = tempFolder();
    for (const file of [t.messages, t.photos, t.decrypted]) {
      assert.equal(appCopyPath(file, [t.temp]), fs.realpathSync.native(file), file);
    }
    // Any of the temp folders given will do
    assert.equal(appCopyPath(t.messages, [freshDir('other'), t.temp]), fs.realpathSync.native(t.messages));
  });

  test('nothing else: outside, look-alike folders, the folder itself, links out, relative or odd paths', { skip: !symlinksWork && 'needs symlinks' }, () => {
    const t = tempFolder();
    for (const file of [t.outside, t.notCopy, t.noPid, t.looseFile, t.folder, path.join(t.folder, 'udid-1'), t.link,
      path.join(t.linkedFolder, 'Secret.mov'), path.join(t.folder, 'gone.mov'),
      path.join(t.folder, 'udid-1', '7', '..', '..', '..', '..', path.basename(path.dirname(t.outside)), 'Secret.mov')]) {
      assert.equal(appCopyPath(file, [t.temp]), null, file);
    }
    for (const bad of ['', null, undefined, 42, {}, ['x'], 'IMG_0007.MOV', path.relative(process.cwd(), t.messages), `${t.messages}\0.png`]) {
      assert.equal(appCopyPath(bad, [t.temp]), null, String(bad));
    }
    assert.equal(appCopyPath(t.messages, []), null, 'no temp folder, nothing allowed');
    assert.equal(appCopyPath(t.messages, [path.join(t.temp, 'missing')]), null);
  });

  test('a temp folder reached through a link (macOS /var is /private/var) still matches, either way round', { skip: !symlinksWork && 'needs symlinks' }, () => {
    const t = tempFolder();
    const alias = path.join(freshDir('var'), 'T');
    fs.symlinkSync(t.temp, alias, 'dir');
    const viaAlias = path.join(alias, path.relative(t.temp, t.messages));
    assert.equal(appCopyPath(viaAlias, [t.temp]), fs.realpathSync.native(t.messages), 'the engine names the file by the link');
    assert.equal(appCopyPath(t.messages, [alias]), fs.realpathSync.native(t.messages), 'the app names the temp folder by the link');
  });
});

describe('local-media:// addresses', () => {
  test('the window\'s address for a copy names exactly that file again', () => {
    for (const file of ['/private/var/folders/T/openextract-messages-1-a/u/7/Clip #1 – ünï 100%?.mov', '/tmp/a b/c\\d.mov']) {
      const url = localMediaUrl(file);
      assert.match(url, /^local-media:\/\/media\//);
      assert.equal(localMediaFilePath(url, 'darwin'), file);
    }
    assert.equal(localMediaUrl('/tmp/a b/x#1.mov'), 'local-media://media/tmp/a%20b/x%231.mov');
  });

  test('Windows paths: drive letters and either slash', () => {
    const url = localMediaUrl('C:\\Users\\Ana\\AppData\\Local\\Temp\\openextract-whatsapp-9-q\\u\\3\\VID 1.mp4');
    assert.equal(url, 'local-media://media/C%3A/Users/Ana/AppData/Local/Temp/openextract-whatsapp-9-q/u/3/VID%201.mp4');
    assert.equal(localMediaFilePath(url, 'win32'), 'C:/Users/Ana/AppData/Local/Temp/openextract-whatsapp-9-q/u/3/VID 1.mp4');
    assert.equal(localMediaFilePath('local-media://media/C:/x/y.mp4', 'win32'), 'C:/x/y.mp4');
  });

  test('anything that isn\'t a local-media://media/ address names no file', () => {
    for (const bad of ['local-media://other/tmp/x.mov', 'file:///tmp/x.mov', 'https://media/tmp/x.mov', 'not a url', 'local-media://media/tmp/%E0%A4%A.mov']) {
      assert.equal(localMediaFilePath(bad, 'darwin'), null, bad);
    }
  });
});

describe('Range requests', () => {
  test('parseRange reads the byte ranges a <video> asks for', () => {
    assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
    assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 }, 'an end past the file stops at its end');
    assert.deepEqual(parseRange('bytes=-30', 100), { start: 70, end: 99 }, 'the last 30 bytes');
    assert.deepEqual(parseRange('bytes=-300', 100), { start: 0, end: 99 });
    assert.deepEqual(parseRange(' Bytes = 5 - 6 ', 100), { start: 5, end: 6 });
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
    for (const ignored of [null, undefined, '', 'bytes=', 'bytes=-', 'bytes=20-10', 'bytes=0-1,5-6', 'items=0-5', 'bytes=a-b']) {
      assert.equal(parseRange(ignored, 100), null, String(ignored));
    }
  });

  test('serveFile answers 206 with Content-Range for a range, 200 for the whole file, 416 past the end', async () => {
    const file = path.join(freshDir('serve'), 'clip.mp4');
    fs.writeFileSync(file, 'abcdefghijklmnopqrst');
    let r = await serveFile(file, 'bytes=5-9');
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 5-9/20');
    assert.equal(r.headers.get('content-length'), '5');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(await r.text(), 'fghij');
    r = await serveFile(file, null);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-range'), null);
    assert.equal(r.headers.get('content-length'), '20');
    assert.equal(await r.text(), 'abcdefghijklmnopqrst');
    r = await serveFile(file, 'bytes=20-');
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), 'bytes */20');
    r = await serveFile(file, 'bytes=0-3', 'HEAD');
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-length'), '4');
    assert.equal(await r.text(), '');
    const empty = path.join(path.dirname(file), 'empty.m4a');
    fs.writeFileSync(empty, '');
    r = await serveFile(empty, null);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mp4');
    assert.equal(await r.text(), '');
  });
});

describe('handleLocalMedia: the protocol', () => {
  const request = (file, range) => ({
    url: localMediaUrl(file), method: 'GET', headers: new Headers(range ? { Range: range } : {}),
  });

  test('a video or sound the engine copied out is served, seeking included', { skip: !symlinksWork && 'needs symlinks' }, async () => {
    const t = tempFolder();
    const r = await handleLocalMedia(request(t.messages, 'bytes=3-'), [t.temp]);
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-type'), 'video/quicktime', 'by extension, whatever its case');
    assert.equal(await r.text(), '3456789');
    assert.equal((await handleLocalMedia(request(t.decrypted), [t.temp])).status, 200);
  });

  test('anything else is "not found", and logged', { skip: !symlinksWork && 'needs symlinks' }, async () => {
    const t = tempFolder();
    quiet.length = 0;
    for (const file of [t.outside, t.link, t.textFile, t.notCopy, t.folder]) {
      const r = await handleLocalMedia(request(file), [t.temp]);
      assert.equal(r.status, 404, file);
      assert.equal(await r.text(), 'Not found');
    }
    assert.equal((await handleLocalMedia({ url: 'local-media://media/%E0%A4%A', headers: new Headers() }, [t.temp])).status, 404);
    assert.equal(quiet.length, 6);
  });
});

describe('mediaThumbnail: poster frames', () => {
  const image = (bytes = 'jpeg') => ({ isEmpty: () => false, toJPEG: () => Buffer.from(bytes) });
  const maker = (answer) => {
    const asked = [];
    return { asked, createThumbnailFromPath: async (file, size) => { asked.push([file, size]); return typeof answer === 'function' ? answer() : answer; } };
  };

  test('a copy\'s poster as a JPEG data URL, at the size asked (16 to 1024 px, 480 by default)', { skip: !symlinksWork && 'needs symlinks' }, async () => {
    const t = tempFolder();
    const nativeImage = maker(image('poster'));
    const url = await mediaThumbnail(t.messages, 240, { tempDirs: [t.temp], nativeImage, platform: 'darwin' });
    assert.equal(url, `data:image/jpeg;base64,${Buffer.from('poster').toString('base64')}`);
    await mediaThumbnail(t.photos, undefined, { tempDirs: [t.temp], nativeImage, platform: 'win32' });
    await mediaThumbnail(t.photos, 99999, { tempDirs: [t.temp], nativeImage, platform: 'win32' });
    await mediaThumbnail(t.photos, 2.4, { tempDirs: [t.temp], nativeImage, platform: 'win32' });
    assert.deepEqual(nativeImage.asked.map(([, size]) => size.width), [240, 480, 1024, 16]);
    assert.equal(nativeImage.asked[0][0], fs.realpathSync.native(t.messages), 'the real path goes to the previewer');
  });

  test('null on Linux, outside the copy folders, for files that aren\'t videos or photos, and when the previewer fails', { skip: !symlinksWork && 'needs symlinks' }, async () => {
    const t = tempFolder();
    const nativeImage = maker(image());
    const opts = { tempDirs: [t.temp], nativeImage, platform: 'darwin' };
    assert.equal(await mediaThumbnail(t.messages, 480, { ...opts, platform: 'linux' }), null);
    for (const file of [t.outside, t.link, t.textFile, t.folder, 42, null]) assert.equal(await mediaThumbnail(file, 480, opts), null, String(file));
    assert.equal(nativeImage.asked.length, 0, 'the previewer is never asked about them');
    assert.equal(await mediaThumbnail(t.messages, 480, { ...opts, nativeImage: undefined }), null);
    assert.equal(await mediaThumbnail(t.messages, 480, { ...opts, nativeImage: maker(() => { throw new Error('unable to retrieve thumbnail'); }) }), null);
    assert.equal(await mediaThumbnail(t.messages, 480, { ...opts, nativeImage: maker({ isEmpty: () => true, toJPEG: () => Buffer.from('x') }) }), null);
    assert.equal(await mediaThumbnail(t.messages, 480, { ...opts, nativeImage: maker(image('')) }), null);
  });

  test('a previewer that never answers gives up after the time limit', { skip: !symlinksWork && 'needs symlinks' }, async () => {
    const t = tempFolder();
    const never = { createThumbnailFromPath: () => new Promise(() => {}) };
    const started = Date.now();
    assert.equal(await mediaThumbnail(t.messages, 480, { tempDirs: [t.temp], nativeImage: never, platform: 'darwin', timeoutMs: 50 }), null);
    assert.ok(Date.now() - started < 2000);
  });
});
