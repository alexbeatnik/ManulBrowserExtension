// Hunt files in the Test Explorer: one item per file, one child per STEP.

import * as vscode from 'vscode';

import { HuntOutline, parseHunt } from './core/huntDoc';
import { StepResult, formatDuration } from './core/runner';
import { RunService } from './runService';
import { EXCLUDE_GLOB, Services } from './services';

export class HuntTests implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController('manulBrowser', 'Manul Hunts');
  private readonly outlines = new Map<string, HuntOutline>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly runProfile: vscode.TestRunProfile;
  private readonly debugProfile: vscode.TestRunProfile;

  constructor(
    private readonly services: Services,
    private readonly runs: RunService,
  ) {
    this.runProfile = this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.execute(request, token, false),
      true,
    );
    this.debugProfile = this.controller.createRunProfile(
      'Debug',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.execute(request, token, true),
      true,
    );
    this.controller.resolveHandler = async (item) => {
      if (!item) await this.discover();
    };
    this.controller.refreshHandler = () => this.discover();

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.hunt');
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => this.load(uri)),
      watcher.onDidChange((uri) => this.load(uri)),
      watcher.onDidDelete((uri) => this.controller.items.delete(uri.toString())),
      vscode.workspace.onDidOpenTextDocument((doc) => this.fromDocument(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.fromDocument(e.document)),
    );
    vscode.workspace.textDocuments.forEach((doc) => this.fromDocument(doc));
    void this.discover();
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.controller.dispose();
  }

  private async discover(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.hunt', EXCLUDE_GLOB);
    const seen = new Set(files.map((f) => f.toString()));
    this.controller.items.forEach((item) => {
      if (!seen.has(item.id)) this.controller.items.delete(item.id);
    });
    await Promise.all(files.map((f) => this.load(f)));
  }

  private fromDocument(doc: vscode.TextDocument): void {
    if (doc.languageId === 'hunt' && doc.uri.scheme === 'file') this.update(doc.uri, doc.getText());
  }

  private async load(uri: vscode.Uri): Promise<void> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      this.update(uri, open.getText());
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.update(uri, Buffer.from(bytes).toString('utf8'));
    } catch {
      this.controller.items.delete(uri.toString());
    }
  }

  private update(uri: vscode.Uri, text: string): vscode.TestItem {
    const outline = parseHunt(text);
    this.outlines.set(uri.toString(), outline);

    const id = uri.toString();
    const label = this.services.relative(uri.fsPath);
    let item = this.controller.items.get(id);
    if (!item) {
      item = this.controller.createTestItem(id, label, uri);
      this.controller.items.add(item);
    }
    item.label = label;
    item.description = outline.title || undefined;
    item.tags = outline.tags.map((t) => new vscode.TestTag(t));
    item.range = new vscode.Range(0, 0, 0, 0);
    item.children.replace(
      outline.steps.map((step, i) => {
        const child = this.controller.createTestItem(`${id}#${i}`, step.label || step.header, uri);
        child.range = new vscode.Range(step.line, 0, step.endLine, 0);
        return child;
      }),
    );
    return item;
  }

  /** Run one file from outside the Test Explorer, with the same reporting. */
  async runFile(uri: vscode.Uri, debug: boolean): Promise<void> {
    if (!this.controller.items.get(uri.toString())) await this.load(uri);
    const item = this.controller.items.get(uri.toString());
    if (!item) return;
    const request = new vscode.TestRunRequest([item], undefined, debug ? this.debugProfile : this.runProfile);
    const source = new vscode.CancellationTokenSource();
    try {
      await this.execute(request, source.token, debug);
    } finally {
      source.dispose();
    }
  }

  private async execute(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    debug: boolean,
  ): Promise<void> {
    // A STEP cannot run on its own — the engine runs files — so a request for
    // one becomes a request for its file.
    const files = new Map<string, vscode.TestItem>();
    const add = (item: vscode.TestItem): void => {
      const file = item.parent ?? item;
      if (!request.exclude?.includes(file)) files.set(file.id, file);
    };
    if (request.include) request.include.forEach(add);
    else this.controller.items.forEach(add);
    if (files.size === 0) return;

    const run = this.controller.createTestRun(request);
    const queue = [...files.values()];
    queue.forEach((f) => {
      run.enqueued(f);
      f.children.forEach((c) => run.enqueued(c));
    });

    const first = queue[0].uri;
    // One browser at a time while debugging: two paused runs cannot share an editor.
    const workers = debug ? 1 : Math.min(this.services.settings(first).workers, queue.length);
    const stopAll = token.onCancellationRequested(() => this.runs.stopAll());

    const worker = async (): Promise<void> => {
      for (;;) {
        const item = queue.shift();
        if (!item || token.isCancellationRequested) return;
        await this.runOne(run, item, token, debug);
      }
    };
    try {
      await Promise.all(Array.from({ length: workers }, worker));
      // Anything still queued was cancelled before it began.
      queue.forEach((f) => {
        run.skipped(f);
        f.children.forEach((c) => run.skipped(c));
      });
    } finally {
      stopAll.dispose();
      run.end();
    }
  }

  private async runOne(
    run: vscode.TestRun,
    item: vscode.TestItem,
    token: vscode.CancellationToken,
    debug: boolean,
  ): Promise<void> {
    const uri = item.uri;
    if (!uri) return;
    const outline = this.outlines.get(item.id) ?? parseHunt('');
    const children: vscode.TestItem[] = [];
    item.children.forEach((c) => children.push(c));

    // Per STEP block: what has been reported for it so far.
    const state = children.map(() => ({ started: false, failed: false, ms: 0, messages: [] as vscode.TestMessage[] }));
    let current = -1;
    const finish = (i: number): void => {
      if (i < 0 || !state[i].started) return;
      if (state[i].failed) run.failed(children[i], state[i].messages, state[i].ms);
      else run.passed(children[i], state[i].ms);
    };
    const outside: vscode.TestMessage[] = [];

    run.started(item);
    const out = (line: string): void => run.appendOutput(`${line}\r\n`, undefined, item);

    const onStep = (step: StepResult, line: number | undefined): void => {
      let index = step.step_block ? outline.steps.findIndex((s) => s.header === step.step_block?.trim().replace(/\s+/g, ' ')) : -1;
      if (index < 0 && line !== undefined) index = outline.steps.findIndex((s) => line >= s.line && line <= s.endLine);

      let message: vscode.TestMessage | undefined;
      if (!step.success) {
        message = new vscode.TestMessage(`${step.step}\n${step.error ?? 'failed'}`);
        if (line !== undefined) message.location = new vscode.Location(uri, new vscode.Position(line, 0));
      }
      if (index < 0 || index >= children.length) {
        if (message) outside.push(message);
        return;
      }
      if (index !== current) {
        finish(current);
        current = index;
      }
      const s = state[index];
      if (!s.started) {
        s.started = true;
        run.started(children[index]);
      }
      s.ms += step.duration_ms ?? 0;
      if (message) {
        s.failed = true;
        s.messages.push(message);
      }
    };

    const outcome = await this.runs.run(uri, { debug, token, onStep, onLog: out });
    finish(current);
    current = -1;
    state.forEach((s, i) => {
      if (!s.started) run.skipped(children[i]);
    });

    const duration = outcome.result?.total_duration_ms || outcome.durationMs;
    if (outcome.stopped) {
      run.skipped(item);
    } else if (outcome.error) {
      run.errored(item, new vscode.TestMessage(outcome.error), duration);
    } else if (!outcome.result || outcome.result.success) {
      const soft = outcome.result?.soft_errors ?? [];
      if (outcome.result?.flaky) out(`flaky: passed on attempt ${outcome.result.attempts ?? '?'}`);
      soft.forEach((e) => out(`soft assertion failed: ${e}`));
      run.passed(item, duration);
    } else {
      const messages = [...outside, ...state.flatMap((s) => s.messages)];
      if (messages.length === 0) {
        messages.push(
          new vscode.TestMessage(
            `${outcome.result.failed} of ${outcome.result.total_steps} steps failed in ${formatDuration(duration)}. See the Manul Browser output.`,
          ),
        );
      }
      run.failed(item, messages, duration);
    }
  }
}
