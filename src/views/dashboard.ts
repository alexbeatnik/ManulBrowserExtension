// The Run panel: which engine, which hooks, how to run, and what happened.

import * as path from 'path';
import * as vscode from 'vscode';

import { sourceLabel } from '../core/engine';
import { hookRuntime } from '../core/hooks';
import { parseHunt } from '../core/huntDoc';
import { formatDuration } from '../core/runner';
import { RunService } from '../runService';
import { CONFIG, Services } from '../services';
import { page } from './webview';

const SETTING_KEYS = new Set([
  'run.browser',
  'run.headless',
  'run.screenshot',
  'run.retries',
  'run.htmlReport',
  'run.explain',
  'run.workers',
  'hooks.enabled',
]);

const COMMANDS = new Set([
  'runFile',
  'debugFile',
  'stop',
  'debugNext',
  'debugContinue',
  'debugExplain',
  'debugHighlight',
  'selectEngine',
  'doctor',
  'newHunt',
  'record',
  'scan',
  'openConfig',
  'openReport',
  'showOutput',
  'createHooks',
  'openHooks',
  'clearResults',
]);

const BODY = `
<h2>Engine</h2>
<div class="card">
  <div class="row">
    <span id="engineVersion" class="pill"></span>
    <span id="engineSource" class="grow ellipsis"></span>
    <button class="link" data-cmd="selectEngine">Change</button>
  </div>
  <div id="enginePath" class="muted small mono wrap" style="margin-top:6px"></div>
  <div id="engineMissing" class="note" hidden>
    No engine found. Install one in this project —
    <span class="mono">npm install manul-browser</span> or
    <span class="mono">pip install manul-browser</span> — or point to a binary.
    <div class="buttons" style="margin-top:8px">
      <button data-cmd="selectEngine">Choose a binary</button>
      <button data-cmd="doctor">Check setup</button>
    </div>
  </div>
</div>

<h2>Hunt</h2>
<div class="card">
  <div class="row">
    <span id="fileName" class="grow ellipsis" style="font-weight:600"></span>
    <span id="fileState" class="pill" hidden></span>
  </div>
  <div id="fileMeta" class="muted small ellipsis"></div>
  <div class="buttons" style="margin-top:10px" id="idleButtons">
    <button class="primary" data-cmd="runFile" id="runBtn">▶ Run</button>
    <button data-cmd="debugFile" id="debugBtn">Debug</button>
  </div>
  <div class="buttons" style="margin-top:10px" id="pausedButtons" hidden>
    <button class="primary" data-cmd="debugNext" title="F10">Next step</button>
    <button data-cmd="debugContinue" title="F5">Continue</button>
    <button data-cmd="debugExplain">Explain</button>
    <button data-cmd="debugHighlight">Show target</button>
    <button data-cmd="stop" title="Shift+F5">Stop</button>
  </div>
  <div class="buttons" style="margin-top:10px" id="runningButtons" hidden>
    <button data-cmd="stop">■ Stop</button>
    <button data-cmd="showOutput">Output</button>
  </div>
</div>

<h2>Hooks</h2>
<div class="card">
  <div class="row">
    <span id="hookName" class="grow ellipsis"></span>
    <button class="link" data-cmd="openHooks" id="hookOpen">Open</button>
    <button class="link" data-cmd="createHooks" id="hookCreate">Create</button>
  </div>
  <div id="hookMeta" class="muted small"></div>
  <div id="hookWarn" class="note" hidden></div>
  <label class="check"><input type="checkbox" data-setting="hooks.enabled" id="hooksEnabled"> Pass the hook script to every run</label>
</div>

<h2>Options</h2>
<div class="card">
  <label class="field">Browser
    <select data-setting="run.browser" id="browser">
      <option value="config">From config</option>
      <option value="chromium">Chromium</option>
      <option value="firefox">Firefox</option>
    </select>
  </label>
  <label class="field">Window
    <select data-setting="run.headless" id="headless">
      <option value="config">From config</option>
      <option value="off">Visible</option>
      <option value="on">Headless</option>
    </select>
  </label>
  <label class="field">Screenshots
    <select data-setting="run.screenshot" id="screenshot">
      <option value="config">From config</option>
      <option value="on-fail">On failure</option>
      <option value="always">Every step</option>
      <option value="none">Never</option>
    </select>
  </label>
  <label class="field">Retries <input type="number" min="0" max="10" data-setting="run.retries" id="retries"></label>
  <label class="field">Parallel files <input type="number" min="1" max="16" data-setting="run.workers" id="workers"></label>
  <label class="check"><input type="checkbox" data-setting="run.htmlReport" id="htmlReport"> Write an HTML report</label>
  <label class="check"><input type="checkbox" data-setting="run.explain" id="explain"> Print score breakdowns</label>
</div>

<div id="lastSection" hidden>
  <h2>Last run</h2>
  <div class="card">
    <div class="row">
      <span id="lastVerdict" class="pill"></span>
      <span id="lastFile" class="grow ellipsis"></span>
      <span id="lastTime" class="muted small"></span>
    </div>
    <div id="lastDetail" class="muted small wrap" style="margin-top:6px"></div>
    <div class="row" style="margin-top:8px">
      <button class="link" data-cmd="showOutput">Output</button>
      <button class="link" data-cmd="openReport" id="lastReport">HTML report</button>
      <button class="link" data-cmd="clearResults">Clear marks</button>
    </div>
  </div>
</div>

<h2>Tools</h2>
<div class="buttons">
  <button data-cmd="newHunt">New hunt</button>
  <button data-cmd="record">Record</button>
  <button data-cmd="scan">Scan a page</button>
  <button data-cmd="openConfig">Config</button>
  <button data-cmd="doctor">Check setup</button>
</div>
`;

const SCRIPT = `
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-cmd]');
  if (el) vscode.postMessage({ type: 'command', command: el.dataset.cmd });
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-setting]');
  if (!el) return;
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') value = Math.max(Number(el.min || 0), Math.min(Number(el.max || 99), Number(el.value) || 0));
  vscode.postMessage({ type: 'setting', key: el.dataset.setting, value });
});

const VERDICTS = { pass: ['pass', 'PASS'], flaky: ['warn', 'FLAKY'], fail: ['fail', 'FAIL'], error: ['fail', 'ERROR'], stopped: ['', 'STOPPED'] };

window.addEventListener('message', ({ data: s }) => {
  const e = s.engine;
  $('engineVersion').hidden = !e;
  $('engineVersion').textContent = e ? e.version : '';
  $('engineSource').textContent = e ? 'from ' + e.source : 'Not installed';
  $('enginePath').textContent = e ? e.path : '';
  $('enginePath').title = e ? e.detail : '';
  $('engineMissing').hidden = !!e;

  const f = s.file;
  $('fileName').textContent = f ? f.name : 'No hunt file open';
  $('fileMeta').textContent = f ? [f.title, f.steps + (f.steps === 1 ? ' step block' : ' step blocks'), f.tags.join(', ')].filter(Boolean).join(' · ') : 'Open a .hunt file to run it';
  const state = $('fileState');
  state.hidden = !(s.paused || s.running);
  state.textContent = s.paused ? 'PAUSED' : 'RUNNING';
  state.className = 'pill' + (s.paused ? ' warn' : '');
  $('idleButtons').hidden = s.running;
  $('pausedButtons').hidden = !s.paused;
  $('runningButtons').hidden = !s.running || s.paused;
  $('runBtn').disabled = $('debugBtn').disabled = !f || !e;

  const h = s.hooks;
  $('hookName').textContent = h.script || (h.enabled ? 'No hook script for this hunt' : 'Hook pickup is off');
  $('hookName').title = h.path || '';
  $('hookOpen').hidden = !h.script;
  $('hookCreate').hidden = !!h.script;
  $('hookMeta').textContent = h.script
    ? [h.runtime, h.handlers + (h.handlers === 1 ? ' handler' : ' handlers'), h.variables.length ? 'sets ' + h.variables.map((v) => '{' + v + '}').join(' ') : ''].filter(Boolean).join(' · ')
    : 'Looks for manul_hooks.py or manul_hooks.mjs at or above the hunt file.';
  $('hookWarn').hidden = !h.warning;
  $('hookWarn').textContent = h.warning || '';
  $('hooksEnabled').checked = h.enabled;

  for (const [id, value] of Object.entries(s.settings)) {
    const el = $(id);
    if (!el || document.activeElement === el) continue;
    if (el.type === 'checkbox') el.checked = !!value; else el.value = value;
  }

  const l = s.last;
  $('lastSection').hidden = !l;
  if (l) {
    const [cls, text] = VERDICTS[l.verdict] || ['', l.verdict];
    $('lastVerdict').className = 'pill ' + cls;
    $('lastVerdict').textContent = text;
    $('lastFile').textContent = l.file;
    $('lastTime').textContent = l.duration;
    $('lastDetail').textContent = l.detail;
    $('lastReport').hidden = !l.report;
  }
});
vscode.postMessage({ type: 'ready' });
`;

export class Dashboard implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'manulBrowser.dashboard';
  private view?: vscode.WebviewView;
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly services: Services,
    private readonly runs: RunService,
    private readonly activeHunt: () => vscode.Uri | undefined,
  ) {
    const later = (): void => this.schedule();
    this.subscriptions.push(
      services.onDidChange(later),
      runs.onDidChange(later),
      vscode.window.onDidChangeActiveTextEditor(later),
      vscode.workspace.onDidSaveTextDocument(later),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG)) later();
      }),
    );
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.forEach((d) => d.dispose());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = page(view.webview, BODY, '', SCRIPT);
    view.webview.onDidReceiveMessage((msg: { type: string; command?: string; key?: string; value?: unknown }) => {
      if (msg.type === 'ready') return void this.push();
      if (msg.type === 'command' && msg.command && COMMANDS.has(msg.command)) {
        return void vscode.commands.executeCommand(`manulBrowser.${msg.command}`);
      }
      if (msg.type === 'setting' && msg.key && SETTING_KEYS.has(msg.key)) {
        const scope = this.activeHunt();
        const target = vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
        return void vscode.workspace.getConfiguration(CONFIG, scope).update(msg.key, msg.value, target);
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.push();
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Several things change at once when a run ends; send one update for them. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.push(), 60);
  }

  private async push(): Promise<void> {
    const view = this.view;
    if (!view?.visible) return;
    const uri = this.activeHunt();
    const root = this.services.rootFor(uri);
    const resolution = root ? await this.services.engine(root) : undefined;
    const engine = resolution?.engine;
    const settings = this.services.settings(uri);
    const c = vscode.workspace.getConfiguration(CONFIG, uri);

    let file: { name: string; title: string; tags: string[]; steps: number } | null = null;
    if (uri) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const outline = parseHunt(doc?.getText() ?? '');
      file = { name: this.services.relative(uri.fsPath), title: outline.title, tags: outline.tags, steps: outline.steps.length };
    }

    const hooks = uri ? this.services.hooksFor(uri) : undefined;
    let warning = '';
    if (hooks && !hooks.scan.serves) {
      const call = hookRuntime(hooks.script) === 'python' ? 'manul.serve_hooks()' : 'serveHooks()';
      warning = `This script never calls ${call}, so the engine will get no answer from it.`;
    } else if (hooks && engine && engine.flags.size > 0 && !engine.flags.has('hooks')) {
      warning = `Engine ${engine.version} has no --hooks option; the script will not be used.`;
    }

    const lastRun = this.runs.last;
    let last = null;
    if (lastRun) {
      const o = lastRun.outcome;
      const r = o.result;
      const verdict = o.stopped ? 'stopped' : o.error ? 'error' : r ? (r.success ? (r.flaky ? 'flaky' : 'pass') : 'fail') : 'pass';
      const failed = r?.results?.find((x) => !x.success);
      last = {
        file: path.basename(lastRun.file),
        verdict,
        duration: formatDuration(r?.total_duration_ms || o.durationMs),
        detail:
          o.error ??
          (r
            ? `${r.passed} of ${r.total_steps} steps passed` +
              (failed ? ` — ${failed.step}: ${failed.error ?? 'failed'}` : '') +
              (r.soft_errors?.length ? ` — ${r.soft_errors.length} soft assertion(s) failed` : '')
            : ''),
        report: settings.htmlReport,
      };
    }

    void view.webview.postMessage({
      engine: engine
        ? { version: engine.version, source: sourceLabel(engine.source), path: engine.path, detail: engine.detail }
        : null,
      file,
      running: uri ? this.runs.isRunning(uri) : false,
      paused: uri ? this.runs.paused === uri.fsPath : false,
      hooks: {
        enabled: settings.hooksEnabled,
        script: hooks ? this.services.relative(hooks.script) : '',
        path: hooks?.script ?? '',
        runtime: hooks ? { python: 'Python', node: 'Node', native: 'executable' }[hookRuntime(hooks.script)] : '',
        handlers: hooks?.scan.handlers.length ?? 0,
        variables: hooks?.scan.variables ?? [],
        warning,
      },
      settings: {
        browser: c.get('run.browser', 'config'),
        headless: c.get('run.headless', 'config'),
        screenshot: c.get('run.screenshot', 'config'),
        retries: settings.retries,
        workers: settings.workers,
        htmlReport: settings.htmlReport,
        explain: settings.explain,
      },
      last,
    });
  }
}
