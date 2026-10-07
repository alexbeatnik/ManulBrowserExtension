// The Step Palette: every command the engine understands, searchable, one
// click from the cursor.

import * as vscode from 'vscode';

import { grouped } from '../core/catalogue';
import { Services } from '../services';
import { page } from './webview';

const CSS = `
  .search { position: sticky; top: 0; padding: 8px 0 6px; background: var(--vscode-sideBar-background); z-index: 1; }
  .search input { width: 100%; }
  .item {
    display: block; width: 100%; text-align: left;
    margin: 0 0 4px; padding: 5px 8px;
    border: 1px solid transparent;
    background: var(--vscode-editorWidget-background, transparent);
    color: var(--vscode-foreground);
    white-space: normal;
  }
  .item:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
  .item code { font-family: var(--vscode-editor-font-family); font-size: .95em; color: var(--vscode-textPreformat-foreground, inherit); }
  .item .desc {
    margin-top: 2px; font-size: .9em; color: var(--vscode-descriptionForeground);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .live { margin-left: 6px; }
  #empty { margin-top: 12px; }
`;

const BODY = `
<div class="search"><input type="search" id="q" placeholder="Search steps — click, verify, wait…" aria-label="Search steps"></div>
<div id="list"></div>
<div id="empty" class="muted" hidden>Nothing matches.</div>
<div id="version" class="muted small" style="margin-top:10px"></div>
`;

const SCRIPT = `
let groups = [];
function render() {
  const q = $('q').value.trim().toLowerCase();
  let html = '';
  for (const g of groups) {
    const items = g.entries.filter((e) => !q || (e.label + ' ' + e.uiText + ' ' + e.description).toLowerCase().includes(q));
    if (!items.length) continue;
    html += '<h2>' + esc(g.title) + '</h2>';
    for (const e of items) {
      html += '<button class="item" data-id="' + esc(e.id) + '" title="' + esc(e.description) + '">'
        + '<code>' + esc(e.uiText) + '</code>'
        + (e.live ? '<span class="pill live" title="Reported by the installed engine">engine</span>' : '')
        + (e.description ? '<div class="desc">' + esc(e.description) + '</div>' : '')
        + '</button>';
    }
  }
  $('list').innerHTML = html;
  $('empty').hidden = html !== '';
}
$('q').addEventListener('input', render);
$('list').addEventListener('click', (e) => {
  const el = e.target.closest('[data-id]');
  if (el) vscode.postMessage({ type: 'insert', id: el.dataset.id });
});
window.addEventListener('message', ({ data }) => {
  groups = data.groups;
  $('version').textContent = data.version ? 'Commands for engine ' + data.version : '';
  render();
});
vscode.postMessage({ type: 'ready' });
`;

export class StepPalette implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'manulBrowser.steps';
  private view?: vscode.WebviewView;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly services: Services,
    private readonly insert: (snippet: string) => Thenable<unknown>,
  ) {
    this.subscription = services.onDidChange(() => this.push());
  }

  dispose(): void {
    this.subscription.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = page(view.webview, BODY, CSS, SCRIPT);
    view.webview.onDidReceiveMessage((msg: { type: string; id?: string }) => {
      if (msg.type === 'ready') return this.push();
      if (msg.type === 'insert' && msg.id) {
        const cat = this.services.catalogue;
        const entry = [...cat.commands, ...cat.metadata, ...cat.blocks].find((e) => e.id === msg.id);
        if (entry) void this.insert(entry.snippet);
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private push(): void {
    const cat = this.services.catalogue;
    void this.view?.webview.postMessage({ groups: grouped(cat), version: cat.version });
  }
}
