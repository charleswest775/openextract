// OpenExtract AI's download list. An experimental build of the app (with OPENEXTRACT_AI_INDEX_URL)
// fetches https://www.openextract.app/ai/addon/index.json when someone clicks Install on its Ask AI
// screen. vercel.json sends that to the newest release of charleswest775/openextract-ai-releases,
// so a new add-on needs a new release there and nothing here. Public builds never fetch it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { redirects } = JSON.parse(fs.readFileSync(path.join(root, 'website', 'static', 'vercel.json'), 'utf8'));

test('/ai/addon/index.json goes to the newest OpenExtract AI release\'s index.json', () => {
  const r = redirects.find(x => x.source === '/ai/addon/index.json');
  assert.ok(r, 'vercel.json has an /ai/addon/index.json redirect');
  assert.equal(r.destination, 'https://github.com/charleswest775/openextract-ai-releases/releases/latest/download/index.json');
  assert.equal(r.permanent, false, 'temporary, so where it points can change');
});
