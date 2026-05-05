# ddot.it — VS Code support

Authoring support for **ddot.it**, a minimal text format for typed knowledge graphs. Each line is a triple — `subject ..predicate.. object` — written with double-dot separators.

## What is ddot.it?

[ddot.it](https://ddot.it) is a line-oriented graph notation built around two separators:

- `..` — typed link: `subject ..predicate.. object`
- `....` — simple (untyped) link: `subject .... object`

Continuations and metadata extend a triple without repeating the subject:

```ddot
Project Eagle ..started in.. 2024
..doc site.. example.com/docbase/8dcjsid

John Doe ..leads.. Project Eagle ,, ..since.. 2025

Project Eagle .... Moonshot

Dirk Hagemann ..works at.. SAP ,,
..year.. 2010
..fictive.. yes
,,
```

Lines starting with `..` continue the previous subject. `,,` opens metadata; a closing `,,` ends a multi-line metadata block.

For the full format spec and the canonical event JSON shape, see the [ddot.it Developer Guide → Events](https://ddot.it/developer-guide.html#events).

## What this extension does

- **Syntax highlighting** for `.ddot` files.
- **Smart completions** that understand triple slots:
  - typing in the subject slot suggests known subjects;
  - typing in the predicate slot suggests known predicates;
  - typing in the object slot suggests known objects.
  - Multi-word entities (e.g. `John Doe`) complete as a single unit — VS Code's word-level filtering is overridden so spaces don't break suggestions.
  - Suggestions are **prefix-matched** (case-insensitive), not fuzzy — so typing a brand-new entity name doesn't surface unrelated entities and ENTER goes to a newline as expected.
  - Picking a subject auto-inserts ` ..` and surfaces predicates; picking a predicate auto-inserts `.. ` and surfaces objects; picking an object inserts a newline ready for the next triple.
  - On a fresh line after a complete triple (continuation context), suggestions auto-open with `..rel..`-form predicates so a new continuation triple needs only two picks.
  - When the cursor sits right after `..`, predicates show as `..rel..` items whose range absorbs the existing `..` (no doubled dots on accept).
- **Canonical formatter** (Format Document):
  - Typed link → `subject ..predicate.. object`
  - Simple link → `subject .... object`
  - Continuation → `..predicate.. object`
  - Metadata → ` ,, content` inline, ` ,,` at end of line
- **Document symbols** — every distinct subject in the file is listed in the outline.
- **Folding** — collapses a subject and its continuation lines.
- **Commands** (Command Palette):
  - `ddot.it: Format Document`
  - `ddot.it: Validate Document`
  - `ddot.it: Export as JSON` — emits one [triple event](https://ddot.it/developer-guide.html#events) per line (JSONL) with fields `from`, `type`, `to`, `meta`, `kind`, `source`, `location`. Continuation lines, simple links (`....`), and inline / multi-line metadata (`,,`) all parse into the same event shape so the output drops straight into a ddot.it collector.

## Using it

1. Open any `.ddot` file. Highlighting and completions activate automatically.
2. Start a new triple by typing a subject; press the suggested entry or keep typing for a new one.
3. Type `..` to advance to the predicate slot. The menu shows `..rel..` items — pick one to fill in the predicate and the closing separator in one go.
4. Pick or type an object, press ENTER. If a complete triple precedes you, suggestions reopen automatically with `..rel..` items so the next triple needs only two picks.
5. Run **Format Document** at any time to normalize spacing to the canonical form.

### Keyboard tips

- `Ctrl+Space` — manually invoke suggestions.
- `Tab` / `Enter` — accept the highlighted suggestion. (If `editor.acceptSuggestionOnEnter` is `off` in your settings, Enter always inserts a newline regardless.)
- `Esc` — dismiss the suggestions menu.

## Building from source

```bash
cd editor-support/vscode
npm install
npm run compile     # or: npm run watch
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded. Open or create a `.ddot` file in the host window to try it.

## Status

The language is stable. This extension is usable right now.
