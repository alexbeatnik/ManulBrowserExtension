// Picking up hook scripts.
//
// The engine never looks for a hook script: it runs the one named by
// `--hooks`, and a run started without the flag has no custom controls, no
// CALL handlers and no suite hooks — every `{placeholder}` a `before_all`
// would have filled stays literal. The extension closes that gap: it finds the
// script that belongs to a hunt, passes it, and points the engine at an
// interpreter that can actually import the binding.

import * as fs from 'fs';
import * as path from 'path';
import { EngineInfo, VENV_DIRS, pythonEnvHasBinding, venvPython } from './engine';

/** File names recognised as a hook script, in order of preference. */
export const HOOK_BASENAMES = [
  'manul_hooks.py',
  'manul_hooks.mjs',
  'manul_hooks.js',
  'manul_hooks.cjs',
  'manul_hooks.exe',
  'manul_hooks',
];

export type HookRuntime = 'python' | 'node' | 'native';

export type HookKind =
  | 'before_all'
  | 'after_all'
  | 'before_group'
  | 'after_group'
  | 'custom_control'
  | 'call';

export interface HookHandler {
  kind: HookKind;
  /** Tag for group hooks, name for calls, target for controls. */
  name: string;
  /** The page a custom control is limited to; empty means every page. */
  page: string;
  /** The function that handles it, when one could be named. */
  handler: string;
  /** 0-based line of the registration. */
  line: number;
}

export interface HookScan {
  handlers: HookHandler[];
  /**
   * Whether the script ever hands control to the engine. Without that call
   * the engine waits for a script that has already exited.
   */
  serves: boolean;
  /** Names the script publishes with `ctx.set(...)` — placeholders in a hunt. */
  variables: string[];
}

export function hookRuntime(file: string): HookRuntime {
  switch (path.extname(file).toLowerCase()) {
    case '.py':
      return 'python';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'node';
    default:
      return 'native';
  }
}

const exists = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The hook script for a hunt: the nearest one at or above the hunt's folder,
 * no higher than the workspace root. Nearest wins so a sub-suite can carry its
 * own script without a setting.
 */
export function findHookScript(huntFile: string, root: string): string | undefined {
  const stop = path.resolve(root);
  let dir = path.dirname(path.resolve(huntFile));
  const inside = (d: string): boolean => {
    const rel = path.relative(stop, d);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  // A hunt outside the workspace still gets its own folder searched.
  const bounded = inside(dir);
  for (;;) {
    for (const name of HOOK_BASENAMES) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir || !bounded || !inside(parent)) return undefined;
    dir = parent;
  }
}

export interface HookSettings {
  /** `manulBrowser.hooks.enabled` */
  enabled: boolean;
  /** `manulBrowser.hooks.path` — empty means "find it". */
  path: string;
}

/** The script a run of `huntFile` should be given, or nothing. */
export function resolveHookScript(huntFile: string, root: string, settings: HookSettings): string | undefined {
  if (!settings.enabled) return undefined;
  const configured = settings.path.trim();
  if (configured) {
    const abs = path.isAbsolute(configured) ? configured : path.resolve(root, configured);
    return exists(abs) ? abs : undefined;
  }
  return findHookScript(huntFile, root);
}

const QUOTED = `(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`)`;
const firstGroup = (m: RegExpMatchArray, from: number): string =>
  m.slice(from).find((g) => g !== undefined) ?? '';

function keywordArg(args: string, key: string): string {
  const m = args.match(new RegExp(`\\b${key}\\s*[=:]\\s*${QUOTED}`));
  return m ? firstGroup(m, 1) : '';
}

function scanPython(lines: string[]): HookHandler[] {
  const out: HookHandler[] = [];
  const handlerBelow = (i: number): string => {
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const m = lines[j].match(/^\s*(?:async\s+)?def\s+(\w+)/);
      if (m) return m[1];
      if (!/^\s*(@|#|$)/.test(lines[j])) break;
    }
    return '';
  };
  lines.forEach((text, line) => {
    const m = text.match(/^\s*@(?:\w+\.)?(before_all|after_all|before_group|after_group|custom_control|call)\b(.*)$/);
    if (!m) return;
    const kind = m[1] as HookKind;
    const args = m[2];
    const handler = handlerBelow(line);
    if (kind === 'before_all' || kind === 'after_all') {
      out.push({ kind, name: '', page: '', handler, line });
    } else if (kind === 'custom_control') {
      const positional = args.match(new RegExp(`^\\(\\s*${QUOTED}`));
      out.push({
        kind,
        name: keywordArg(args, 'target') || (positional ? firstGroup(positional, 1) : ''),
        page: keywordArg(args, 'page'),
        handler,
        line,
      });
    } else {
      const arg = args.match(new RegExp(`^\\(\\s*${QUOTED}`));
      out.push({ kind, name: arg ? firstGroup(arg, 1) : '', page: '', handler, line });
    }
  });
  return out;
}

const JS_KINDS: Record<string, HookKind> = {
  beforeAll: 'before_all',
  afterAll: 'after_all',
  beforeGroup: 'before_group',
  afterGroup: 'after_group',
  customControl: 'custom_control',
  call: 'call',
};

function scanJs(lines: string[]): HookHandler[] {
  const out: HookHandler[] = [];
  lines.forEach((text, line) => {
    // Anchored to the start of a statement: `foo.call(this)` is not a hook.
    const m = text.match(
      /^\s*(?:await\s+)?(?:(?:manul|\w+)\.)?(beforeAll|afterAll|beforeGroup|afterGroup|customControl|call)\s*\((.*)$/,
    );
    if (!m) return;
    const kind = JS_KINDS[m[1]];
    const args = m[2];
    const named = args.match(/(?:async\s+)?function\s+(\w+)|,\s*(\w+)\s*\)\s*;?\s*$/);
    const handler = named ? (named[1] ?? named[2] ?? '') : '';
    if (kind === 'before_all' || kind === 'after_all') {
      out.push({ kind, name: '', page: '', handler, line });
    } else if (kind === 'custom_control' && /^\s*\{/.test(args)) {
      out.push({ kind, name: keywordArg(args, 'target'), page: keywordArg(args, 'page'), handler, line });
    } else {
      const arg = args.match(new RegExp(`^\\s*${QUOTED}`));
      if (!arg) return;
      out.push({ kind, name: firstGroup(arg, 1), page: '', handler, line });
    }
  });
  return out;
}

/**
 * What a hook script registers, read off its text. This is a reading aid, not
 * the source of truth — the engine learns the real list from the script when
 * it runs — so a registration built dynamically simply does not show up.
 */
export function scanHookScript(text: string, file: string): HookScan {
  const lines = text.split(/\r?\n/);
  const runtime = hookRuntime(file);
  // Python publishes with ctx.set("name", …); both bindings also allow
  // writing to ctx.variables directly, which is the only way in JavaScript.
  const published = [
    /\.set\(\s*["'`]([A-Za-z_]\w*)["'`]\s*,/g,
    /\.variables\.([A-Za-z_]\w*)\s*=(?!=)/g,
    /\.variables\[\s*["'`]([A-Za-z_]\w*)["'`]\s*\]\s*=(?!=)/g,
  ];
  const variables = [...new Set(published.flatMap((re) => [...text.matchAll(re)].map((m) => m[1])))];
  if (runtime === 'python') {
    return { handlers: scanPython(lines), serves: /\bserve_hooks\s*\(/.test(text), variables };
  }
  if (runtime === 'node') {
    return { handlers: scanJs(lines), serves: /\bserveHooks\s*\(/.test(text), variables };
  }
  return { handlers: [], serves: true, variables: [] };
}

export function describeHandler(h: HookHandler): string {
  switch (h.kind) {
    case 'before_all':
    case 'after_all':
      return h.kind;
    case 'before_group':
    case 'after_group':
      return `${h.kind}("${h.name}")`;
    case 'custom_control':
      return h.page ? `${h.name} — on ${h.page}` : h.name;
    default:
      return h.name;
  }
}

export interface InterpreterSettings {
  /** `manulBrowser.pythonPath` — an interpreter, or a venv folder. */
  python: string;
  /** `manulBrowser.nodePath` */
  node: string;
}

/**
 * The interpreter a Python hook script should run under.
 *
 * The engine takes `python` from PATH unless told otherwise, and the Python on
 * PATH is very often not the one `manul-browser` was installed into. The
 * script then dies on `import manul`, which the engine can only report as a
 * script that exited before saying it was ready. So: the configured
 * interpreter, else the environment the engine itself came from, else the
 * first environment near the script that has the binding.
 */
export function pythonForHooks(
  script: string,
  roots: string[],
  engine: EngineInfo | undefined,
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const setting = configured.trim();
  if (setting) {
    try {
      if (fs.statSync(setting).isDirectory()) return venvPython(setting) ?? undefined;
    } catch {
      // Not on disk: a bare command name, which the engine resolves on PATH.
    }
    return setting;
  }
  if (engine?.python) return engine.python;

  const dirs = new Set<string>();
  if (env.VIRTUAL_ENV) dirs.add(env.VIRTUAL_ENV);
  for (const base of [path.dirname(script), ...roots]) {
    for (const name of VENV_DIRS) dirs.add(path.join(base, name));
  }
  for (const dir of dirs) {
    if (pythonEnvHasBinding(dir)) {
      const py = venvPython(dir);
      if (py) return py;
    }
  }
  return undefined;
}

/** Environment that makes the engine start `script` with the right interpreter. */
export function hookEnvironment(
  script: string,
  roots: string[],
  engine: EngineInfo | undefined,
  settings: InterpreterSettings,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  const runtime = hookRuntime(script);
  if (runtime === 'python') {
    const py = pythonForHooks(script, roots, engine, settings.python, env);
    if (py) out.MANUL_PYTHON = py;
    // A hook script prints to the engine through a pipe; unbuffered output is
    // the difference between a log line now and one at exit.
    out.PYTHONUNBUFFERED = '1';
  } else if (runtime === 'node' && settings.node.trim()) {
    out.MANUL_NODE = settings.node.trim();
  }
  return out;
}

/** Starter text for a new hook script. */
export function hookTemplate(runtime: 'python' | 'node'): string {
  if (runtime === 'python') {
    return [
      '"""Hooks for this suite. Picked up by the Manul Browser extension, or run by',
      'hand with `manul run <hunts> --hooks manul_hooks.py`."""',
      '',
      'import manul',
      '',
      '',
      '@manul.before_all',
      'def prepare(ctx):',
      '    # Runs once, before any hunt and before any browser exists.',
      '    # Whatever is set here is a {placeholder} in every hunt.',
      '    ctx.set("base_url", "https://example.com")',
      '',
      '',
      '@manul.after_all',
      'def cleanup(ctx):',
      '    pass',
      '',
      '',
      '# @manul.call("compute_total")',
      '# def compute_total(ctx):',
      '#     return str(sum(float(a) for a in ctx.args))',
      '',
      '',
      '# The engine talks to this process over stdin/stdout, so this goes last.',
      'manul.serve_hooks()',
      '',
    ].join('\n');
  }
  return [
    '// Hooks for this suite. Picked up by the Manul Browser extension, or run by',
    '// hand with `manul run <hunts> --hooks manul_hooks.mjs`.',
    '',
    "import { beforeAll, afterAll, call, serveHooks } from 'manul-browser';",
    '',
    'beforeAll((ctx) => {',
    '  // Runs once, before any hunt and before any browser exists.',
    '  // Whatever is set here is a {placeholder} in every hunt.',
    "  ctx.variables.base_url = 'https://example.com';",
    '});',
    '',
    'afterAll(() => {});',
    '',
    "// call('compute_total', (ctx) => String(ctx.args.reduce((a, b) => a + Number(b), 0)));",
    '',
    '// The engine talks to this process over stdin/stdout, so this goes last.',
    'await serveHooks();',
    '',
  ].join('\n');
}
