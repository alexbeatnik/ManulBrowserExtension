// Check Setup: everything a run depends on, checked one by one and said in
// plain words. Most "it does not work" reports are one of these lines.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { probeEngine, sourceLabel } from './core/engine';
import { hookEnvironment, hookRuntime } from './core/hooks';
import { CONFIG_FILE, Services } from './services';

function exec(file: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export async function runDoctor(services: Services, hunt?: vscode.Uri): Promise<void> {
  const out = services.output;
  const ok = (s: string): void => out.appendLine(`  ✓ ${s}`);
  const bad = (s: string): void => out.appendLine(`  ✗ ${s}`);
  const info = (s: string): void => out.appendLine(`    ${s}`);
  let problems = 0;

  out.show(true);
  out.appendLine('');
  out.appendLine('── Manul Browser: setup check ─────────────────────────────');

  const root = services.rootFor(hunt);
  if (!root) {
    bad('No folder is open. Open the folder that holds your .hunt files.');
    return;
  }
  out.appendLine(`Folder: ${root}`);

  // Engine
  out.appendLine('');
  out.appendLine('Engine');
  services.invalidate();
  const candidates = services.candidates(root);
  if (candidates.length === 0) {
    problems++;
    bad('No manul engine found.');
    info('Install one in this folder:  npm install manul-browser   or   pip install manul-browser');
    info('Or download a release and set manulBrowser.enginePath.');
  }
  let first = true;
  for (const c of candidates) {
    try {
      const e = await probeEngine(c);
      ok(`${e.version} from ${sourceLabel(e.source)}${first ? '  ← used' : ''}`);
      info(e.path);
      if (first) {
        for (const [flag, what] of [
          ['jsonl', 'steps cannot be reported one by one'],
          ['hooks', 'hook scripts cannot be used'],
          ['break-lines', 'breakpoints cannot be used'],
        ]) {
          if (e.flags.size > 0 && !e.flags.has(flag)) {
            problems++;
            bad(`This engine has no --${flag}: ${what}. Update manul-browser.`);
          }
        }
      }
      first = false;
    } catch (err) {
      problems++;
      bad(`${c.path} does not run: ${(err as Error).message}`);
    }
  }
  const { engine } = await services.engine(root);

  // Hooks
  out.appendLine('');
  out.appendLine('Hooks');
  const settings = services.settings(hunt ?? vscode.Uri.file(root));
  const target = hunt ?? vscode.Uri.file(path.join(root, 'x.hunt'));
  const hooks = services.hooksFor(target);
  if (!settings.hooksEnabled) {
    info('Pickup is off (manulBrowser.hooks.enabled).');
  } else if (settings.hooksPath && !hooks) {
    problems++;
    bad(`manulBrowser.hooks.path is "${settings.hooksPath}", and there is no such file.`);
  } else if (!hooks) {
    info(`No hook script at or above ${hunt ? services.relative(hunt.fsPath) : 'the folder'}. That is fine unless hunts use CALL, custom controls or suite hooks.`);
  } else {
    ok(`${services.relative(hooks.script)} — ${hooks.scan.handlers.length} registration(s) read from it`);
    const runtime = hookRuntime(hooks.script);
    if (!hooks.scan.serves) {
      problems++;
      bad(`It never calls ${runtime === 'python' ? 'manul.serve_hooks()' : 'serveHooks()'}. The engine starts the script and waits for it to answer; add the call as the last line.`);
    }
    const env = hookEnvironment(hooks.script, [root], engine, { python: settings.pythonPath, node: settings.nodePath });
    const cwd = path.dirname(hooks.script);
    if (runtime === 'python') {
      const py = env.MANUL_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
      const res = await exec(py, ['-c', 'import manul; print(manul.__version__)'], cwd);
      if (res.ok) ok(`Python: ${py} — manul ${res.out.split(/\r?\n/).pop()}`);
      else {
        problems++;
        bad(`Python: ${py} cannot import manul.`);
        info(`Install it there (${py} -m pip install manul-browser) or set manulBrowser.pythonPath to an interpreter that has it.`);
        if (res.out) info(res.out.split(/\r?\n/).pop() ?? '');
      }
    } else if (runtime === 'node') {
      const node = env.MANUL_NODE ?? 'node';
      // Imported, not resolved: the package is ESM and exports only its entry
      // point, and an import is what the hook script itself will do.
      const res = await exec(node, ['--input-type=module', '-e', "await import('manul-browser'); console.log('ok')"], cwd);
      if (res.ok) ok(`Node: ${node} — manul-browser can be imported`);
      else {
        problems++;
        bad(`Node: ${node} cannot resolve manul-browser from ${cwd}.`);
        info('Install it in this project: npm install manul-browser');
      }
    }
  }

  // Config
  out.appendLine('');
  out.appendLine('Configuration');
  const configFile = path.join(root, CONFIG_FILE);
  if (fs.existsSync(configFile)) {
    try {
      JSON.parse(fs.readFileSync(configFile, 'utf8'));
      ok(`${CONFIG_FILE} is valid JSON`);
    } catch (err) {
      problems++;
      bad(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
    }
  } else {
    info(`No ${CONFIG_FILE}; the engine's defaults apply.`);
  }
  const hunts = await vscode.workspace.findFiles('**/*.hunt', '**/node_modules/**', 500);
  info(`${hunts.length}${hunts.length === 500 ? '+' : ''} hunt file(s) in the workspace.`);

  out.appendLine('');
  out.appendLine(problems === 0 ? 'Everything a run needs is in place.' : `${problems} problem(s) found — see ✗ above.`);
  services.notifyChanged();
}
