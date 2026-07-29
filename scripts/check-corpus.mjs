#!/usr/bin/env node
// Asserts this extension's tokenizer and event exporter against the shared
// cross-implementation corpus in ../ddot.it/test-data/cases/.
//
// Both files here are MIRRORS: the TextMate grammar (ddot.it-syntax-tools) is
// canonical for expected.tokens.json, and the Java DdotEventExporter
// (ddot.it-intellij) is canonical for expected.events.jsonl. So this script only
// ever asserts — it never rewrites a golden. If it fails, fix the mirror.
//
// Run: npm run check-corpus   (needs `npm run compile` first)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const { tokenize, toJson } = await import(resolve(root, 'out/tokenizer.js'));
const { parseEvents, toJsonl } = await import(resolve(root, 'out/events.js'));

const casesDir = resolve(root, '../ddot.it/test-data/cases');
if (!existsSync(casesDir)) {
  console.warn(`[corpus] WARNING: ${casesDir} not found — skipping. Clone`
    + ' https://github.com/calpano/ddot.it as a sibling of this repo.');
  process.exit(0);
}

const EVENT_KIND = 'ddot';
const EVENT_SOURCE = 'input.ddot';

let checked = 0;
const failures = [];

for (const name of readdirSync(casesDir).sort()) {
  const dir = join(casesDir, name);
  const input = join(dir, 'input.ddot');
  if (!existsSync(input)) continue;
  const text = readFileSync(input, 'utf8');

  check(`${name} [tokens]`, join(dir, 'expected.tokens.json'), toJson(tokenize(text)));
  check(`${name} [events]`, join(dir, 'expected.events.jsonl'),
    toJsonl(parseEvents(text, EVENT_KIND, EVENT_SOURCE)));
  checked++;
}

function check(label, expectedPath, actual) {
  if (!existsSync(expectedPath)) {
    failures.push(`${label}: missing ${expectedPath}`);
    return;
  }
  const want = readFileSync(expectedPath, 'utf8');
  if (want !== actual) {
    failures.push(`${label}\n  expected: ${JSON.stringify(want)}\n  actual  : ${JSON.stringify(actual)}`);
  }
}

if (failures.length > 0) {
  console.error(`[corpus] ${failures.length} failure(s) across ${checked} case(s):\n`);
  for (const f of failures) console.error(f + '\n');
  process.exit(1);
}
console.log(`[corpus] ok — ${checked} cases, tokens + events byte-identical`);
