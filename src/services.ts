// What every part of the extension shares: settings, the resolved engine, the
// command catalogue and the output channel.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Catalogue, loadBundledCatalogue, mergeSchema } from './core/catalogue';
import { EngineCandidate, EngineInfo, findEngines, resolveEngine } from './core/engine';
import { HookScan, hookRuntime, resolveHookScript, scanHookScript } from './core/hooks';

export const CONFIG = 'manulBrowser';
export const CONFIG_FILE = 'manul.config.json';
export const EXCLUDE_GLOB = '**/{node_modules,.venv,venv,env,.git,dist,out}/**';

export interface Settings {
  enginePath: string;
  pythonPath: string;
  nodePath: string;
  hooksEnabled: boolean;
  hooksPath: string;
  browser: string;
  channel: string;
  headless: boolean | undefined;
  retries: number;
  screenshot: string;
  htmlReport: boolean;
  explain: boolean;
  workers: number;
  extraArgs: string[];
  env: Record<string, string>;
  testsHome: string;
  inlineResults: boolean;
}

export interface Resolution {
  engine?: EngineInfo;
  candidates: EngineCandidate[];
  failures: string[];
}

export interface HookInfo {
  script: string;
  scan: HookScan;
}

const orConfig = (v: string): string => (v === 'config' ? '' : v);

export class Services implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('Manul Browser');
  catalogue: Catalogue;

  private readonly resolutions = new Map<string, Promise<Resolution>>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the engine, the catalogue or a setting that affects runs changes. */
  readonly onDidChange = this.changed.event;

  constructor(readonly context: vscode.ExtensionContext) {
    this.catalogue = loadBundledCatalogue(path.join(context.extensionPath, 'data', 'dsl.json'));
  }

  dispose(): void {
    this.output.dispose();
    this.changed.dispose();
  }

  notifyChanged(): void {
    this.changed.fire();
  }

  settings(scope?: vscode.Uri): Settings {
    const c = vscode.workspace.getConfiguration(CONFIG, scope);
    const headless = c.get<string>('run.headless', 'config');
    return {
      enginePath: c.get('enginePath', ''),
      pythonPath: c.get('pythonPath', ''),
      nodePath: c.get('nodePath', ''),
      hooksEnabled: c.get('hooks.enabled', true),
      hooksPath: c.get('hooks.path', ''),
      browser: orConfig(c.get('run.browser', 'config')),
      channel: c.get('run.channel', ''),
      headless: headless === 'on' ? true : headless === 'off' ? false : undefined,
      retries: c.get('run.retries', 0),
      screenshot: orConfig(c.get('run.screenshot', 'config')),
      htmlReport: c.get('run.htmlReport', false),
      explain: c.get('run.explain', false),
      workers: Math.max(1, c.get('run.workers', 1)),
      extraArgs: c.get<string[]>('run.extraArgs', []),
      env: c.get<Record<string, string>>('run.env', {}),
      testsHome: c.get('testsHome', ''),
      inlineResults: c.get('inlineResults', true),
    };
  }

  /** The folder a file's runs happen in: its workspace folder, else its own. */
  rootFor(uri?: vscode.Uri): string | undefined {
    if (uri) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder) return folder.uri.fsPath;
      if (uri.scheme === 'file') return path.dirname(uri.fsPath);
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** The engine for one root. Looked up once, until something invalidates it. */
  engine(root: string): Promise<Resolution> {
    let pending = this.resolutions.get(root);
    if (!pending) {
      const s = this.settings(vscode.Uri.file(root));
      pending = resolveEngine([root], { custom: s.enginePath, python: s.pythonPath }).then((res) => {
        if (res.engine) void this.refreshCatalogue(res.engine);
        return res;
      });
      this.resolutions.set(root, pending);
    }
    return pending;
  }

  candidates(root: string): EngineCandidate[] {
    const s = this.settings(vscode.Uri.file(root));
    return findEngines([root], { custom: s.enginePath, python: s.pythonPath });
  }

  /** Forget what was resolved — after an install, or a change of settings. */
  invalidate(): void {
    this.resolutions.clear();
    this.changed.fire();
  }

  /** Ask the installed engine what it understands and add it to the catalogue. */
  private refreshCatalogue(engine: EngineInfo): Promise<void> {
    return new Promise((resolve) => {
      execFile(engine.path, ['schema'], { timeout: 8000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => {
        if (!err) {
          try {
            this.catalogue = mergeSchema(
              loadBundledCatalogue(path.join(this.context.extensionPath, 'data', 'dsl.json')),
              JSON.parse(stdout),
            );
            this.changed.fire();
          } catch {
            // An engine without `schema`, or one that printed something else:
            // the bundled catalogue stands.
          }
        }
        resolve();
      });
    });
  }

  /** The hook script a run of `hunt` would be given, with what it registers. */
  hooksFor(hunt: vscode.Uri): HookInfo | undefined {
    const root = this.rootFor(hunt);
    if (!root) return undefined;
    const s = this.settings(hunt);
    const script = resolveHookScript(hunt.fsPath, root, { enabled: s.hooksEnabled, path: s.hooksPath });
    return script ? this.readHooks(script) : undefined;
  }

  readHooks(script: string): HookInfo {
    let text = '';
    try {
      if (hookRuntime(script) !== 'native') text = fs.readFileSync(script, 'utf8');
    } catch {
      // Unreadable is reported as "registers nothing we can see".
    }
    return { script, scan: scanHookScript(text, script) };
  }

  /** A path as a person would write it: relative to its workspace folder. */
  relative(file: string): string {
    return vscode.workspace.asRelativePath(file, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
  }

  log(line: string): void {
    this.output.appendLine(line);
  }
}

/** Quote a command for the user's terminal, PowerShell included. */
export function terminalCommand(exe: string, args: string[]): string {
  const shell = (vscode.env.shell || '').toLowerCase();
  const powershell = /pwsh|powershell/.test(shell);
  const cmd = /cmd\.exe$/.test(shell);
  const quote = (a: string): string => {
    if (/^[\w./:=@,+-]+$/.test(a)) return a;
    if (powershell) return `'${a.replace(/'/g, "''")}'`;
    if (cmd) return `"${a.replace(/"/g, '""')}"`;
    return `'${a.replace(/'/g, `'\\''`)}'`;
  };
  const line = [exe, ...args].map(quote).join(' ');
  // PowerShell runs a quoted path only behind the call operator.
  return powershell && line.startsWith("'") ? `& ${line}` : line;
}
