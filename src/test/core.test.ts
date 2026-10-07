import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { loadBundledCatalogue, mergeSchema, syntaxToSnippet } from '../core/catalogue';
import { findEngines, parseFlags, parseVersion, supports } from '../core/engine';
import {
  findHookScript,
  hookEnvironment,
  resolveHookScript,
  scanHookScript,
} from '../core/hooks';
import { StepLocator, formatHunt, parseHunt } from '../core/huntDoc';
import { EXPLAIN_MARKER, LineSplitter, PAUSE_MARKER, buildArgs, parseStdoutLine } from '../core/runner';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manul-ext-'));
}

function touch(file: string, text = ''): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// ── engine ──────────────────────────────────────────────────────────────────

test('an engine is found in each of the three places it can be installed', () => {
  const root = tmp();
  const npm = touch(path.join(root, 'node_modules', '@manul-browser', 'engine-linux-x64', 'bin', 'manul'));
  const py = touch(path.join(root, '.venv', 'lib', 'python3.12', 'site-packages', 'manul', '_bin', 'manul'));
  touch(path.join(root, '.venv', 'bin', 'python3'));
  const go = touch(path.join(root, 'bin', 'manul'));

  const found = findEngines([root], { platform: 'linux', arch: 'x64', env: {}, home: root });
  assert.deepEqual(
    found.map((c) => [c.source, c.path]),
    [
      ['npm', npm],
      ['python', py],
      ['go', go],
    ],
  );
  assert.equal(found[1].python, path.join(root, '.venv', 'bin', 'python3'));
});

test('the Windows layouts are found too', () => {
  const root = tmp();
  const npm = touch(path.join(root, 'node_modules', '@manul-browser', 'engine-win32-x64', 'bin', 'manul.exe'));
  const py = touch(path.join(root, 'venv', 'Lib', 'site-packages', 'manul', '_bin', 'manul.exe'));
  const found = findEngines([root], { platform: 'win32', arch: 'x64', env: {}, home: root });
  assert.deepEqual(found.map((c) => c.path), [npm, py]);
});

test('an explicit engine path comes first', () => {
  const root = tmp();
  touch(path.join(root, 'node_modules', '@manul-browser', 'engine-linux-x64', 'bin', 'manul'));
  const custom = touch(path.join(root, 'tools', 'manul'));
  const found = findEngines([root], { custom: 'tools/manul', platform: 'linux', arch: 'x64', env: {}, home: root });
  assert.equal(found[0].path, custom);
  assert.equal(found[0].source, 'setting');
});

test('npm packages are resolved from parent folders, as Node resolves them', () => {
  const root = tmp();
  const npm = touch(path.join(root, 'node_modules', '@manul-browser', 'engine-darwin-arm64', 'bin', 'manul'));
  const sub = path.join(root, 'packages', 'e2e');
  fs.mkdirSync(sub, { recursive: true });
  const found = findEngines([sub], { platform: 'darwin', arch: 'arm64', env: {}, home: root });
  assert.equal(found[0].path, npm);
});

test('a pip launcher on PATH is resolved to the binary behind it', () => {
  // Laid out for the host platform: PATH is split on the host's separator.
  const win = process.platform === 'win32';
  const root = tmp();
  const env = path.join(root, 'tools-env');
  const scripts = path.join(env, win ? 'Scripts' : 'bin');
  touch(path.join(scripts, win ? 'manul.exe' : 'manul'));
  touch(path.join(scripts, win ? 'python.exe' : 'python3'));
  const site = win ? path.join(env, 'Lib', 'site-packages') : path.join(env, 'lib', 'python3.11', 'site-packages');
  const real = touch(path.join(site, 'manul', '_bin', win ? 'manul.exe' : 'manul'));
  const found = findEngines([path.join(root, 'project')], { env: { PATH: scripts }, home: root });
  assert.equal(found.length, 1);
  assert.equal(found[0].path, real);
  assert.equal(found[0].source, 'python');
});

test('an sdist install has the package and no engine, and is not offered', () => {
  const root = tmp();
  touch(path.join(root, '.venv', 'lib', 'python3.12', 'site-packages', 'manul', '__init__.py'));
  assert.deepEqual(findEngines([root], { platform: 'linux', arch: 'x64', env: {}, home: root }), []);
});

test('version and flags are read from what the engine prints', () => {
  assert.equal(parseVersion('manul 0.1.2\n'), '0.1.2');
  assert.equal(parseVersion('nothing here'), '');
  const flags = parseFlags('usage: manul\n\nFlags:\n  -hooks string\n    \tpath\n  -jsonl\n    \tstream\n');
  assert.ok(flags.has('hooks') && flags.has('jsonl'));
  assert.ok(!flags.has('path'));
});

test('an engine whose help could not be read is assumed to support a flag', () => {
  const base = { path: 'x', source: 'path' as const, detail: '', version: '0.1.0' };
  assert.equal(supports({ ...base, flags: new Set() }, 'hooks'), true);
  assert.equal(supports({ ...base, flags: new Set(['jsonl']) }, 'hooks'), false);
});

// ── hooks ───────────────────────────────────────────────────────────────────

test('the nearest hook script at or above the hunt wins', () => {
  const root = tmp();
  const top = touch(path.join(root, 'manul_hooks.py'));
  const hunt = touch(path.join(root, 'tests', 'checkout', 'pay.hunt'));
  assert.equal(findHookScript(hunt, root), top);

  const near = touch(path.join(root, 'tests', 'checkout', 'manul_hooks.mjs'));
  assert.equal(findHookScript(hunt, root), near);
});

test('the search stops at the workspace root', () => {
  const outer = tmp();
  touch(path.join(outer, 'manul_hooks.py'));
  const root = path.join(outer, 'project');
  const hunt = touch(path.join(root, 'a.hunt'));
  assert.equal(findHookScript(hunt, root), undefined);
});

test('hook pickup can be switched off or pointed at one file', () => {
  const root = tmp();
  touch(path.join(root, 'manul_hooks.py'));
  const other = touch(path.join(root, 'support', 'hooks.py'));
  const hunt = touch(path.join(root, 'a.hunt'));
  assert.equal(resolveHookScript(hunt, root, { enabled: false, path: '' }), undefined);
  assert.equal(resolveHookScript(hunt, root, { enabled: true, path: 'support/hooks.py' }), other);
  assert.equal(resolveHookScript(hunt, root, { enabled: true, path: 'missing.py' }), undefined);
});

test('a Python hook script is read for what it registers', () => {
  const scan = scanHookScript(
    [
      'import manul',
      '',
      '@manul.before_all',
      'def login(ctx):',
      '    ctx.set("token", "x")',
      '',
      '@manul.before_group("smoke")',
      'def seed(ctx): pass',
      '',
      '@manul.custom_control(page="Checkout", target="Signature Pad")',
      'def sign(ctx): pass',
      '',
      "@manul.call('compute_total')",
      'def compute_total(ctx): return "1"',
      '',
      'manul.serve_hooks()',
    ].join('\n'),
    'manul_hooks.py',
  );
  assert.equal(scan.serves, true);
  assert.deepEqual(
    scan.handlers.map((h) => [h.kind, h.name, h.page, h.handler, h.line]),
    [
      ['before_all', '', '', 'login', 2],
      ['before_group', 'smoke', '', 'seed', 6],
      ['custom_control', 'Signature Pad', 'Checkout', 'sign', 9],
      ['call', 'compute_total', '', 'compute_total', 12],
    ],
  );
});

test('a script that never serves is noticed', () => {
  const scan = scanHookScript('import manul\n@manul.before_all\ndef a(ctx): pass\n', 'manul_hooks.py');
  assert.equal(scan.serves, false);
});

test('a JavaScript hook script is read for what it registers', () => {
  const scan = scanHookScript(
    [
      "import { beforeAll, afterGroup, customControl, call, serveHooks } from 'manul-browser';",
      "beforeAll((ctx) => { ctx.variables.token = 'x'; ctx.variables['base_url'] = 'y'; });",
      "afterGroup('smoke', cleanup);",
      "customControl({ page: 'Checkout', target: 'Signature Pad' }, sign);",
      "customControl('Date Picker', (ctx) => {});",
      "call('compute_total', (ctx) => '1');",
      'handler.call(this);',
      'await serveHooks();',
    ].join('\n'),
    'manul_hooks.mjs',
  );
  assert.equal(scan.serves, true);
  assert.deepEqual(scan.variables, ['token', 'base_url']);
  assert.deepEqual(
    scan.handlers.map((h) => [h.kind, h.name, h.page]),
    [
      ['before_all', '', ''],
      ['after_group', 'smoke', ''],
      ['custom_control', 'Signature Pad', 'Checkout'],
      ['custom_control', 'Date Picker', ''],
      ['call', 'compute_total', ''],
    ],
  );
});

test('a Python hook script runs under the interpreter the engine came from', () => {
  const engine = { path: 'e', source: 'python' as const, detail: '', version: '0.1.2', flags: new Set<string>(), python: '/env/bin/python3' };
  const env = hookEnvironment('/p/manul_hooks.py', ['/p'], engine, { python: '', node: '' }, {});
  assert.equal(env.MANUL_PYTHON, '/env/bin/python3');
  const configured = hookEnvironment('/p/manul_hooks.py', ['/p'], engine, { python: 'python3.12', node: '' }, {});
  assert.equal(configured.MANUL_PYTHON, 'python3.12');
});

test('with a standalone engine, the environment that has the binding is used', () => {
  const root = tmp();
  touch(path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3'));
  const site =
    process.platform === 'win32'
      ? path.join(root, '.venv', 'Lib', 'site-packages')
      : path.join(root, '.venv', 'lib', 'python3.12', 'site-packages');
  touch(path.join(site, 'manul', '__init__.py'));
  const env = hookEnvironment(path.join(root, 'manul_hooks.py'), [root], undefined, { python: '', node: '' }, {});
  assert.ok(env.MANUL_PYTHON?.startsWith(path.join(root, '.venv')));
});

// ── hunt documents ──────────────────────────────────────────────────────────

const HUNT = [
  '@context: demo',
  '@title: orders',
  '@tags: smoke, checkout',
  '',
  'STEP 1: Open the app',
  '    NAVIGATE to {base_url}',
  "    FILL 'API token' field with '{token}'",
  "    CLICK 'Sign in' button",
  '',
  'STEP 2: Again',
  '    REPEAT 2 TIMES:',
  "        CLICK 'Sign in' button",
  '    CALL HOST compute_total into {total}',
  'DONE.',
].join('\n');

test('a hunt is outlined into headers, STEP blocks and command lines', () => {
  const o = parseHunt(HUNT);
  assert.equal(o.title, 'orders');
  assert.deepEqual(o.tags, ['smoke', 'checkout']);
  assert.deepEqual(o.steps.map((s) => [s.header, s.line, s.endLine]), [
    ['STEP 1: Open the app', 4, 7],
    ['STEP 2: Again', 9, 12],
  ]);
  assert.equal(o.commands.length, 6);
  assert.deepEqual(o.calls, [{ name: 'compute_total', line: 12 }]);
});

test('reported steps are mapped back to their lines, repeats included', () => {
  const loc = new StepLocator(parseHunt(HUNT));
  assert.equal(loc.locate('NAVIGATE to {base_url}', 'STEP 1: Open the app'), 5);
  assert.equal(loc.locate("CLICK 'Sign in' button", 'STEP 1: Open the app'), 7);
  // The same text in another block, twice: the loop body, both passes.
  assert.equal(loc.locate("CLICK 'Sign in' button", 'STEP 2: Again'), 11);
  assert.equal(loc.locate("CLICK 'Sign in' button", 'STEP 2: Again'), 11);
  assert.equal(loc.locate('no such step'), undefined);
});

test('formatting indents commands and nested blocks', () => {
  const src = [
    '@title: x',
    'STEP 1: A',
    "CLICK 'a'",
    '  IF button \'Save\' exists:',
    "      CLICK 'Save'",
    '# a note at the margin',
    '  ELSE:',
    "      CLICK 'Other'",
    "  CLICK 'after'",
    'DONE.',
  ];
  assert.deepEqual(formatHunt(src), [
    '@title: x',
    'STEP 1: A',
    "    CLICK 'a'",
    "    IF button 'Save' exists:",
    "        CLICK 'Save'",
    '    # a note at the margin',
    '    ELSE:',
    "        CLICK 'Other'",
    "    CLICK 'after'",
    'DONE.',
  ]);
});

test('formatting an already formatted hunt changes nothing', () => {
  const lines = HUNT.split('\n');
  assert.deepEqual(formatHunt(lines), lines);
});

// ── runner ──────────────────────────────────────────────────────────────────

test('arguments carry the hook script and leave out what the engine lacks', () => {
  const engine = { path: 'e', source: 'path' as const, detail: '', version: '0.1.0', flags: new Set(['jsonl', 'headless', 'browser']) };
  const { args, dropped } = buildArgs('a.hunt', { hooks: 'manul_hooks.py', browser: 'firefox', headless: true }, engine);
  assert.deepEqual(args, ['run', 'a.hunt', '--jsonl', '--browser', 'firefox', '--headless']);
  assert.deepEqual(dropped, ['--hooks']);

  const full = buildArgs('a.hunt', { hooks: 'h.py', breakLines: [3, 9], headless: false });
  assert.deepEqual(full.args, ['run', 'a.hunt', '--jsonl', '--headless=false', '--hooks', 'h.py', '--break-lines', '3,9']);
});

test('stdout lines are told apart', () => {
  assert.equal(parseStdoutLine('{"event":"step","data":{"step":"X","success":true}}')?.kind, 'step');
  assert.equal(parseStdoutLine('{"event":"result","data":{"success":false}}')?.kind, 'result');
  const pause = parseStdoutLine(`${PAUSE_MARKER}{"step":"CLICK 'a'","idx":3}`);
  assert.deepEqual(pause, { kind: 'pause', data: { step: "CLICK 'a'", idx: 3 } });
  assert.equal(parseStdoutLine(`${EXPLAIN_MARKER}{"step":"s","score":0.5}`)?.kind, 'explain');
  assert.deepEqual(parseStdoutLine('{not json'), { kind: 'text', data: '{not json' });
  assert.equal(parseStdoutLine(''), undefined);
});

test('lines split across chunks are put back together', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a":'), []);
  assert.deepEqual(s.push('1}\r\n{"b":2}\npart'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(s.flush(), ['part']);
});

// ── catalogue ───────────────────────────────────────────────────────────────

test('the bundled catalogue loads and a newer engine can add to it', () => {
  const cat = loadBundledCatalogue(path.join(__dirname, '..', '..', 'data', 'dsl.json'));
  assert.ok(cat.commands.length > 30);
  const merged = mergeSchema(cat, {
    version: '9.9.9',
    verbs: [
      { verb: 'CLICK', syntax: "Click the '<label>'" },
      { verb: 'TELEPORT', syntax: "TELEPORT to '<place>'", note: 'from a newer engine' },
    ],
  });
  assert.equal(merged.version, '9.9.9');
  assert.equal(merged.commands.length, cat.commands.length + 1);
  assert.equal(merged.commands.at(-1)?.snippet, "TELEPORT to '${1:place}'");
});

test('schema syntax becomes a snippet', () => {
  assert.equal(syntaxToSnippet("Fill '<label>' with '<value>'"), "Fill '${1:label}' with '${2:value}'");
  assert.equal(syntaxToSnippet('Scroll down|up'), 'Scroll ${1|down,up|}');
});
