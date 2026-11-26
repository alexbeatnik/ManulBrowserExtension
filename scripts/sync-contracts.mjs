#!/usr/bin/env node
// Regenerates the two files this extension copies from the engine's contracts:
//
//   data/dsl.json                     ← spec/contracts/MANUL_DSL_CONTRACT.md
//   schemas/manul.config.schema.json  ← spec/contracts/MANUL_CONFIG_CONTRACT.md
//
// The contracts in alexbeatnik/manul-browser describe what the engine ships,
// so they are the source; these files are only ever regenerated, never edited
// by hand.
//
//   node scripts/sync-contracts.mjs ../manul-browser

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const engineRepo = path.resolve(process.argv[2] ?? path.join(root, '..', 'manul-browser'));

/** The JSON block every contract embeds. */
function contract(name) {
  const file = path.join(engineRepo, 'spec', 'contracts', name);
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`${file} has no JSON block`);
  return JSON.parse(m[1]);
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

function write(rel, data) {
  fs.writeFileSync(path.join(root, rel), JSON.stringify(data, null, rel.startsWith('data') ? 1 : 2) + '\n');
  console.log(`wrote ${rel}`);
}

// DSL — what completion, the Step Palette and hovers show. The regexes stay in
// the engine: matching a line to a verb is the engine's job.
const dsl = contract('MANUL_DSL_CONTRACT.md');
write('data/dsl.json', {
  version: dsl.version,
  commands: dsl.commands.map((c) => pick(c, ['id', 'label', 'uiText', 'snippet', 'description', 'category'])),
  metadata: dsl.metadata.map((c) => pick(c, ['id', 'label', 'uiText', 'snippet', 'description'])),
  hookBlocks: dsl.hookBlocks.map((c) => pick(c, ['id', 'label', 'openTag', 'closeTag', 'snippet', 'description'])),
  qualifiers: dsl.contextualQualifiers.map((c) => pick(c, ['id', 'syntax', 'description'])),
});

// Config — validation and completion for manul.config.json.
const cfg = contract('MANUL_CONFIG_CONTRACT.md');
const jsonType = (t) => {
  const one = (s) => {
    s = s.trim();
    if (s === 'str' || s === 'string') return { type: 'string' };
    if (s === 'null') return { type: 'null' };
    if (s === 'boolean' || s === 'bool') return { type: 'boolean' };
    if (s === 'integer' || s === 'int') return { type: 'integer' };
    if (s.endsWith('[]')) return { type: 'array', items: one(s.slice(0, -2)) };
    throw new Error(`unknown config type ${s}`);
  };
  const parts = t.split('|').map(one);
  if (parts.length === 1) return parts[0];
  if (parts.every((p) => !p.items)) return { type: parts.map((p) => p.type) };
  return { anyOf: parts };
};
const properties = {};
for (const k of cfg.keys) {
  const prop = jsonType(k.type);
  let description = k.description;
  if (k.unit) description += ` In ${k.unit}.`;
  if (k.envVar) description += ` Environment variable: ${k.envVar}.`;
  prop.description = description;
  // A deprecated value still works, but completion should not offer it.
  const deprecated = k.deprecatedValue?.value;
  if (k.allowedValues) prop.enum = k.allowedValues.filter((v) => v !== deprecated);
  if (k.minimum !== undefined) prop.minimum = k.minimum;
  if (k.default !== undefined && k.default !== '') prop.default = k.default;
  properties[k.key] = prop;
}
write('schemas/manul.config.schema.json', {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'manul.config.json',
  description: `Configuration for the manul-browser engine (contract ${cfg.version}). Command-line flags override these values; environment variables override the file. Keys the engine does not know are ignored.`,
  type: 'object',
  properties,
});
