#!/usr/bin/env node
// Copies the canonical ddot.it TextMate grammar into ./syntaxes/ so vsce can
// bundle it. Runs as `postinstall` and `vscode:prepublish`.
//
// Source preference:
//   1. a sibling `ddot.it-syntax-tools` checkout, if one exists
//   2. the @calpano/ddot-textmate-grammar npm package
//
// The sibling comes FIRST so local development never validates against a stale
// PUBLISHED grammar. Without this, editing the grammar next door and running
// `npm install` here silently replaced it with whatever was last released, and
// the extension would highlight with a different grammar than the conformance
// suite tests — with nothing to warn you.
//
// Publishing is unaffected: a released extension has no sibling checkout, so it
// falls through to the package.

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const sibling = resolve(root, "../ddot.it-syntax-tools/textmate/ddot.tmLanguage.json");
const pkg = resolve(root, "node_modules/@calpano/ddot-textmate-grammar/ddot.tmLanguage.json");

const useSibling = existsSync(sibling);
const src = useSibling ? sibling : pkg;
const dst = resolve(root, "syntaxes/ddot.tmLanguage.json");

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`installed grammar (${useSibling ? "sibling checkout" : "npm package"}): ${src} → ${dst}`);
