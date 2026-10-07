// What the last run said about each line, drawn where the line is.

import * as path from 'path';
import * as vscode from 'vscode';

import { ExplainEvent, StepResult, formatDuration } from './core/runner';

interface LineResult {
  /** Every result reported for this line; more than one inside a loop. */
  runs: StepResult[];
}

const SCORE_LABELS: Array<[string, string]> = [
  ['exact_text_match', 'text'],
  ['label_match', 'label'],
  ['placeholder_match', 'placeholder'],
  ['aria_match', 'aria'],
  ['id_match', 'id'],
  ['type_hint_alignment', 'type'],
  ['proximity_score', 'near'],
];

const md = (s: string): string => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class Results implements vscode.Disposable, vscode.HoverProvider {
  private readonly byFile = new Map<string, Map<number, LineResult>>();
  private readonly paused = new Map<string, { line: number; explain?: ExplainEvent }>();

  private readonly passed = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('testing.iconPassed'), margin: '0 0 0 2.5em' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly failed = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('testing.iconFailed'), margin: '0 0 0 2.5em' },
    backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('testing.iconFailed'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly pausedAt = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('debugIcon.breakpointCurrentStackframeForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2.5em' },
  });

  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly inlineEnabled: () => boolean) {
    this.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      // Results are keyed by line; once the text moves they point at the
      // wrong lines, and a wrong mark is worse than none.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && this.byFile.delete(e.document.uri.fsPath)) this.renderAll();
      }),
      vscode.languages.registerHoverProvider({ language: 'hunt' }, this),
    );
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.passed.dispose();
    this.failed.dispose();
    this.pausedAt.dispose();
  }

  begin(file: string): void {
    this.byFile.set(file, new Map());
    this.renderAll();
  }

  record(file: string, line: number, step: StepResult): void {
    const lines = this.byFile.get(file) ?? new Map<number, LineResult>();
    const entry = lines.get(line) ?? { runs: [] };
    entry.runs.push(step);
    lines.set(line, entry);
    this.byFile.set(file, lines);
    this.renderAll();
  }

  setPaused(file: string, line: number | undefined, explain?: ExplainEvent): void {
    if (line === undefined) this.paused.delete(file);
    else this.paused.set(file, { line, explain });
    this.renderAll();
  }

  clear(file?: string): void {
    if (file) this.byFile.delete(file);
    else this.byFile.clear();
    this.renderAll();
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId !== 'hunt') continue;
      this.render(editor);
    }
  }

  private render(editor: vscode.TextEditor): void {
    const file = editor.document.uri.fsPath;
    const passed: vscode.DecorationOptions[] = [];
    const failed: vscode.DecorationOptions[] = [];
    const lines = this.inlineEnabled() ? this.byFile.get(file) : undefined;

    for (const [line, entry] of lines ?? []) {
      if (line >= editor.document.lineCount) continue;
      const end = editor.document.lineAt(line).range.end;
      const range = new vscode.Range(end, end);
      const last = entry.runs[entry.runs.length - 1];
      const times = entry.runs.length > 1 ? `  ×${entry.runs.length}` : '';
      const anyFailed = entry.runs.some((r) => !r.success);
      if (anyFailed) {
        const bad = entry.runs.find((r) => !r.success) ?? last;
        failed.push({
          range: editor.document.lineAt(line).range,
          renderOptions: { after: { contentText: `✗ ${clip(bad.error ?? 'failed', 110)}${times}` } },
        });
      } else {
        const total = entry.runs.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);
        passed.push({ range, renderOptions: { after: { contentText: `✓ ${formatDuration(total)}${times}` } } });
      }
    }
    editor.setDecorations(this.passed, passed);
    editor.setDecorations(this.failed, failed);

    const pause = this.paused.get(file);
    if (pause && pause.line < editor.document.lineCount) {
      const note = pause.explain
        ? `paused — target scores ${pause.explain.score.toFixed(2)}${pause.explain.confidence_label ? ` (${pause.explain.confidence_label})` : ''}`
        : 'paused — F10 next, F5 continue';
      editor.setDecorations(this.pausedAt, [
        { range: editor.document.lineAt(pause.line).range, renderOptions: { after: { contentText: note } } },
      ]);
    } else {
      editor.setDecorations(this.pausedAt, []);
    }
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const file = document.uri.fsPath;
    const out = new vscode.MarkdownString();
    out.supportThemeIcons = true;

    const pause = this.paused.get(file);
    if (pause?.line === position.line && pause.explain) {
      const e = pause.explain;
      out.appendMarkdown(`$(debug-pause) **Paused here** — best target scores **${e.score.toFixed(3)}**`);
      if (e.confidence_label) out.appendMarkdown(` (${md(e.confidence_label)})`);
      out.appendMarkdown('\n\n');
      if (e.heuristic_match) out.appendMarkdown(`Would act on: \`${clip(e.heuristic_match, 80)}\`\n\n`);
      if (e.explanation) out.appendMarkdown(`${md(e.explanation)}\n\n`);
      if (e.risk) out.appendMarkdown(`$(warning) ${md(e.risk)}\n\n`);
      if (e.suggestion) out.appendMarkdown(`$(lightbulb) ${md(e.suggestion)}\n\n`);
    }

    const entry = this.byFile.get(file)?.get(position.line);
    if (entry) {
      const step = entry.runs.find((r) => !r.success) ?? entry.runs[entry.runs.length - 1];
      out.appendMarkdown(
        step.success
          ? `$(pass) **Passed** in ${formatDuration(step.duration_ms)}`
          : `$(error) **Failed** after ${formatDuration(step.duration_ms)}`,
      );
      if (entry.runs.length > 1) out.appendMarkdown(` — ran ${entry.runs.length} times`);
      out.appendMarkdown('\n\n');
      if (step.error) out.appendCodeblock(step.error, 'text');
      if (step.failure_reason && step.failure_reason !== 'ok') {
        out.appendMarkdown(`Reason: \`${step.failure_reason}\`\n\n`);
      }
      if (step.action_value) out.appendMarkdown(`Value: \`${clip(step.action_value, 120)}\`\n\n`);
      if (step.target_query) {
        out.appendMarkdown(
          `Target \`${clip(step.target_query, 60)}\` — ${step.candidates_considered ?? 0} candidates considered\n\n`,
        );
      }
      const ranked = (step.ranked_candidates ?? []).slice(0, 4);
      if (ranked.length) {
        out.appendMarkdown('| | score | element | why |\n|---|---|---|---|\n');
        for (const c of ranked) {
          const what = c.visible_text || c.aria_label || c.placeholder || c.id || '';
          const why = SCORE_LABELS.filter(([k]) => (c.score?.[k] ?? 0) > 0)
            .map(([k, label]) => `${label} ${c.score[k].toFixed(2)}`)
            .join(', ');
          out.appendMarkdown(
            `| ${c.rank === 1 ? '$(target)' : c.rank} | ${(c.score?.total ?? 0).toFixed(3)} | \`<${c.tag}>\` ${md(clip(what, 40))} | ${md(why)} |\n`,
          );
        }
        out.appendMarkdown('\n');
      }
      if (step.screenshot_path) {
        const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(file);
        const shot = vscode.Uri.file(path.resolve(root, step.screenshot_path));
        out.appendMarkdown(`[$(device-camera) Screenshot](${shot.toString()})\n\n`);
      }
    }

    return out.value ? new vscode.Hover(out) : undefined;
  }
}
