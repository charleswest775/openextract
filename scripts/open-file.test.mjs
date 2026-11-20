// Tests for handing a file copied out of the backup to the computer (src/lib/openFile.ts),
// as the Photos screen does with a video (#297). The engine's get_photo_path answers
// { path, filename, openable } or { error }; WhatsApp's files come the same way, and
// scripts/whatsapp.test.mjs covers what those say.
// Run with: node --test scripts/open-file.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const { handOver, SHOWN_IN_FOLDER, localMediaUrl } = loadTs('src/lib/openFile.ts');
const { videoProblem, VIDEO_GETTING_READY } = loadTs('src/lib/photoCounts.ts');
const whatsapp = loadTs('src/lib/whatsapp.ts');

// window.openextract's openPath and showInFolder. openPath resolves to '' when the file opened.
const computer = (answer = '') => {
  const calls = [];
  return {
    calls,
    openPath: async p => { calls.push(['open', p]); return answer; },
    showInFolder: async p => { calls.push(['show', p]); },
  };
};

const COPY = '/tmp/openextract-photos-4242-ab12cd34/00008120-0001/46ad145c3bed7be5/IMG_0042.MOV';

test('a video is opened from the copy the engine made under its own name', async () => {
  const c = computer();
  assert.equal(await handOver({ path: COPY, filename: 'IMG_0042.MOV', openable: true }, c), null);
  assert.deepEqual(c.calls, [['open', COPY]]);
});

test('what the computer says when it cannot open the video reaches the person', async () => {
  // It used to be thrown away: the click did nothing at all.
  const c = computer('No application knows how to open it');
  const said = await handOver({ path: COPY, openable: true }, c);
  assert.equal(said, "Couldn't open it: No application knows how to open it");
  assert.equal(videoProblem(said), said, 'shown as it is, not mistaken for a missing file');
});

test('a file the engine does not call openable is shown in its folder, never opened', async () => {
  // A file with no file type in its name (as in a backup's own folder), or a program:
  // opening either can run it. macOS ran a backup's video in Terminal (#297).
  for (const r of [
    { path: '/Volumes/Drive/Backup/00008120-0001/46/46ad145c3bed7be57c9541aee31e9fc641c8ccfd', openable: false },
    { path: '/tmp/openextract-photos-4242-ab12cd34/u/i/IMG_0042.MOV.command', openable: false },
    { path: COPY },
  ]) {
    const c = computer();
    assert.equal(await handOver(r, c), SHOWN_IN_FOLDER);
    assert.deepEqual(c.calls, [['show', r.path]]);
  }
});

test('nothing is handed over when the engine has no copy to give', async () => {
  const c = computer();
  assert.equal(await handOver({ error: 'File not found' }, c), 'File not found');
  assert.equal(await handOver({}, c), "Couldn't copy the file out of the backup");
  assert.equal(await handOver(null, c), "Couldn't copy the file out of the backup");
  assert.equal(await handOver(undefined, c), "Couldn't copy the file out of the backup");
  assert.deepEqual(c.calls, []);
});

test('why a video could not be opened, in words for people', () => {
  // The engine's "File not found": the video's file isn't in the backup's folder (OE-102)
  assert.equal(videoProblem('File not found'), "Its file isn't in the backup's folder.");
  assert.equal(videoProblem(' file not found. '), "Its file isn't in the backup's folder.");
  assert.equal(videoProblem(undefined), "Its file isn't in the backup's folder.");
  assert.equal(videoProblem(''), "Its file isn't in the backup's folder.");
  // Everything else is already in plain words, and is not about a missing file
  const noRoom = "This computer doesn't have enough free space. OpenExtract copies a video out of the backup "
    + 'before your video player opens it: this one is 4.2 GB, and 310 MB is free. Free up some space and try again, '
    + 'or use Save all to save your photos and videos to a drive with more room.';
  assert.equal(videoProblem(noRoom), noRoom);
  assert.equal(videoProblem(SHOWN_IN_FOLDER), SHOWN_IN_FOLDER);
  const fromComputer = "Couldn't open it: xdg-open: command not found";
  assert.equal(videoProblem(fromComputer), fromComputer, 'the computer saying "not found" is not a missing video');
  assert.match(VIDEO_GETTING_READY, /^Getting the video ready/);
});

test("WhatsApp's files go the same way", () => {
  // src/lib/whatsapp.ts passes these on, so the WhatsApp screen and its tests use the one function.
  assert.equal(whatsapp.SHOWN_IN_FOLDER, SHOWN_IN_FOLDER);
  assert.equal(typeof whatsapp.handOver, 'function');
});

test('a copy the window plays itself is addressed through local-media://, every part of its path escaped', () => {
  // electron/localMedia.ts reads it back (scripts/local-media.test.mjs checks the round trip)
  assert.equal(localMediaUrl(COPY), 'local-media://media/tmp/openextract-photos-4242-ab12cd34/00008120-0001/46ad145c3bed7be5/IMG_0042.MOV');
  assert.equal(localMediaUrl('/tmp/openextract-messages-1-a/u/7/Clip #1 100%?.mov'),
    'local-media://media/tmp/openextract-messages-1-a/u/7/Clip%20%231%20100%25%3F.mov');
  assert.equal(localMediaUrl('/tmp/a\\b.mov'), 'local-media://media/tmp/a%5Cb.mov', 'on macOS and Linux a backslash is part of a name');
  assert.equal(localMediaUrl('C:\\Users\\Ana\\AppData\\Local\\Temp\\openextract-whatsapp-9-q\\u\\3\\VID.mp4'),
    'local-media://media/C%3A/Users/Ana/AppData/Local/Temp/openextract-whatsapp-9-q/u/3/VID.mp4');
});
