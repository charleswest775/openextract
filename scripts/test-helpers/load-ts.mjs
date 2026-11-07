// Load the app's TypeScript (src/, electron/) straight into node:test files,
// without a build: each file is transpiled to CommonJS in a temp folder, its
// relative imports ('./ipc', '../types/timeline') are transpiled the same way
// and pointed at the copies, and package imports ('react', 'date-fns') resolve
// from the repo's node_modules.
//
//   import { loadTs } from './test-helpers/load-ts.mjs';
//   const { formatDate } = loadTs('src/lib/dates.ts');
//
// Every call is a fresh copy: the file and the local modules it imports are
// evaluated again, so module-level code (like ipc.ts reading `window` once)
// sees whatever globals the test set up just before the call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** The repo root, with the platform's own separators. */
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const require = createRequire(import.meta.url);
const requireFromRepo = createRequire(path.join(root, 'package.json'));
const STUBS = Symbol.for('openextract.test.loadTs.stubs');
globalThis[STUBS] ??= new Map();

let tmpRoot = null;
let loadCount = 0;
function outRoot() {
  if (!tmpRoot) {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-load-ts-'));
    process.on('exit', () => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp files are harmless */ }
    });
  }
  return tmpRoot;
}

const COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  esModuleInterop: true,
  jsx: ts.JsxEmit.ReactJSX,
};

const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.cjs', '.json', ''];

function resolveLocal(base, from) {
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  const rel = path.relative(root, from);
  throw new Error(`load-ts: ${rel} imports '${path.relative(path.dirname(from), base)}', which isn't a .ts/.tsx file. `
    + 'If it only holds types, import it with `import type` so the import disappears when transpiled.');
}

/**
 * Transpile `rel` (a path from the repo root, either separator) and the local
 * modules it imports, then require it.
 *
 * options.stubs   { 'react': {...} } replaces a package import with this object.
 * options.expose  ['latestYear'] also exports these top-level names of `rel`
 *                 itself, to test helpers the module keeps private.
 */
export function loadTs(rel, { stubs = {}, expose = [] } = {}) {
  const id = ++loadCount;
  const outDir = path.join(outRoot(), String(id));
  const emitted = new Map();
  const stubFiles = new Map();

  function stubFile(name) {
    if (!stubFiles.has(name)) {
      const key = `${id}:${name}`;
      globalThis[STUBS].set(key, stubs[name]);
      const file = path.join(outDir, '__stubs__', `${stubFiles.size}.cjs`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `module.exports = globalThis[Symbol.for('openextract.test.loadTs.stubs')].get(${JSON.stringify(key)});\n`);
      stubFiles.set(name, file);
    }
    return stubFiles.get(name);
  }

  function resolveSpecifier(spec, fromSrc) {
    if (Object.prototype.hasOwnProperty.call(stubs, spec)) return stubFile(spec);
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = resolveLocal(path.resolve(path.dirname(fromSrc), spec), fromSrc);
      return /\.tsx?$/.test(target) ? emit(target, []) : target;
    }
    // Node built-ins come back as-is ('node:fs'); packages as absolute paths in the repo's node_modules
    return requireFromRepo.resolve(spec);
  }

  function emit(absSrc, exposeNames) {
    if (emitted.has(absSrc)) return emitted.get(absSrc);
    const relSrc = path.relative(root, absSrc);
    if (relSrc.startsWith('..') || path.isAbsolute(relSrc)) throw new Error(`load-ts: ${absSrc} is outside the repo`);
    const outFile = path.join(outDir, relSrc + '.cjs');
    emitted.set(absSrc, outFile);

    const source = fs.readFileSync(absSrc, 'utf-8');
    let out = ts.transpileModule(source, { fileName: absSrc, compilerOptions: COMPILER_OPTIONS }).outputText;
    out = out.replace(/\brequire\((["'])([^"'\n]+)\1\)/g,
      (_, _q, spec) => `require(${JSON.stringify(resolveSpecifier(spec, absSrc))})`);
    for (const name of exposeNames) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`load-ts: can't expose '${name}'`);
      out += `\nexports[${JSON.stringify(name)}] = ${name};`;
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, out);
    return outFile;
  }

  return require(emit(path.resolve(root, ...rel.split(/[\\/]/)), expose));
}

/**
 * Put a fake `window.openextract` (the preload bridge) in place for the
 * renderer code under test. Every call is recorded in `calls` as
 * [method, ...args]. Only the methods given exist, so code reaching for any
 * other one fails the test. Set it up before loadTs (ipc.ts checks for the
 * bridge when loaded) and keep it until the test ends:
 *
 *   const bridge = fakeBridge({ call: async () => ({ success: true, data: {} }) });
 *   t.after(bridge.restore);
 *
 * Returns { api, calls, restore }.
 */
export function fakeBridge(handlers = {}) {
  const calls = [];
  const api = {};
  for (const [name, handler] of Object.entries(handlers)) {
    api[name] = (...args) => {
      calls.push([name, ...args]);
      return handler(...args);
    };
  }
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previous = globalThis.window;
  globalThis.window = { openextract: api };
  return {
    api,
    calls,
    restore() {
      if (had) globalThis.window = previous;
      else delete globalThis.window;
    },
  };
}
