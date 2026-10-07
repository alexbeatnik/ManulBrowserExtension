// Editor support for .hunt files: completion, formatting, outline, CodeLens,
// and the links between a hunt and its hook script.

import * as vscode from 'vscode';

import { CatalogueEntry } from './core/catalogue';
import { hookRuntime } from './core/hooks';
import { RE_CALL, formatHunt, parseHunt } from './core/huntDoc';
import { Services } from './services';

const HUNT: vscode.DocumentSelector = { language: 'hunt' };

class Completions implements vscode.CompletionItemProvider {
  constructor(private readonly services: Services) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const line = document.lineAt(position.line).text;
    const before = line.slice(0, position.character);
    const hooks = this.services.hooksFor(document.uri);

    // {placeholder}: variables declared in the file and published by hooks.
    const brace = before.match(/\{(\w*)$/);
    if (brace) {
      const names = new Map<string, string>();
      for (const m of document.getText().matchAll(/^\s*@var:\s*\{?(\w+)\}?\s*=\s*(.*)$/gm)) names.set(m[1], `@var — ${m[2].trim()}`);
      for (const m of document.getText().matchAll(/\b(?:into|SET)\s+\{(\w+)\}/gi)) if (!names.has(m[1])) names.set(m[1], 'set in this hunt');
      for (const v of hooks?.scan.variables ?? []) {
        if (!names.has(v)) names.set(v, `set by ${this.services.relative(hooks?.script ?? '')}`);
      }
      const closes = line[position.character] === '}';
      return [...names].map(([name, detail]) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
        item.detail = detail;
        item.insertText = closes ? name : `${name}}`;
        return item;
      });
    }

    // CALL HOST <name>: handlers the hook script registers.
    if (/^\s*CALL\s+(?:HOST|PYTHON|GO|JS|NODE)\s+[\w.\-]*$/i.test(before)) {
      return (hooks?.scan.handlers ?? [])
        .filter((h) => h.kind === 'call' && h.name)
        .map((h) => {
          const item = new vscode.CompletionItem(h.name, vscode.CompletionItemKind.Function);
          item.detail = `${this.services.relative(hooks?.script ?? '')}${h.handler ? ` — ${h.handler}()` : ''}`;
          return item;
        });
    }

    // Only at the start of a line: a command is always the first thing on it.
    const head = before.match(/^(\s*)(\S*(?:\s\S*)?)$/);
    if (!head) return [];
    const typed = head[2];
    const range = new vscode.Range(position.line, head[1].length, position.line, position.character);
    const cat = this.services.catalogue;
    const pool: Array<[CatalogueEntry, vscode.CompletionItemKind]> = typed.startsWith('@')
      ? cat.metadata.map((e) => [e, vscode.CompletionItemKind.Property])
      : typed.startsWith('[')
        ? cat.blocks.map((e) => [e, vscode.CompletionItemKind.Struct])
        : [
            ...cat.commands.map((e): [CatalogueEntry, vscode.CompletionItemKind] => [e, vscode.CompletionItemKind.Keyword]),
            ...cat.metadata.map((e): [CatalogueEntry, vscode.CompletionItemKind] => [e, vscode.CompletionItemKind.Property]),
            ...cat.blocks.map((e): [CatalogueEntry, vscode.CompletionItemKind] => [e, vscode.CompletionItemKind.Struct]),
          ];

    return pool.map(([e, kind], i) => {
      const item = new vscode.CompletionItem({ label: e.label, description: e.uiText }, kind);
      item.insertText = new vscode.SnippetString(e.snippet);
      item.range = range;
      item.filterText = e.uiText;
      item.sortText = String(i).padStart(3, '0');
      item.documentation = new vscode.MarkdownString(e.description);
      return item;
    });
  }
}

class Formatter implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
    formatHunt(lines).forEach((text, i) => {
      if (text !== lines[i]) edits.push(vscode.TextEdit.replace(document.lineAt(i).range, text));
    });
    return edits;
  }
}

class Symbols implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    return parseHunt(document.getText()).steps.map((s) => {
      const range = new vscode.Range(s.line, 0, s.endLine, document.lineAt(s.endLine).text.length);
      return new vscode.DocumentSymbol(
        s.label || s.header,
        '',
        vscode.SymbolKind.Function,
        range,
        document.lineAt(s.line).range,
      );
    });
  }
}

class Lenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly services: Services) {
    services.onDidChange(() => this.changed.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== 'file') return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, { title: '$(play) Run', command: 'manulBrowser.runFile', arguments: [document.uri] }),
      new vscode.CodeLens(top, { title: '$(debug-alt) Debug', command: 'manulBrowser.debugFile', arguments: [document.uri] }),
    ];
    const settings = this.services.settings(document.uri);
    const hooks = this.services.hooksFor(document.uri);
    if (hooks) {
      const n = hooks.scan.handlers.length;
      lenses.push(
        new vscode.CodeLens(top, {
          title: `$(plug) ${this.services.relative(hooks.script)}${n ? ` (${n})` : ''}`,
          tooltip: 'The hook script every run of this hunt is given',
          command: 'vscode.open',
          arguments: [vscode.Uri.file(hooks.script)],
        }),
      );
    } else if (!settings.hooksEnabled) {
      lenses.push(new vscode.CodeLens(top, { title: '$(plug) hooks off', command: 'manulBrowser.toggleHooks' }));
    }
    return lenses;
  }
}

class Definitions implements vscode.DefinitionProvider {
  constructor(private readonly services: Services) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location | undefined {
    const m = document.lineAt(position.line).text.match(RE_CALL);
    if (!m) return undefined;
    const hooks = this.services.hooksFor(document.uri);
    const handler = hooks?.scan.handlers.find((h) => h.kind === 'call' && h.name === m[1]);
    if (!hooks || !handler) return undefined;
    return new vscode.Location(vscode.Uri.file(hooks.script), new vscode.Position(handler.line, 0));
  }
}

/**
 * Says so when a hunt calls host code that nothing will answer. These are
 * hints, not errors: a handler can be registered in ways a read of the file
 * cannot see, and an engine built from Go carries its own.
 */
class CallDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('manulBrowser');
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly services: Services) {
    const check = (doc: vscode.TextDocument): void => this.check(doc);
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(check),
      vscode.workspace.onDidChangeTextDocument((e) => check(e.document)),
      vscode.workspace.onDidSaveTextDocument(() => vscode.workspace.textDocuments.forEach(check)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.collection.delete(doc.uri)),
      services.onDidChange(() => vscode.workspace.textDocuments.forEach(check)),
    );
    vscode.workspace.textDocuments.forEach(check);
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.collection.dispose();
  }

  private check(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'hunt' || doc.uri.scheme !== 'file') return;
    const calls = parseHunt(doc.getText()).calls;
    if (calls.length === 0) return this.collection.delete(doc.uri);

    const hooks = this.services.hooksFor(doc.uri);
    const enabled = this.services.settings(doc.uri).hooksEnabled;
    const known = new Set(hooks?.scan.handlers.filter((h) => h.kind === 'call').map((h) => h.name));
    const diagnostics: vscode.Diagnostic[] = [];
    for (const call of calls) {
      const text = doc.lineAt(call.line).text;
      const start = text.indexOf(call.name);
      const range = new vscode.Range(call.line, Math.max(0, start), call.line, Math.max(0, start) + call.name.length);
      let message = '';
      if (!hooks) {
        message = enabled
          ? `No hook script found for this hunt, so nothing answers CALL ${call.name} unless the engine has it built in. Create manul_hooks.py or manul_hooks.mjs at or above this file.`
          : `Hook pickup is off, so nothing answers CALL ${call.name} unless the engine has it built in.`;
      } else if (hookRuntime(hooks.script) !== 'native' && !known.has(call.name)) {
        message = `"${call.name}" is not registered in ${this.services.relative(hooks.script)} — at least not in a way that can be read from the file.`;
      }
      if (message) {
        const d = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Information);
        d.source = 'manul';
        diagnostics.push(d);
      }
    }
    this.collection.set(doc.uri, diagnostics);
  }
}

export function registerLanguage(services: Services): vscode.Disposable[] {
  return [
    vscode.languages.registerCompletionItemProvider(HUNT, new Completions(services), '@', '[', '{'),
    vscode.languages.registerDocumentFormattingEditProvider(HUNT, new Formatter()),
    vscode.languages.registerDocumentSymbolProvider(HUNT, new Symbols()),
    vscode.languages.registerCodeLensProvider(HUNT, new Lenses(services)),
    vscode.languages.registerDefinitionProvider(HUNT, new Definitions(services)),
    new CallDiagnostics(services),
  ];
}
