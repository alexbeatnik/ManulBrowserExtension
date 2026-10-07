// Finding the engine.
//
// There is one engine — a Go binary called `manul` — and three ways it reaches
// a machine: inside the npm package, inside the Python wheel, or on its own
// (a release archive, `go install`, a local build). This module looks in all
// three places and reports where it found each copy, so a project that uses
// any binding, or none, runs without a setting.
//
// Nothing here imports `vscode`: the search is plain filesystem work and is
// tested as such.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type EngineSource = 'setting' | 'npm' | 'python' | 'go' | 'path';

export interface EngineCandidate {
  /** Absolute path to the engine binary itself, never to a shim. */
  path: string;
  source: EngineSource;
  /** Where it was found, in words a person can act on. */
  detail: string;
  /** The interpreter of the environment the engine was installed into. */
  python?: string;
}

export interface EngineInfo extends EngineCandidate {
  version: string;
  /** Flags this build's `--help` lists. Empty when help could not be read. */
  flags: Set<string>;
}

export interface SearchOptions {
  /** The `manulBrowser.enginePath` setting. */
  custom?: string;
  /** The `manulBrowser.pythonPath` setting: an interpreter or a venv folder. */
  python?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
}

/** Folder names a virtual environment is usually given. */
export const VENV_DIRS = ['.venv', 'venv', 'env', '.env'];

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function binaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'manul.exe' : 'manul';
}

/** The npm package that carries the engine for one platform. */
export function npmEnginePackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `@manul-browser/engine-${platform}-${arch}`;
}

/** `dir`, then each of its parents, nearest first. */
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(dir);
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return out;
    cur = parent;
  }
}

/** The interpreter inside a virtual environment, if `dir` is one. */
export function venvPython(dir: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const candidates =
    platform === 'win32'
      ? [path.join(dir, 'Scripts', 'python.exe')]
      : [path.join(dir, 'bin', 'python3'), path.join(dir, 'bin', 'python')];
  return candidates.find(isFile);
}

/** `site-packages` folders of the environment rooted at `dir`. */
function sitePackages(dir: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return [path.join(dir, 'Lib', 'site-packages')];
  const lib = path.join(dir, 'lib');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(lib);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith('python'))
    .sort()
    .reverse()
    .map((name) => path.join(lib, name, 'site-packages'));
}

/**
 * The engine a Python environment carries, if it carries one. An install from
 * the sdist has the package and no binary; that is not an engine.
 */
export function engineInPythonEnv(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): EngineCandidate | undefined {
  for (const site of sitePackages(dir, platform)) {
    const bin = path.join(site, 'manul', '_bin', binaryName(platform));
    if (isFile(bin)) {
      return {
        path: bin,
        source: 'python',
        detail: `Python environment ${dir}`,
        python: venvPython(dir, platform),
      };
    }
  }
  return undefined;
}

/** True when `manul` is importable from the environment rooted at `dir`. */
export function pythonEnvHasBinding(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  return sitePackages(dir, platform).some((site) => isDir(path.join(site, 'manul')));
}

function engineInNodeModules(
  dir: string,
  platform: NodeJS.Platform,
  arch: string,
): EngineCandidate | undefined {
  const pkg = npmEnginePackage(platform, arch);
  const bases = [
    path.join(dir, 'node_modules'),
    // npm nests the platform package under the main one when it cannot hoist.
    path.join(dir, 'node_modules', 'manul-browser', 'node_modules'),
  ];
  for (const base of bases) {
    const bin = path.join(base, pkg, 'bin', binaryName(platform));
    if (isFile(bin)) return { path: bin, source: 'npm', detail: `npm package ${pkg} in ${dir}` };
  }
  return undefined;
}

/**
 * A `manul` found on PATH is often a launcher — pip's console script, npm's
 * `.cmd` — standing in front of the real binary. Resolve it, because a
 * launcher adds a process between the extension and the engine's stdin.
 */
function resolveLauncher(
  dir: string,
  platform: NodeJS.Platform,
  arch: string,
): EngineCandidate | undefined {
  // pip: <env>/Scripts/manul.exe or <env>/bin/manul
  const fromPython = engineInPythonEnv(path.dirname(dir), platform);
  if (fromPython) return fromPython;
  // npm -g: <prefix>/manul.cmd on Windows, <prefix>/bin/manul elsewhere
  for (const prefix of [dir, path.join(path.dirname(dir), 'lib')]) {
    const fromNpm = engineInNodeModules(prefix, platform, arch);
    if (fromNpm) return { ...fromNpm, detail: `global npm package in ${prefix}` };
  }
  // A project-local node_modules/.bin on PATH
  if (path.basename(dir) === '.bin') {
    const fromBin = engineInNodeModules(path.dirname(path.dirname(dir)), platform, arch);
    if (fromBin) return fromBin;
  }
  return undefined;
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  return raw.split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/**
 * Every engine reachable from `roots`, best first, without duplicates.
 *
 * The order is "the more specific to this project, the earlier": an explicit
 * setting, then what the project itself installed (npm, then Python), then a
 * binary built or dropped in the project, then the machine at large.
 */
export function findEngines(roots: string[], opts: SearchOptions = {}): EngineCandidate[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const home = opts.home ?? os.homedir();
  const exe = binaryName(platform);

  const found: EngineCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: EngineCandidate | undefined): void => {
    if (!c) return;
    const key = platform === 'win32' ? c.path.toLowerCase() : c.path;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(c);
  };

  const custom = (opts.custom ?? '').trim();
  if (custom) {
    for (const p of [custom, ...roots.map((r) => path.resolve(r, custom))]) {
      if (isFile(p)) {
        add({ path: p, source: 'setting', detail: 'manulBrowser.enginePath' });
        break;
      }
    }
  }

  // npm — from each root upwards, the way Node itself resolves a package.
  for (const root of roots) {
    for (const dir of ancestors(root)) add(engineInNodeModules(dir, platform, arch));
  }

  // Python — the configured interpreter, the active environment, then the
  // conventional folder names in each root.
  const pythonSetting = (opts.python ?? '').trim();
  if (pythonSetting) {
    // An interpreter lives at <env>/bin/python or <env>/Scripts/python.exe; a
    // folder is taken to be the environment itself.
    const envDir = isDir(pythonSetting) ? pythonSetting : path.dirname(path.dirname(pythonSetting));
    add(engineInPythonEnv(envDir, platform));
  }
  if (env.VIRTUAL_ENV) add(engineInPythonEnv(env.VIRTUAL_ENV, platform));
  for (const root of roots) {
    for (const name of VENV_DIRS) add(engineInPythonEnv(path.join(root, name), platform));
  }

  // Go — a binary built in, or dropped into, the project.
  for (const root of roots) {
    for (const rel of ['', 'bin', 'core', path.join('core', 'bin'), 'dist']) {
      const p = path.join(root, rel, exe);
      if (isFile(p)) add({ path: p, source: 'go', detail: `binary in ${path.join(root, rel)}` });
    }
  }
  const goBins = [env.GOBIN, env.GOPATH ? path.join(env.GOPATH, 'bin') : undefined, path.join(home, 'go', 'bin')];
  for (const dir of goBins) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    if (isFile(p)) add({ path: p, source: 'go', detail: `Go bin directory ${dir}` });
  }

  // PATH — last, and resolved through any launcher.
  const launcherNames = platform === 'win32' ? ['manul.exe', 'manul.cmd'] : ['manul'];
  for (const dir of pathDirs(env, platform)) {
    for (const name of launcherNames) {
      const p = path.join(dir, name);
      if (!isFile(p)) continue;
      const real = resolveLauncher(dir, platform, arch);
      if (real) add(real);
      else if (!name.endsWith('.cmd')) add({ path: p, source: 'path', detail: `PATH (${dir})` });
    }
  }

  return found;
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`;
      // `--help` exits non-zero on some builds and still prints what we need.
      if (err && !text.trim()) reject(err);
      else resolve(text);
    });
  });
}

/** `manul 0.1.2` → `0.1.2`. */
export function parseVersion(output: string): string {
  const m = output.match(/(\d+\.\d+(?:\.\d+)*(?:[-+][\w.]+)?)/);
  return m ? m[1] : '';
}

/** Flag names out of Go's `flag` usage text: `  -hooks string`. */
export function parseFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const m of help.matchAll(/^\s+--?([a-z][a-z0-9-]*)\b/gm)) flags.add(m[1]);
  return flags;
}

/**
 * Ask a candidate what it is. Rejects when the file does not run — a binary
 * for another platform, a lost executable bit — so the caller can move on to
 * the next candidate instead of failing later, mid-run, with less to go on.
 */
export async function probeEngine(candidate: EngineCandidate, timeoutMs = 8000): Promise<EngineInfo> {
  const versionOut = await run(candidate.path, ['--version'], timeoutMs);
  const version = parseVersion(versionOut);
  if (!version) throw new Error(`${candidate.path} did not report a version`);
  let flags = new Set<string>();
  try {
    flags = parseFlags(await run(candidate.path, ['--help'], timeoutMs));
  } catch {
    // An engine that runs but will not print help is still an engine.
  }
  return { ...candidate, version, flags };
}

/** The first candidate that actually runs, with the ones that did not. */
export async function resolveEngine(
  roots: string[],
  opts: SearchOptions = {},
): Promise<{ engine?: EngineInfo; candidates: EngineCandidate[]; failures: string[] }> {
  const candidates = findEngines(roots, opts);
  const failures: string[] = [];
  for (const c of candidates) {
    try {
      return { engine: await probeEngine(c), candidates, failures };
    } catch (err) {
      failures.push(`${c.path}: ${(err as Error).message}`);
    }
  }
  return { candidates, failures };
}

/**
 * Whether this build understands a flag. An engine whose help could not be
 * read is given the benefit of the doubt: refusing to pass `--hooks` to a
 * build that has it is worse than passing it to one that says so itself.
 */
export function supports(engine: EngineInfo | undefined, flag: string): boolean {
  if (!engine || engine.flags.size === 0) return true;
  return engine.flags.has(flag);
}

export function sourceLabel(source: EngineSource): string {
  switch (source) {
    case 'npm':
      return 'npm';
    case 'python':
      return 'Python';
    case 'go':
      return 'Go';
    case 'setting':
      return 'custom';
    default:
      return 'PATH';
  }
}
