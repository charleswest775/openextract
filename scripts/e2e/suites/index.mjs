// The end-to-end suites, in the order a run takes them. `needs` names backups from the
// backups file (scripts/e2e/backups.py); `default: false` suites run only when asked for.
import firstRun from './first-run.mjs';
import open from './open.mjs';
import screens from './screens.mjs';
import search from './search.mjs';
import exportsSuite from './exports.mjs';
import empty from './empty.mjs';
import ipc from './ipc.mjs';
import network from './network.mjs';
import hickman from './hickman.mjs';
import smoke from './smoke.mjs';

export const SUITES = [firstRun, open, screens, search, exportsSuite, empty, ipc, network, hickman, smoke];
