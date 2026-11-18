// Tests for what the Save to computer screen offers and says about a data bundle
// (src/lib/bundle.ts). The engine writes the bundle (python/bundle.py); its own tests
// are python/tests/test_bundle.py and python/tests/corpus/test_corpus_bundle.py.
// Run with: node --test scripts/bundle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const {
  BUNDLE_KINDS, BUNDLE_FILES, defaultBundleChoice, bundleParams, bundleSummary, bundleProgress, computerTimeZone,
} = loadTs('src/lib/bundle.ts');

test('the kinds are the ones the engine knows, in its order', () => {
  // python/bundle.py TYPES
  assert.deepEqual(BUNDLE_KINDS.map(k => k.id), ['messages', 'calls', 'voicemail', 'contacts', 'photos', 'people']);
  assert.deepEqual(BUNDLE_FILES.map(f => f.id), ['attachments', 'voicemail_audio', 'photos']);
});

test('everything the backup has is ticked, but not photo files', () => {
  const choice = defaultBundleChoice({
    total_messages: 10, total_calls: 0, total_voicemails: 2, total_contacts: 5, photos_in_backup: 0, hidden_photos_in_backup: 3,
  });
  assert.deepEqual([...choice.kinds].sort(), ['contacts', 'messages', 'people', 'photos', 'voicemail']);
  assert.deepEqual([...choice.files].sort(), ['attachments', 'voicemail_audio']);
});

test('before the counts are known, every kind is ticked', () => {
  assert.equal(defaultBundleChoice(null).kinds.size, 6);
});

test('params name the kinds in order, and a file is only copied with its kind', () => {
  const params = bundleParams({
    kinds: new Set(['people', 'voicemail', 'messages']),
    files: new Set(['attachments', 'voicemail_audio', 'photos']),
  });
  assert.deepEqual(params.types, ['messages', 'voicemail', 'people']);
  assert.deepEqual(params.files, { attachments: true, voicemail_audio: true, photos: false });
  assert.deepEqual(bundleParams({ kinds: new Set(['calls']), files: new Set() }).files,
    { attachments: false, voicemail_audio: false, photos: false });
});

test('the summary counts each kind, says what failed, and reads well for one', () => {
  assert.equal(
    bundleSummary({
      path: '/x', schema_version: '0.1', files: [], failed_files: 2,
      counts: { messages: 1410, calls: 0, voicemail: 1, contacts: 45, photos: 1, people: 24 },
      errors: { calls: 'RuntimeError: broken' },
    }),
    "1,410 messages · Call history couldn't be read · 1 voicemail · 45 contacts · 1 photo or video · 24 people · 2 files couldn't be copied",
  );
  assert.equal(
    bundleSummary({ path: '/x', schema_version: '0.1', files: [], failed_files: 1, counts: { people: 1 }, errors: { people: 'x' } }),
    "People couldn't be read · 1 file couldn't be copied",
  );
  assert.equal(bundleSummary({ path: '/x', schema_version: '0.1', files: [], failed_files: 0, counts: {}, errors: {} }),
    'Nothing to save from this backup');
});

test('progress counts records', () => {
  assert.equal(bundleProgress(1234, 5678), 'Saving 1,234 of 5,678 records…');
  assert.equal(bundleProgress(9, 1), 'Saving 1 of 1 record…');
});

test('the time zone is an IANA name, or null', () => {
  const zone = computerTimeZone();
  assert.ok(zone === null || /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(zone), zone);
});
