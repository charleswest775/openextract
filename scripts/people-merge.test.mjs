// The app's People merge (src/components/people/gather.ts) against the shared fixture
// python/tests/fixtures/people-merge.json. The engine has the same rules in Python
// (python/people_merge.py, for a data bundle's people.json) and
// python/tests/test_people_merge.py runs the same fixture, so the two can't drift.
// Run with: node --test scripts/people-merge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTs, root } from './test-helpers/load-ts.mjs';

const { gatherPeople, linkCards } = loadTs('src/components/people/gather.ts');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'python', 'tests', 'fixtures', 'people-merge.json'), 'utf-8'));

const plain = p => ({ ...p, ids: [...p.ids].sort(), numbers: [...p.numbers].sort() });

test('the fixture has its cases', () => {
  assert.ok(fixture.cases.length >= 5);
});

for (const c of fixture.cases) {
  test(c.name, () => {
    const people = gatherPeople(c.entries, c.cards);
    assert.deepEqual(people.map(plain), c.people);
    const { cardOf } = linkCards(people, c.cards);
    assert.deepEqual(Object.fromEntries([...cardOf].map(([key, card]) => [key, card.id])), c.cardOf);
  });
}
