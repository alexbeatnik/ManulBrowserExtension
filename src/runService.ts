// One place that starts the engine for a hunt file, for every entry point:
// the editor buttons, the Test Explorer, the dashboard.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { sourceLabel, supports } from './core/engine';
import { hookEnvironment, hookRuntime } from './core/hooks';
import { StepLocator, parseHunt } from './core/huntDoc';
import {
  DebugCommand,
  ExplainEvent,
  HuntResult,
  HuntRun,
  StepResult,
  buildArgs,
  formatDuration,
  stripAnsi,
} from './core/runner';
import { Results } from './results';
import { Services } from './services';

export interface RunCallbacks {
  /** `line` is 0-based, undefined when the step could not be placed. */
  onStep?(step: StepResult, line: number | undefined): void;
  onLog?(line: string): void;
}

export interface RunOutcome {
  result?: HuntResult;
  /** Why there is no result, or why the result is not the whole story. */
  error?: string;
  stopped: boolean;
  durationMs: number;
}

export interface LastRun {
  file: string;
  outcome: RunOutcome;
  at: number;
}

interface Active {
  uri: vscode.Uri;
  run: HuntRun;
  debug: boolean;
}

export class RunService implements vscode.Disposable {
  private readonly active = new Map<string, Active>();
  private pausedFile?: string;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a run starts, pauses, resumes or ends. */
  readonly onDidChange = this.changed.event;
  last?: LastRun;

  constructor(
    private readonly services: Services,
    private readonly results: Results,
  ) {}

  dispose(): void {
    this.stopAll();
    this.changed.dispose();
  }

  get running(): string[] {
    return [...this.active.keys()];
  }

  get paused(): string | undefined {
    return this.pausedFile;
  }

  isRunning(uri: vscode.Uri): boolean {
    return this.active.has(uri.fsPath);
  }

  private refreshContext(): void {
    void vscode.commands.executeCommand('setContext', 'manulBrowser.running', this.active.size > 0);
    void vscode.commands.executeCommand('setContext', 'manulBrowser.paused', this.pausedFile !== undefined);
    this.changed.fire();
  }

  stopAll(): void {
    for (const a of this.active.values()) a.run.stop();
  }

  stop(uri?: vscode.Uri): void {
    if (!uri) return this.stopAll();
    this.active.get(uri.fsPath)?.run.stop();
  }

  /** Answer the current pause. */
  debug(command: DebugCommand): void {
    if (!this.pausedFile) return;
    const a = this.active.get(this.pausedFile);
    if (!a) return;
    if (command === 'next' || command === 'continue' || command === 'debug-stop') {
      this.results.setPaused(this.pausedFile, undefined);
      this.pausedFile = undefined;
      this.refreshContext();
    }
    a.run.send(command);
  }

  /**
   * Run one hunt file to the end. Resolves in every case — a missing engine,
   * a crash and a failed step are all outcomes, not exceptions.
   */
  async run(
    uri: vscode.Uri,
    opts: { debug: boolean; token?: vscode.CancellationToken } & RunCallbacks,
  ): Promise<RunOutcome> {
    const file = uri.fsPath;
    const started = Date.now();
    const fail = (error: string): RunOutcome => {
      const outcome = { error, stopped: false, durationMs: Date.now() - started };
      this.last = { file, outcome, at: Date.now() };
      this.changed.fire();
      return outcome;
    };

    if (this.active.has(file)) return fail('This hunt is already running.');
    const root = this.services.rootFor(uri);
    if (!root) return fail('Open a folder to run hunt files.');

    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    if (doc?.isDirty) await doc.save();

    const { engine, failures } = await this.services.engine(root);
    if (!engine) {
      const why = failures.length ? ` Tried: ${failures.join('; ')}` : '';
      return fail(
        `No manul engine found. Install one with "npm install manul-browser" or "pip install manul-browser", ` +
          `or set manulBrowser.enginePath.${why}`,
      );
    }

    const s = this.services.settings(uri);
    const log = (line: string): void => {
      this.services.log(line);
      opts.onLog?.(line);
    };

    // Hooks: find the script, and say what was decided either way.
    const hooks = this.services.hooksFor(uri);
    let hookEnv: Record<string, string> = {};
    let hookNote = s.hooksEnabled ? 'none found' : 'pickup is off';
    if (hooks) {
      if (!supports(engine, 'hooks')) {
        hookNote = `${this.services.relative(hooks.script)} ignored — engine ${engine.version} has no --hooks`;
      } else {
        hookEnv = hookEnvironment(hooks.script, [root], engine, { python: s.pythonPath, node: s.nodePath });
        const via = hookEnv.MANUL_PYTHON ?? hookEnv.MANUL_NODE;
        hookNote = this.services.relative(hooks.script) + (via ? ` (run with ${via})` : '');
        if (!hooks.scan.serves) {
          const call = hookRuntime(hooks.script) === 'python' ? 'manul.serve_hooks()' : 'serveHooks()';
          log(`⚠ ${this.services.relative(hooks.script)} never calls ${call}; the engine will wait for it and give up.`);
        }
      }
    }

    let text: string;
    try {
      text = doc?.getText() ?? fs.readFileSync(file, 'utf8');
    } catch (err) {
      return fail(`Cannot read ${file}: ${(err as Error).message}`);
    }
    const outline = parseHunt(text);
    const stepLocator = new StepLocator(outline);
    const pauseLocator = new StepLocator(outline);

    const breakLines = opts.debug
      ? vscode.debug.breakpoints
          .filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint)
          .filter((b) => b.enabled && b.location.uri.fsPath === file)
          .map((b) => b.location.range.start.line + 1)
          .sort((a, b) => a - b)
      : [];

    const { args, dropped } = buildArgs(
      file,
      {
        browser: s.browser,
        channel: s.channel,
        // Stepping through a page nobody can see is not debugging.
        headless: opts.debug ? false : s.headless,
        retries: opts.debug ? 0 : s.retries,
        screenshot: s.screenshot,
        htmlReport: s.htmlReport,
        explain: s.explain,
        hooks: hooks && supports(engine, 'hooks') ? hooks.script : undefined,
        breakLines,
        stepThrough: opts.debug && breakLines.length === 0,
        extraArgs: s.extraArgs,
      },
      engine,
    );

    const run = new HuntRun(engine.path, args, root, { ...process.env, ...s.env, ...hookEnv });
    this.active.set(file, { uri, run, debug: opts.debug });
    this.results.begin(file);
    this.refreshContext();

    log('');
    log(`▶ ${this.services.relative(file)}${opts.debug ? '  (debug)' : ''}`);
    log(`  engine: ${engine.version} via ${sourceLabel(engine.source)} — ${engine.path}`);
    log(`  hooks:  ${hookNote}`);
    if (dropped.length) log(`  not supported by this engine, left out: ${dropped.join(' ')}`);
    if (!supports(engine, 'jsonl')) {
      log('  this engine has no --jsonl: steps will not be reported one by one, only pass or fail');
    }

    let result: HuntResult | undefined;
    let lastPauseIdx = -1;
    let lastPauseLine: number | undefined;
    let explain: ExplainEvent | undefined;

    run.on('log', (line) => log(stripAnsi(line)));
    run.on('step', (step) => {
      const line = stepLocator.locate(step.step, step.step_block);
      if (line !== undefined) this.results.record(file, line, step);
      opts.onStep?.(step, line);
    });
    run.on('result', (r) => {
      result = r;
    });
    run.on('explain', (e) => {
      explain = e;
      if (lastPauseLine !== undefined) this.results.setPaused(file, lastPauseLine, e);
      log(`  explain: ${e.step} → score ${e.score.toFixed(3)}${e.explanation ? ` — ${e.explanation}` : ''}`);
    });
    run.on('pause', (p) => {
      // The engine repeats the marker after `explain` and `highlight`; only
      // a new index is a new position.
      if (p.idx !== lastPauseIdx) {
        lastPauseIdx = p.idx;
        lastPauseLine = pauseLocator.locate(p.step);
        explain = undefined;
        void this.reveal(uri, lastPauseLine);
      }
      this.pausedFile = file;
      this.results.setPaused(file, lastPauseLine ?? 0, explain);
      this.refreshContext();
    });

    const cancel = opts.token?.onCancellationRequested(() => run.stop());

    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      run.on('exit', resolve);
      run.start();
    });
    cancel?.dispose();

    this.active.delete(file);
    if (this.pausedFile === file) this.pausedFile = undefined;
    this.results.setPaused(file, undefined);

    const durationMs = Date.now() - started;
    let error: string | undefined;
    if (exit.error) error = `Could not start the engine: ${exit.error.message}`;
    else if (!result && !run.stopped && (exit.code !== 0 || supports(engine, 'jsonl'))) {
      // An engine too old to stream still says pass or fail with its exit
      // code; only then is a clean exit without a result a pass.
      error = `The engine exited with code ${exit.code} before reporting a result.`;
    }

    if (result) {
      const verdict = result.success ? (result.flaky ? 'FLAKY' : 'PASS') : 'FAIL';
      log(`■ ${verdict}  ${result.passed}/${result.total_steps} steps  ${formatDuration(result.total_duration_ms || durationMs)}`);
    } else if (run.stopped) {
      log('■ stopped');
    } else if (error) {
      log(`■ ${error}`);
    }

    const outcome: RunOutcome = { result, error, stopped: run.stopped, durationMs };
    this.last = { file, outcome, at: Date.now() };
    this.refreshContext();
    return outcome;
  }

  private async reveal(uri: vscode.Uri, line: number | undefined): Promise<void> {
    if (line === undefined) return;
    const editor = await vscode.window.showTextDocument(uri, { preserveFocus: false, preview: false });
    const range = editor.document.lineAt(Math.min(line, editor.document.lineCount - 1)).range;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** The command line a terminal run of this hunt needs, with its environment. */
  async terminalInvocation(
    uri: vscode.Uri,
  ): Promise<{ exe: string; args: string[]; cwd: string; env: Record<string, string> } | undefined> {
    const root = this.services.rootFor(uri);
    if (!root) return undefined;
    const { engine } = await this.services.engine(root);
    if (!engine) return undefined;
    const s = this.services.settings(uri);
    // For a folder, the script that a hunt directly inside it would get.
    let isFolder = false;
    try {
      isFolder = fs.statSync(uri.fsPath).isDirectory();
    } catch {
      // Gone since it was clicked; the engine will say so.
    }
    const hooks = this.services.hooksFor(isFolder ? vscode.Uri.file(path.join(uri.fsPath, '_.hunt')) : uri);
    const useHooks = hooks && supports(engine, 'hooks');
    const { args } = buildArgs(
      path.relative(root, uri.fsPath) || '.',
      {
        browser: s.browser,
        channel: s.channel,
        headless: s.headless,
        retries: s.retries,
        screenshot: s.screenshot,
        htmlReport: s.htmlReport,
        explain: s.explain,
        hooks: useHooks ? path.relative(root, hooks.script) || hooks.script : undefined,
        extraArgs: s.extraArgs,
      },
      engine,
    );
    return {
      exe: engine.path,
      // A person reads a terminal; the JSON stream is for the extension.
      args: args.filter((a) => a !== '--jsonl'),
      cwd: root,
      env: {
        ...s.env,
        ...(useHooks
          ? hookEnvironment(hooks.script, [root], engine, { python: s.pythonPath, node: s.nodePath })
          : {}),
      },
    };
  }
}
