// Runs inside a real VS Code, against a real engine and a real browser.
//
//   code <workspace> --extensionDevelopmentPath=<repo>
//        --extensionTestsPath=<repo>/out/test/integration/index.js
//
// The workspace must hold `hunts/orders.hunt`, a `manul_hooks.py` whose
// before_all publishes what that hunt needs, and an installed engine. Results
// are written to MANUL_EXT_TEST_REPORT when it is set, because an extension
// host's console does not always reach the terminal that started it.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { ManulBrowserApi } from '../../extension';

const lines: string[] = [];
const say = (s: string): void => {
  lines.push(s);
  console.log(s);
};

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    say(`ok   ${name}`);
  } catch (err) {
    say(`FAIL ${name}: ${(err as Error).message}`);
    throw err;
  }
}

async function until(what: string, cond: () => boolean, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function suite(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, 'a workspace folder is open');
  const hunt = vscode.Uri.file(path.join(root, 'hunts', 'orders.hunt'));

  const ext = vscode.extensions.getExtension<ManulBrowserApi>('alexbeatnik.manul-browser');
  assert.ok(ext, 'the extension is installed');
  const api = await ext.activate();

  await check('commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ['runFile', 'debugFile', 'stop', 'selectEngine', 'doctor', 'createHooks', 'insertStep']) {
      assert.ok(all.includes(`manulBrowser.${id}`), id);
    }
  });

  await check('the engine is found without a setting', async () => {
    const { engine, failures } = await api.services.engine(root);
    assert.ok(engine, failures.join('; '));
    say(`     engine ${engine.version} via ${engine.source}: ${engine.path}`);
    assert.ok(engine.flags.has('hooks') && engine.flags.has('jsonl'));
  });

  const doc = await vscode.workspace.openTextDocument(hunt);
  await vscode.window.showTextDocument(doc);

  await check('the hook script is picked up', () => {
    const hooks = api.services.hooksFor(hunt);
    assert.ok(hooks, 'no hook script found');
    assert.equal(path.basename(hooks.script), 'manul_hooks.py');
    assert.ok(hooks.scan.handlers.some((h) => h.kind === 'before_all'));
    assert.ok(hooks.scan.variables.includes('token'));
  });

  await check('hunt files appear in the Test Explorer with their STEP blocks', async () => {
    await until('test discovery', () => api.tests.controller.items.get(hunt.toString()) !== undefined);
    const item = api.tests.controller.items.get(hunt.toString());
    assert.equal(item?.children.size, 2);
  });

  await check('completion offers commands and hook variables', async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(hunt, new vscode.Position(doc.lineCount, 0), "\n    FILL 'x' with '{");
    await vscode.workspace.applyEdit(edit);
    const last = doc.lineAt(doc.lineCount - 1);
    const vars = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      hunt,
      last.range.end,
    );
    const labels = vars.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes('token'), `variables offered: ${labels.slice(0, 8).join(', ')}`);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  await check('the outline lists STEP blocks and a formatted file stays as it is', async () => {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', hunt);
    assert.equal(symbols.length, 2);
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', hunt, {
      tabSize: 4,
      insertSpaces: true,
    });
    assert.equal(edits?.length ?? 0, 0);
  });

  await check('CodeLens names the hook script', async () => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', hunt, 10);
    const titles = lenses.map((l) => l.command?.title ?? '');
    assert.ok(titles.some((t) => t.includes('Run')), titles.join(' | '));
    assert.ok(titles.some((t) => t.includes('manul_hooks.py')), titles.join(' | '));
  });

  await vscode.workspace
    .getConfiguration('manulBrowser', hunt)
    .update('run.headless', 'on', vscode.ConfigurationTarget.Workspace);

  await check('a run passes, with the values before_all published', async () => {
    await vscode.commands.executeCommand('manulBrowser.runFile', hunt);
    const last = api.runs.last;
    assert.ok(last, 'no run was recorded');
    assert.equal(last.outcome.error, undefined);
    assert.equal(last.outcome.result?.success, true, JSON.stringify(last.outcome.result?.results?.find((r) => !r.success)));
    assert.equal(last.outcome.result?.passed, 4);
    assert.equal(api.runs.running.length, 0);
  });

  await check('without hook pickup the same hunt fails, and says where', async () => {
    const c = vscode.workspace.getConfiguration('manulBrowser', hunt);
    await c.update('hooks.enabled', false, vscode.ConfigurationTarget.Workspace);
    try {
      assert.equal(api.services.hooksFor(hunt), undefined);
      await vscode.commands.executeCommand('manulBrowser.runFile', hunt);
      const result = api.runs.last?.outcome.result;
      assert.equal(result?.success, false);
      assert.match(result?.results?.find((r) => !r.success)?.step ?? '', /NAVIGATE/);
    } finally {
      await c.update('hooks.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  await check('a debug run pauses, steps and finishes', async () => {
    const done = vscode.commands.executeCommand('manulBrowser.debugFile', hunt);
    await until('the first pause', () => api.runs.paused === hunt.fsPath, 30000);
    await vscode.commands.executeCommand('manulBrowser.debugNext');
    await until('the second pause', () => api.runs.paused === hunt.fsPath, 30000);
    await vscode.commands.executeCommand('manulBrowser.debugContinue');
    await done;
    assert.equal(api.runs.last?.outcome.result?.success, true);
    assert.equal(api.runs.paused, undefined);
  });
}

export async function run(): Promise<void> {
  let failure: unknown;
  try {
    await suite();
    say('all integration checks passed');
  } catch (err) {
    failure = err;
  }
  const report = process.env.MANUL_EXT_TEST_REPORT;
  if (report) fs.writeFileSync(report, `${lines.join('\n')}\n`);
  if (failure) throw failure;
}
