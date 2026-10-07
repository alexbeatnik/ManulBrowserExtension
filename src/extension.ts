import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { sourceLabel } from './core/engine';
import { hookTemplate } from './core/hooks';
import { grouped } from './core/catalogue';
import { runDoctor } from './doctor';
import { registerLanguage } from './language';
import { Results } from './results';
import { RunService } from './runService';
import { CONFIG, CONFIG_FILE, Services, terminalCommand } from './services';
import { HuntTests } from './testController';
import { Dashboard } from './views/dashboard';
import { HooksTree } from './views/hooksTree';
import { StepPalette } from './views/stepPalette';

const HUNT_TEMPLATE = (title: string): string =>
  [
    `@context: ${title}`,
    `@title: ${title}`,
    '',
    'STEP 1: Open the page',
    '    NAVIGATE to https://example.com',
    "    VERIFY that 'Example Domain' is present",
    '',
    'DONE.',
    '',
  ].join('\n');

/** What activation hands back: the same objects the extension runs on, for tests. */
export interface ManulBrowserApi {
  services: Services;
  runs: RunService;
  tests: HuntTests;
}

export function activate(context: vscode.ExtensionContext): ManulBrowserApi {
  const services = new Services(context);
  const results = new Results(() => services.settings().inlineResults);
  const runs = new RunService(services, results);
  const tests = new HuntTests(services, runs);
  const hooksTree = new HooksTree(services);

  // The hunt the panels talk about: the active one, and still that one after
  // focus moves into a panel and there is no active editor at all.
  let lastHunt: vscode.Uri | undefined;
  const activeHunt = (): vscode.Uri | undefined => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId === 'hunt' && doc.uri.scheme === 'file') lastHunt = doc.uri;
    else if (lastHunt && !fs.existsSync(lastHunt.fsPath)) lastHunt = undefined;
    return lastHunt ?? vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'hunt')?.document.uri;
  };
  /** A command's target: what it was invoked on, else the hunt in view. */
  const targetOf = (arg: unknown): vscode.Uri | undefined => (arg instanceof vscode.Uri ? arg : activeHunt());

  const insertSnippet = async (snippet: string): Promise<void> => {
    const uri = activeHunt();
    if (!uri) {
      void vscode.window.showInformationMessage('Open a .hunt file to insert a step into.');
      return;
    }
    const editor = await vscode.window.showTextDocument(uri, { preview: false });
    const line = editor.document.lineAt(editor.selection.active.line);
    // A step is a line of its own: on a line that already has text, go below it.
    if (line.text.trim() === '') {
      await editor.insertSnippet(new vscode.SnippetString(snippet), line.range);
    } else {
      const indent = line.text.match(/^\s*/)?.[0] ?? '';
      await editor.insertSnippet(new vscode.SnippetString(`\n${indent}${snippet}`), line.range.end);
    }
  };

  const dashboard = new Dashboard(services, runs, activeHunt);
  const palette = new StepPalette(services, insertSnippet);

  // ── Status bar ────────────────────────────────────────────────────────────
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'manulBrowser.selectEngine';
  const refreshStatus = async (): Promise<void> => {
    const uri = activeHunt();
    const root = services.rootFor(uri);
    if (!root) return status.hide();
    if (runs.paused) {
      status.text = '$(debug-pause) Manul: paused';
      status.tooltip = 'F10 next step · F5 continue · Shift+F5 stop';
    } else if (runs.running.length) {
      status.text = `$(sync~spin) Manul: ${runs.running.map((f) => path.basename(f)).join(', ')}`;
      status.tooltip = 'Running — Shift+F5 stops';
    } else {
      const { engine } = await services.engine(root);
      status.text = engine ? `$(beaker) Manul ${engine.version}` : '$(warning) Manul: no engine';
      status.tooltip = engine
        ? `${sourceLabel(engine.source)} engine — ${engine.path}\nClick to choose another`
        : 'No manul engine found. Click to choose one.';
    }
    status.show();
  };

  const terminalFor = (name: string, cwd: string, env: Record<string, string> = {}): vscode.Terminal => {
    vscode.window.terminals.find((t) => t.name === name)?.dispose();
    return vscode.window.createTerminal({ name, cwd, env });
  };

  const engineOrWarn = async (uri?: vscode.Uri): Promise<{ root: string; exe: string } | undefined> => {
    const root = services.rootFor(uri);
    if (!root) {
      void vscode.window.showWarningMessage('Open a folder first.');
      return undefined;
    }
    const { engine } = await services.engine(root);
    if (!engine) {
      const pick = await vscode.window.showWarningMessage(
        'No manul engine found. Install manul-browser with npm or pip in this folder, or choose a binary.',
        'Choose Engine',
        'Check Setup',
      );
      if (pick === 'Choose Engine') void vscode.commands.executeCommand('manulBrowser.selectEngine');
      if (pick === 'Check Setup') void vscode.commands.executeCommand('manulBrowser.doctor');
      return undefined;
    }
    return { root, exe: engine.path };
  };

  const runFile = async (arg: unknown, debug: boolean): Promise<void> => {
    const uri = targetOf(arg);
    if (!uri) return void vscode.window.showInformationMessage('Open a .hunt file to run.');
    if (!(await engineOrWarn(uri))) return;
    await tests.runFile(uri, debug);
    const last = runs.last;
    if (last?.file === uri.fsPath && last.outcome.error) {
      const pick = await vscode.window.showErrorMessage(last.outcome.error, 'Show Output', 'Check Setup');
      if (pick === 'Show Output') services.output.show(true);
      if (pick === 'Check Setup') void vscode.commands.executeCommand('manulBrowser.doctor');
    }
  };

  const testsHome = (root: string): string => {
    const setting = services.settings(vscode.Uri.file(root)).testsHome.trim();
    if (setting) return path.resolve(root, setting);
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8')) as { tests_home?: string };
      if (cfg.tests_home) return path.resolve(root, cfg.tests_home);
    } catch {
      // No config, or not JSON: the default below.
    }
    return path.join(root, 'tests');
  };

  const askUrl = (title: string): Thenable<string | undefined> =>
    vscode.window.showInputBox({
      title,
      prompt: 'Address of the page',
      placeHolder: 'https://example.com',
      validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : 'Enter a full http:// or https:// address'),
    });

  const register = (id: string, fn: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(`manulBrowser.${id}`, fn));
  };

  register('runFile', (arg) => runFile(arg, false));
  register('debugFile', (arg) => runFile(arg, true));
  register('stop', () => runs.stopAll());
  register('debugNext', () => runs.debug('next'));
  register('debugContinue', () => runs.debug('continue'));
  register('debugExplain', () => runs.debug('explain-next'));
  register('debugHighlight', () => runs.debug('highlight'));
  register('showOutput', () => services.output.show(true));
  register('clearResults', () => results.clear());
  register('refreshHooks', () => hooksTree.refresh());
  register('doctor', () => runDoctor(services, activeHunt()));

  register('runInTerminal', async (arg) => {
    const uri = targetOf(arg);
    if (!uri || !(await engineOrWarn(uri))) return;
    const inv = await runs.terminalInvocation(uri);
    if (!inv) return;
    const terminal = terminalFor('Manul', inv.cwd, inv.env);
    terminal.show();
    terminal.sendText(terminalCommand(inv.exe, inv.args));
  });

  register('toggleHooks', async () => {
    const uri = activeHunt();
    const c = vscode.workspace.getConfiguration(CONFIG, uri);
    const now = !c.get('hooks.enabled', true);
    await c.update(
      'hooks.enabled',
      now,
      vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
    );
    void vscode.window.setStatusBarMessage(`Manul: hook pickup ${now ? 'on' : 'off'}`, 3000);
  });

  register('openHooks', async () => {
    const uri = activeHunt();
    const hooks = uri ? services.hooksFor(uri) : undefined;
    if (hooks) await vscode.window.showTextDocument(vscode.Uri.file(hooks.script));
  });

  register('createHooks', async () => {
    const hunt = activeHunt();
    const root = services.rootFor(hunt);
    if (!root) return void vscode.window.showWarningMessage('Open a folder first.');
    const { engine } = await services.engine(root);
    const picks: Array<vscode.QuickPickItem & { runtime: 'python' | 'node'; file: string }> = [
      { label: 'Python', description: 'manul_hooks.py', detail: 'Uses the manul-browser package from PyPI', runtime: 'python', file: 'manul_hooks.py' },
      { label: 'JavaScript', description: 'manul_hooks.mjs', detail: 'Uses the manul-browser package from npm', runtime: 'node', file: 'manul_hooks.mjs' },
    ];
    // Offer first the language the engine was installed with.
    if (engine?.source === 'npm') picks.reverse();
    const pick = await vscode.window.showQuickPick(picks, { title: 'Create a hook script', placeHolder: 'Language of the script' });
    if (!pick) return;
    const file = path.join(root, pick.file);
    if (!fs.existsSync(file)) fs.writeFileSync(file, hookTemplate(pick.runtime));
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    hooksTree.refresh();
    services.notifyChanged();
  });

  register('newHunt', async () => {
    const root = services.rootFor(activeHunt());
    if (!root) return void vscode.window.showWarningMessage('Open a folder first.');
    const name = await vscode.window.showInputBox({
      title: 'New hunt file',
      prompt: 'Name of the hunt',
      placeHolder: 'checkout',
      validateInput: (v) => (/^[\w][\w .-]*$/.test(v.trim()) ? undefined : 'Use letters, digits, spaces, dots, dashes or underscores'),
    });
    if (!name) return;
    const base = name.trim().replace(/\.hunt$/i, '');
    const dir = testsHome(root);
    const file = path.join(dir, `${base.replace(/\s+/g, '_')}.hunt`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, HUNT_TEMPLATE(base));
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  });

  const draftFromUrl = async (verb: 'record' | 'scan', title: string): Promise<void> => {
    const found = await engineOrWarn(activeHunt());
    if (!found) return;
    const url = await askUrl(title);
    if (!url) return;
    let host = 'page';
    try {
      host = new URL(url.trim()).hostname.replace(/^www\./, '').replace(/[^\w.-]/g, '_') || 'page';
    } catch {
      // The input box already checked the shape; keep the fallback name.
    }
    const dir = testsHome(found.root);
    fs.mkdirSync(dir, { recursive: true });
    let out = path.join(dir, `${host}.hunt`);
    for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${host}_${n}.hunt`);
    const rel = path.relative(found.root, out);
    const args = verb === 'record' ? ['record', url.trim(), rel] : ['scan', url.trim(), '--output', rel];
    const terminal = terminalFor(verb === 'record' ? 'Manul Record' : 'Manul Scan', found.root);
    terminal.show();
    terminal.sendText(terminalCommand(found.exe, args));
  };
  register('record', () => draftFromUrl('record', 'Record a hunt'));
  register('scan', () => draftFromUrl('scan', 'Scan a page into a draft hunt'));

  register('insertStep', async () => {
    const items = grouped(services.catalogue).flatMap((g) => [
      { label: g.title, kind: vscode.QuickPickItemKind.Separator, snippet: '' },
      ...g.entries.map((e) => ({ label: e.uiText, description: e.label, detail: e.description, snippet: e.snippet })),
    ]);
    const pick = await vscode.window.showQuickPick(items, { title: 'Insert step', matchOnDescription: true, matchOnDetail: true });
    if (pick?.snippet) await insertSnippet(pick.snippet);
  });

  register('selectEngine', async () => {
    const uri = activeHunt();
    const root = services.rootFor(uri);
    if (!root) return void vscode.window.showWarningMessage('Open a folder first.');
    const current = services.settings(uri).enginePath.trim();
    type Pick = vscode.QuickPickItem & { action: 'auto' | 'browse' | 'use'; path?: string };
    const picks: Pick[] = [
      { label: '$(search) Find automatically', description: current ? '' : 'current', detail: 'npm package, Python environment, workspace binary, Go bin, then PATH', action: 'auto' },
      ...services.candidates(root).map((c): Pick => ({
        label: `$(server-process) ${sourceLabel(c.source)}`,
        description: c.path === current ? 'current' : '',
        detail: c.path,
        action: 'use',
        path: c.path,
      })),
      { label: '$(folder-opened) Browse for a binary…', action: 'browse' },
    ];
    const pick = await vscode.window.showQuickPick(picks, { title: 'Manul engine', placeHolder: 'Which engine should run hunts in this workspace?' });
    if (!pick) return;
    let value = '';
    if (pick.action === 'use') value = pick.path ?? '';
    if (pick.action === 'browse') {
      const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Select the manul binary', openLabel: 'Use this engine' });
      if (!chosen?.length) return;
      value = chosen[0].fsPath;
    }
    await vscode.workspace
      .getConfiguration(CONFIG, uri)
      .update('enginePath', value || undefined, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    services.invalidate();
  });

  register('openReport', async () => {
    const root = services.rootFor(activeHunt());
    const report = root ? path.join(root, 'reports', 'manul_report.html') : '';
    if (!report || !fs.existsSync(report)) {
      return void vscode.window.showInformationMessage('No report yet. Turn on "Write an HTML report" and run a hunt.');
    }
    await vscode.env.openExternal(vscode.Uri.file(report));
  });

  register('openConfig', async () => {
    const root = services.rootFor(activeHunt());
    if (!root) return void vscode.window.showWarningMessage('Open a folder first.');
    const file = path.join(root, CONFIG_FILE);
    if (!fs.existsSync(file)) {
      const defaults = { browser: 'chromium', headless: false, timeout: 5000, nav_timeout: 30000, tests_home: 'tests', screenshot: 'on-fail' };
      fs.writeFileSync(file, `${JSON.stringify(defaults, null, 2)}\n`);
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  });

  // ── Wiring ────────────────────────────────────────────────────────────────
  const packages = vscode.workspace.createFileSystemWatcher(
    '**/{node_modules/@manul-browser,node_modules/manul-browser,site-packages/manul}/**',
  );
  let reinstall: NodeJS.Timeout | undefined;
  // An install touches hundreds of files; look again once it has gone quiet.
  const installed = (): void => {
    if (reinstall) clearTimeout(reinstall);
    reinstall = setTimeout(() => services.invalidate(), 1500);
  };

  context.subscriptions.push(
    services,
    results,
    runs,
    tests,
    hooksTree,
    dashboard,
    palette,
    status,
    packages,
    packages.onDidCreate(installed),
    packages.onDidDelete(installed),
    vscode.window.registerWebviewViewProvider(Dashboard.id, dashboard),
    vscode.window.registerWebviewViewProvider(StepPalette.id, palette),
    vscode.window.registerTreeDataProvider('manulBrowser.hooks', hooksTree),
    ...registerLanguage(services),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG)) return;
      if (
        e.affectsConfiguration(`${CONFIG}.enginePath`) ||
        e.affectsConfiguration(`${CONFIG}.pythonPath`)
      ) {
        services.invalidate();
      } else {
        services.notifyChanged();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => services.invalidate()),
    vscode.window.onDidChangeActiveTextEditor(() => void refreshStatus()),
    services.onDidChange(() => void refreshStatus()),
    runs.onDidChange(() => void refreshStatus()),
  );

  void refreshStatus();
  return { services, runs, tests };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions; RunService stops
  // any engine still running on the way out.
}
