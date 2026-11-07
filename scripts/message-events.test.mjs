// Tests for what the thread view says for a message with no text and no
// attachment (src/lib/messageEvents.ts, shown by ChatBubble.tsx): the engine's
// own words for group changes, unsent messages and FaceTime calls, a label by
// message_type for the rest, and "Conversation update" for rows nobody can name.
// python/tests/test_export_event_labels.py checks the exports use the same words.
// Run with: node --test scripts/message-events.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const { eventLabel, EVENT_LABELS, EVENT_FALLBACK } = loadTs('src/lib/messageEvents.ts');

test('the engine\'s words win, whatever the type', () => {
  const cases = [
    ['group_member_added', 'Karin added Theo to the conversation'],
    ['group_member_removed', 'You removed Theo from the conversation'],
    ['group_renamed', 'You named the conversation "Trip"'],
    ['group_name_removed', 'Karin removed the conversation name'],
    ['group_member_left', 'Theo left the conversation'],
    ['group_photo_changed', 'The group photo was changed'],
    ['group_photo_removed', 'Karin removed the group photo'],
    ['unsent', 'Karin unsent a message'],
    ['facetime', 'FaceTime call'],
    ['system', 'Something the engine learned to name later'],
  ];
  for (const [message_type, event_text] of cases) {
    assert.equal(eventLabel({ message_type, event_text }), event_text);
  }
});

test('other messages are labelled by type', () => {
  assert.equal(eventLabel({ message_type: 'location_started_by_me' }), 'You started sharing your location');
  assert.equal(eventLabel({ message_type: 'audio', event_text: null }), 'Audio message not in this backup');
  assert.equal(eventLabel({ message_type: 'link', event_text: '' }), 'Link');
  for (const [type, label] of Object.entries(EVENT_LABELS)) assert.equal(eventLabel({ message_type: type }), label);
});

test('anything else is a "Conversation update", never a "Conversation event"', () => {
  assert.equal(EVENT_FALLBACK, 'Conversation update');
  for (const message_type of ['system', 'location', 'group_member_added', 'something_new', '', undefined]) {
    assert.equal(eventLabel({ message_type }), 'Conversation update');
  }
  assert.equal(eventLabel({}), 'Conversation update');
  // Not fooled by names on Object.prototype
  assert.equal(eventLabel({ message_type: 'toString' }), 'Conversation update');
});
