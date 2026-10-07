// What the two webview panels share: the page shell and its styling. Colours
// and fonts come from the theme's own variables, so the panels look like part
// of whichever theme is active rather than like a page inside it.

import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export const BASE_CSS = `
  :root { --gap: 10px; --radius: 6px; }
  * { box-sizing: border-box; }
  body {
    padding: 0 12px 16px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.45;
  }
  h2 {
    margin: 16px 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
  }
  .card {
    padding: 10px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent));
    border-radius: var(--radius);
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  }
  .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .row + .row { margin-top: 8px; }
  .grow { flex: 1; min-width: 0; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: .92em; }
  .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mono { font-family: var(--vscode-editor-font-family); }
  .wrap { overflow-wrap: anywhere; }
  button {
    font: inherit;
    padding: 4px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.link {
    padding: 0; border: 0; background: none;
    color: var(--vscode-textLink-foreground);
  }
  button.link:hover { background: none; text-decoration: underline; }
  button:focus-visible, select:focus-visible, input:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
  }
  button:disabled { opacity: .5; cursor: default; }
  .buttons { display: flex; flex-wrap: wrap; gap: 6px; }
  .buttons button { flex: 1 1 auto; }
  select, input[type="number"], input[type="search"] {
    font: inherit;
    padding: 3px 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    min-width: 0;
  }
  input[type="number"] { width: 4.5em; }
  label.field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  label.field + label.field { margin-top: 7px; }
  label.check { display: flex; align-items: center; gap: 6px; margin-top: 7px; cursor: pointer; }
  .pill {
    display: inline-block;
    padding: 0 7px;
    border-radius: 9px;
    font-size: .85em;
    font-weight: 600;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    white-space: nowrap;
  }
  .pill.pass { color: var(--vscode-editor-background); background: var(--vscode-testing-iconPassed); }
  .pill.fail { color: var(--vscode-editor-background); background: var(--vscode-testing-iconFailed); }
  .pill.warn { color: var(--vscode-editor-background); background: var(--vscode-testing-iconQueued, var(--vscode-editorWarning-foreground)); }
  .note {
    margin-top: 8px;
    padding: 6px 8px;
    border-left: 3px solid var(--vscode-editorWarning-foreground);
    background: var(--vscode-inputValidation-warningBackground, transparent);
    border-radius: 0 3px 3px 0;
  }
  [hidden] { display: none !important; }
`;

export function page(webview: vscode.Webview, body: string, css: string, script: string): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${n}'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${n}">${BASE_CSS}${css}</style>
</head>
<body>
${body}
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
${script}
</script>
</body>
</html>`;
}
