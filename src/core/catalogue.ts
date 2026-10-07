// What can be written in a .hunt file.
//
// The extension ships a catalogue taken from the DSL contract, with snippets
// and descriptions. An installed engine may be newer or older than that copy,
// so whatever `manul schema` reports is merged over it: a verb the engine
// knows and the catalogue does not still shows up, with the engine's own
// syntax line.

import * as fs from 'fs';

export interface CatalogueEntry {
  id: string;
  label: string;
  /** The line as it would be typed, with empty quotes where a value goes. */
  uiText: string;
  /** VS Code snippet syntax. */
  snippet: string;
  description: string;
  category: string;
  /** True when the entry came from the installed engine, not the bundled copy. */
  live?: boolean;
}

export interface Catalogue {
  version: string;
  commands: CatalogueEntry[];
  metadata: CatalogueEntry[];
  blocks: CatalogueEntry[];
}

export const CATEGORY_ORDER = [
  'structure',
  'navigation',
  'interaction',
  'keyboard',
  'assertion',
  'wait',
  'data',
  'control_flow',
  'network',
  'host',
  'utility',
  'other',
];

export const CATEGORY_TITLES: Record<string, string> = {
  structure: 'Structure',
  navigation: 'Navigation',
  interaction: 'Interaction',
  keyboard: 'Keyboard',
  assertion: 'Assertions',
  wait: 'Waiting',
  data: 'Data',
  control_flow: 'Control flow',
  network: 'Network',
  host: 'Host code',
  utility: 'Utility',
  other: 'Other',
  metadata: 'File headers',
  blocks: 'Setup and teardown',
};

interface RawEntry {
  id?: string;
  label?: string;
  uiText?: string;
  snippet?: string;
  description?: string;
  category?: string;
  openTag?: string;
}

const entry = (raw: RawEntry, category: string): CatalogueEntry => ({
  id: raw.id ?? raw.label ?? '',
  label: raw.label ?? raw.openTag ?? raw.id ?? '',
  uiText: raw.uiText ?? raw.openTag ?? raw.label ?? '',
  snippet: raw.snippet ?? raw.uiText ?? raw.label ?? '',
  description: raw.description ?? '',
  category: raw.category ?? category,
});

export function loadBundledCatalogue(file: string): Catalogue {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    version?: string;
    commands?: RawEntry[];
    metadata?: RawEntry[];
    hookBlocks?: RawEntry[];
  };
  return {
    version: raw.version ?? '',
    commands: (raw.commands ?? []).map((c) => entry(c, 'other')),
    metadata: (raw.metadata ?? []).map((c) => entry(c, 'metadata')),
    blocks: (raw.hookBlocks ?? []).map((c) => entry(c, 'blocks')),
  };
}

export interface SchemaVerb {
  verb: string;
  syntax: string;
  note?: string;
}

/**
 * `Fill '<label>' with '<value>'` → `Fill '${1:label}' with '${2:value}'`.
 * Alternatives (`down|up|to`) become a choice.
 */
export function syntaxToSnippet(syntax: string): string {
  let n = 0;
  return syntax
    .replace(/[$}\\]/g, '\\$&')
    .replace(/<([^<>]+)>/g, (_m, name: string) => `\${${++n}:${name}}`)
    .replace(/\b([A-Za-z]+(?:\|[A-Za-z]+)+)\b/g, (_m, alts: string) => `\${${++n}|${alts.split('|').join(',')}|}`);
}

const key = (s: string): string => s.toUpperCase().replace(/[^A-Z]+/g, ' ').trim();

/** Bundled catalogue plus whatever the installed engine reports beyond it. */
export function mergeSchema(base: Catalogue, schema: { version?: string; verbs?: SchemaVerb[] }): Catalogue {
  const known = new Set(base.commands.map((c) => key(c.label)));
  // `CALL GO` in a schema is `CALL HOST` in the catalogue, and so on.
  const covered = (verb: string): boolean => {
    const k = key(verb);
    if (known.has(k)) return true;
    const head = k.split(' ')[0];
    return [...known].some((have) => have.split(' ')[0] === head);
  };
  const extra: CatalogueEntry[] = [];
  for (const v of schema.verbs ?? []) {
    if (!v.verb || covered(v.verb)) continue;
    extra.push({
      id: `live:${v.verb}`,
      label: v.verb,
      uiText: v.syntax,
      snippet: syntaxToSnippet(v.syntax),
      description: v.note ?? '',
      category: 'other',
      live: true,
    });
  }
  return { ...base, version: schema.version || base.version, commands: [...base.commands, ...extra] };
}

/** Commands grouped for display, groups in a fixed order, empty ones dropped. */
export function grouped(cat: Catalogue): Array<{ id: string; title: string; entries: CatalogueEntry[] }> {
  const groups = new Map<string, CatalogueEntry[]>();
  for (const c of cat.commands) {
    const id = CATEGORY_ORDER.includes(c.category) ? c.category : 'other';
    groups.set(id, [...(groups.get(id) ?? []), c]);
  }
  const out = CATEGORY_ORDER.filter((id) => groups.has(id)).map((id) => ({
    id,
    title: CATEGORY_TITLES[id],
    entries: groups.get(id) ?? [],
  }));
  out.push({ id: 'metadata', title: CATEGORY_TITLES.metadata, entries: cat.metadata });
  out.push({ id: 'blocks', title: CATEGORY_TITLES.blocks, entries: cat.blocks });
  return out.filter((g) => g.entries.length > 0);
}
