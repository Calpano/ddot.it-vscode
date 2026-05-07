#!/usr/bin/env node
// Copies the canonical ddot.it TextMate grammar from the
// @calpano/ddot-textmate-grammar npm package into ./syntaxes/ so vsce
// can bundle it. Runs as `postinstall` and `vscode:prepublish`.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src  = resolve(root, "node_modules/@calpano/ddot-textmate-grammar/ddot.tmLanguage.json");
const dst  = resolve(root, "syntaxes/ddot.tmLanguage.json");

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`installed grammar: ${src} → ${dst}`);
