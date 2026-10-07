// The Hooks view: every hook script in the workspace and what it registers.

import * as path from 'path';
import * as vscode from 'vscode';

import { HOOK_BASENAMES, HookHandler, HookKind, describeHandler, hookRuntime } from '../core/hooks';
import { EXCLUDE_GLOB, HookInfo, Services } from '../services';

type Node =
  | { type: 'script'; info: HookInfo; active: boolean }
  | { type: 'group'; info: HookInfo; title: string; kinds: HookKind[] }
  | { type: 'handler'; info: HookInfo; handler: HookHandler }
  | { type: 'note'; info: HookInfo; text: string; icon: string };

const GROUPS: Array<{ title: string; kinds: HookKind[]; icon: string }> = [
  { title: 'Suite hooks', kinds: ['before_all', 'before_group', 'after_group', 'after_all'], icon: 'symbol-event' },
  { title: 'CALL handlers', kinds: ['call'], icon: 'symbol-function' },
  { title: 'Custom controls', kinds: ['custom_control'], icon: 'symbol-interface' },
];

export class HooksTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly services: Services) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/manul_hooks*');
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate(() => this.refresh()),
      watcher.onDidChange(() => this.refresh()),
      watcher.onDidDelete(() => this.refresh()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (path.basename(doc.fileName).startsWith('manul_hooks') || this.isConfigured(doc.fileName)) this.refresh();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      services.onDidChange(() => this.refresh()),
    );
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.changed.dispose();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  private isConfigured(file: string): boolean {
    const configured = this.services.settings(vscode.Uri.file(file)).hooksPath.trim();
    return configured !== '' && path.basename(configured) === path.basename(file);
  }

  /** Every hook script in the workspace, the configured one included. */
  async scripts(): Promise<string[]> {
    const found = await vscode.workspace.findFiles(`**/{${HOOK_BASENAMES.join(',')}}`, EXCLUDE_GLOB, 50);
    const files = new Set(found.map((u) => u.fsPath));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const configured = this.services.settings(folder.uri).hooksPath.trim();
      if (configured) files.add(path.resolve(folder.uri.fsPath, configured));
    }
    return [...files].sort();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      const editor = vscode.window.activeTextEditor;
      const activeScript =
        editor?.document.languageId === 'hunt' ? this.services.hooksFor(editor.document.uri)?.script : undefined;
      return (await this.scripts()).map((script) => ({
        type: 'script',
        info: this.services.readHooks(script),
        active: script === activeScript,
      }));
    }
    if (node.type === 'script') {
      const { scan, script } = node.info;
      const out: Node[] = [];
      if (!scan.serves) {
        const call = hookRuntime(script) === 'python' ? 'manul.serve_hooks()' : 'serveHooks()';
        out.push({ type: 'note', info: node.info, icon: 'warning', text: `Never calls ${call} — the engine gets no answer` });
      }
      for (const g of GROUPS) {
        if (scan.handlers.some((h) => g.kinds.includes(h.kind))) {
          out.push({ type: 'group', info: node.info, title: g.title, kinds: g.kinds });
        }
      }
      if (scan.variables.length) {
        out.push({ type: 'note', info: node.info, icon: 'symbol-variable', text: `Publishes ${scan.variables.map((v) => `{${v}}`).join(', ')}` });
      }
      if (out.length === 0) {
        out.push({ type: 'note', info: node.info, icon: 'info', text: 'Nothing registered that can be read from the file' });
      }
      return out;
    }
    if (node.type === 'group') {
      return node.info.scan.handlers
        .filter((h) => node.kinds.includes(h.kind))
        .map((handler) => ({ type: 'handler', info: node.info, handler }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const uri = vscode.Uri.file(node.info.script);
    if (node.type === 'script') {
      const item = new vscode.TreeItem(this.services.relative(node.info.script), vscode.TreeItemCollapsibleState.Expanded);
      const runtime = hookRuntime(node.info.script);
      const settings = this.services.settings(uri);
      item.description = [
        runtime === 'python' ? 'Python' : runtime === 'node' ? 'Node' : 'executable',
        !settings.hooksEnabled ? 'pickup off' : node.active ? 'used by this hunt' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      item.iconPath = new vscode.ThemeIcon(
        'plug',
        node.active && settings.hooksEnabled ? new vscode.ThemeColor('testing.iconPassed') : undefined,
      );
      item.resourceUri = uri;
      item.contextValue = 'hookScript';
      item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
      item.tooltip = node.info.script;
      return item;
    }
    if (node.type === 'group') {
      const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(GROUPS.find((g) => g.title === node.title)?.icon ?? 'symbol-misc');
      return item;
    }
    if (node.type === 'note') {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.text;
      return item;
    }
    const h = node.handler;
    const item = new vscode.TreeItem(describeHandler(h), vscode.TreeItemCollapsibleState.None);
    item.description = h.handler ? `${h.handler}()` : '';
    item.iconPath = new vscode.ThemeIcon(h.kind === 'call' ? 'symbol-function' : h.kind === 'custom_control' ? 'symbol-interface' : 'symbol-event');
    item.command = {
      command: 'vscode.open',
      title: 'Go to Handler',
      arguments: [uri, { selection: new vscode.Range(h.line, 0, h.line, 0) }],
    };
    return item;
  }
}
