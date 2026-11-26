// Tests for the Timeline's and People's continuous stream (src/lib/eventStream.ts):
// days in a newest-first stream, each day's whole count even when only part of
// it is on screen, unique keys, and undated events; and for the one-line summary
// of a message that was only files (src/lib/attachmentSummary.ts).
// Instants are built with the local Date constructor so the checks hold in any
// time zone; the file reruns itself in several (test-helpers/time-zones.mjs).
// Run with: node --test scripts/event-stream.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { rerunInTimeZones } from './test-helpers/time-zones.mjs';

const { streamDays } = loadTs('src/lib/eventStream.ts');
const { attachmentSummary, attachmentLabels } = loadTs('src/lib/attachmentSummary.ts');
const { formatDate } = loadTs('src/lib/dates.ts');

const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
let nextId = 1;
const ev = timestamp => ({ id: `call:${nextId++}`, type: 'call', timestamp, contactName: null, contactIdentifier: null });
const shape = days => days.map(d => [d.key, d.entries.map(e => e.id), d.total]);

test('a newest-first stream splits into days, labelled like the rest of the app', () => {
  nextId = 1;
  const entries = [ev(at(2026, 11, 17, 10)), ev(at(2026, 11, 17, 9)), ev(at(2026, 11, 16, 18)), ev(at(2026, 11, 14, 8))];
  const days = streamDays(entries, entries.length);
  assert.deepEqual(shape(days), [
    ['2026-11-17', ['call:1', 'call:2'], 2],
    ['2026-11-16', ['call:3'], 1],
    ['2026-11-14', ['call:4'], 1],
  ]);
  assert.equal(days[0].label, formatDate(entries[0].timestamp));
});

test("only the first part is on screen, but the last day's count is the whole day's", () => {
  nextId = 1;
  const entries = [ev(at(2026, 11, 17, 10)), ev(at(2026, 11, 16, 18)), ev(at(2026, 11, 16, 12)), ev(at(2026, 11, 16, 9)), ev(at(2026, 11, 15, 9))];
  assert.deepEqual(shape(streamDays(entries, 2)), [
    ['2026-11-17', ['call:1'], 1],
    ['2026-11-16', ['call:2'], 3],
  ]);
  // Growing the list fills the day in without changing its key
  assert.deepEqual(shape(streamDays(entries, 4)).map(([k, ids, n]) => [k, ids.length, n]), [
    ['2026-11-17', 1, 1],
    ['2026-11-16', 3, 3],
  ]);
});

test('showing more than there is, or nothing, is fine', () => {
  nextId = 1;
  const entries = [ev(at(2026, 1, 2)), ev(at(2026, 1, 1))];
  assert.equal(streamDays(entries, 500).length, 2);
  assert.deepEqual(streamDays(entries, 0), []);
  assert.deepEqual(streamDays([], 150), []);
});

test('a day that comes back further down still gets a key of its own', () => {
  nextId = 1;
  // Out of order: a stream sorted by another clock, or two sources merged
  const entries = [ev(at(2026, 3, 4)), ev(at(2026, 3, 3)), ev(at(2026, 3, 4, 8))];
  const keys = streamDays(entries, 3).map(d => d.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, ['2026-03-04', '2026-03-03', '2026-03-04#1']);
});

test('events with no usable date go under "Unknown date"', () => {
  nextId = 1;
  const entries = [ev(at(2026, 3, 4)), ev(''), ev('not a date')];
  const days = streamDays(entries, 3);
  assert.deepEqual(days.map(d => [d.key, d.label, d.total]), [
    ['2026-03-04', formatDate(entries[0].timestamp), 1],
    ['unknown', 'Unknown date', 2],
  ]);
});

const file = (name, mime = null) => ({ transfer_name: name, filename: `~/Library/SMS/Attachments/ab/12/X/${name}`, mime_type: mime });

test('attachmentSummary says what a message without words sent', () => {
  assert.equal(attachmentSummary([file('IMG_0001.HEIC', 'image/heic')]), 'Photo');
  assert.equal(attachmentSummary([file('IMG_0001.jpeg', 'image/jpeg'), file('IMG_0002.jpeg', 'image/jpeg'), file('a.png', 'image/png')]), '3 photos');
  assert.equal(attachmentSummary([file('IMG_0003.MOV', 'video/quicktime')]), 'Video');
  assert.equal(attachmentSummary([file('clip.mp4', 'video/mp4'), file('b.mov', 'video/quicktime')]), '2 videos');
  assert.equal(attachmentSummary([file('Lease.pdf', 'application/pdf')]), 'Lease.pdf');
  assert.equal(attachmentSummary([file('IMG_1.jpeg', 'image/jpeg'), file('Lease.pdf', 'application/pdf')]), '2 attachments');
  assert.equal(attachmentSummary([file('song.m4a', 'audio/x-m4a')]), 'Audio');
});

test("an iMessage audio message is a voice message, whatever its file's type", () => {
  assert.equal(attachmentSummary([file('Audio Message.caf', 'audio/x-caf')], 'audio'), 'Voice message');
});

test('no files, no summary', () => {
  assert.equal(attachmentSummary([]), '');
  assert.equal(attachmentSummary(null), '');
  assert.equal(attachmentSummary(undefined), '');
});

// A photo or file whose record iOS removed, as ios-backup-core lists it: no id, name or type
const gone = { attachment_id: null, transfer_name: '', filename: '', mime_type: null, available: false };

test("a file nothing is known about is an attachment, not a guess at its kind", () => {
  assert.equal(attachmentSummary([gone]), 'Attachment');
  assert.equal(attachmentSummary([{ transfer_name: null, filename: null, mime_type: null }]), 'Attachment');
  assert.equal(attachmentSummary([gone, gone]), '2 attachments');
  assert.equal(attachmentSummary([file('Lease.pdf', 'application/pdf'), gone]), '2 attachments');
  // A file with a name but no type is still named by it
  assert.equal(attachmentSummary([{ transfer_name: 'Lease.pdf', filename: '', mime_type: null }]), 'Lease.pdf');
});

test('attachmentLabels names each file with what it is, for saved text', () => {
  assert.deepEqual(attachmentLabels([file('IMG_4127.HEIC', 'image/heic'), file('trail-cam.mp4', 'video/mp4'), file('Lease.pdf', 'application/pdf')]),
    ['Photo: IMG_4127.HEIC', 'Video: trail-cam.mp4', 'Document: Lease.pdf']);
  assert.deepEqual(attachmentLabels([file('Audio Message.caf', 'audio/x-caf')], 'audio'), ['Voice message: Audio Message.caf']);
  // The engine's label for a file with no name ("Photo") isn't repeated as a name
  assert.deepEqual(attachmentLabels([{ transfer_name: 'Photo', filename: '', mime_type: 'image/jpeg' }]), ['Photo']);
  assert.deepEqual(attachmentLabels(undefined), []);
  // Nothing known about it: its record is gone, and the file with it
  assert.deepEqual(attachmentLabels([gone, file('IMG_1.jpeg', 'image/jpeg')]),
    ['Attachment not in this backup', 'Photo: IMG_1.jpeg']);
});

rerunInTimeZones(import.meta.url);
