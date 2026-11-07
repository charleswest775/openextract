// Run a date-sensitive test file again in other time zones.
//
// The tests themselves are written to hold in any zone: they build instants
// with the local Date constructor and check where they land, so whichever zone
// the machine is in gets tested. CI machines are usually in UTC, where a day
// boundary bug can't show, so on macOS and Linux each file also re-runs itself
// in a child process per zone below (TZ=..., and LC_ALL for the locale).
// Windows reads the zone from the system, not TZ, so it skips the reruns.
//
//   import { rerunInTimeZones, onlyIn } from './test-helpers/time-zones.mjs';
//   test('exact strings in LA', { skip: onlyIn('America/Los_Angeles') }, ...);
//   rerunInTimeZones(import.meta.url);   // last line of the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ZONES = [
  { tz: 'America/Los_Angeles', locale: 'en_US.UTF-8' },  // -8/-7, US daylight saving
  { tz: 'Australia/Lord_Howe', locale: 'en_US.UTF-8' },  // +10:30/+11, a half-hour DST change
  { tz: 'Asia/Kolkata', locale: 'en_US.UTF-8' },         // +5:30, no DST
  { tz: 'UTC', locale: 'en_US.UTF-8' },
  { tz: 'Pacific/Kiritimati', locale: 'en_US.UTF-8' },   // +14, a day ahead of most of the world
  { tz: 'America/St_Johns', locale: 'en_US.UTF-8' },     // -3:30/-2:30
  { tz: 'Europe/Berlin', locale: 'de_DE.UTF-8' },        // German dates and numbers
];

/** The zone this run was started in by rerunInTimeZones, or null in the main run. */
export const childZone = process.env.OE_TEST_TZ || null;

/** The time zone dates are shown in, in this process (e.g. 'America/Los_Angeles'). */
export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The locale dates and numbers are formatted in, in this process (e.g. 'en-US'). */
export const locale = new Intl.NumberFormat().resolvedOptions().locale;

/** Exact English strings ("Mar 10, 2024", "1,234") can only be checked in en-US. */
export const enUS = locale === 'en-US';

/** Whether this process shows dates in `tz`. ICU renames some zones (Asia/Kolkata is Asia/Calcutta). */
export function inZone(tz) {
  const canonical = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  const utc = name => ['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT'].includes(name);
  return zone === tz || zone === canonical || (utc(canonical) && utc(zone));
}

/** A test's skip option: false when this process runs in `tz` (and `wantLocale`), else the reason. */
export function onlyIn(tz, wantLocale = 'en-US') {
  if (inZone(tz) && locale === wantLocale) return false;
  return `checked in the TZ=${tz} ${wantLocale} run`;
}

function run(file, { tz, locale }) {
  const env = { ...process.env, TZ: tz, OE_TEST_TZ: tz, LC_ALL: locale, LANG: locale };
  // node --test tells its children to report in its own format; this child reports TAP to us
  delete env.NODE_TEST_CONTEXT;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test-reporter=tap', file], { env });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    child.on('error', err => resolve({ code: -1, output: String(err) }));
    child.on('close', code => resolve({ code, output }));
  });
}

/**
 * Call at the end of a test file. In the main run, adds one test that re-runs
 * the file under each of ZONES; in a child run, checks the zone took effect.
 */
export function rerunInTimeZones(metaUrl, zones = ZONES) {
  if (childZone) {
    test(`this run is in ${childZone}`, () => {
      assert.ok(inZone(childZone), `TZ=${childZone} didn't take effect; dates are in ${zone}`);
    });
    return;
  }
  const file = fileURLToPath(metaUrl);
  const skip = process.platform === 'win32'
    && "Windows ignores TZ, so only this machine's own time zone is tested";
  // node --test already runs files side by side, so keep each file's reruns to the CPUs there are
  const concurrency = Math.max(2, Math.min(zones.length, os.availableParallelism() - 1));
  test('the same tests in other time zones', { skip, concurrency }, async t => {
    const stillFailing = new Map(); // known bug (todo test) -> zones where it still fails
    await Promise.all(zones.map(z => t.test(`TZ=${z.tz} ${z.locale}`, async () => {
      const { code, output } = await run(file, z);
      for (const m of output.matchAll(/^\s*not ok \d+ - (.*) # TODO/gm)) {
        stillFailing.set(m[1], [...(stillFailing.get(m[1]) ?? []), z.tz]);
      }
      assert.equal(code, 0, `${path.basename(file)} failed with TZ=${z.tz} ${z.locale}:\n${output}`);
    })));
    // So the main run's output says which known bugs depend on the time zone
    const order = tz => zones.findIndex(z => z.tz === tz);
    for (const [name, failing] of stillFailing) {
      failing.sort((a, b) => order(a) - order(b));
      const where = failing.length === zones.length ? 'every zone' : failing.join(', ');
      t.diagnostic(`known bug still failing in ${where}: ${name}`);
    }
  });
}
