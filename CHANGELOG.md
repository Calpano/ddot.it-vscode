# Changelog

## 0.0.8

### Autocompletion

- **Completion knows where the cursor actually is.** It used to decide what
  to offer by re-splitting the current line with its own regex, which could
  not see structure spanning lines. So it offered subjects inside `!!block`
  bodies, ignored metadata context, and completed inside regions turned off
  with `!!off`. The cursor slot is now derived from the same tokenizer the
  highlighter and `Export as JSON` use, so all three agree on what a
  position means.
- **Metadata gets its own vocabulary.** Meta relations and meta objects are
  now indexed as separate pools rather than being lumped in with predicates
  and objects, so `,, ` completions no longer suggest terms that only ever
  appear in triples.
- **Ranking follows the Autocomplete Specification's query catalog.**
  Each slot draws on its own pool first, then the rest of its family —
  value-like (subject / object / meta-object) or relation-like (predicate /
  meta-relation). A relation-like slot never offers values. Inference ranks
  candidates rather than filtering them, so a term you have used before
  stays reachable even in an unusual position.
- **Frequency-ranked.** Within a pool, candidates are ordered by how often
  they occur, and terms from the current file outrank terms from elsewhere
  in the workspace.

### Tooling

- `npm run check-corpus` asserts both the token stream and the event stream
  against the shared `test-data/cases/` corpus in the sibling `ddot.it`
  repository — 33 cases, byte-identical. The tokenizer is shared across
  implementations, and this is what keeps it that way.
- `install-grammar` now prefers a sibling `ddot.it-syntax-tools` checkout
  over the published npm package. Editing the grammar next door and running
  `npm install` here used to replace it silently with the last *released*
  grammar, so the extension highlighted with something other than what the
  conformance suite tests. Packaging is unaffected: with no sibling present
  it falls through to the npm package.

## 0.0.7

### Grammar

- **Disabled spans (`ddot.it/off` … `ddot.it/on`)** — content between the
  markers is now scoped as `comment.block.disabled.ddot` and rendered as a
  flat comment by the editor; the markers themselves keep
  `keyword.control.ddot`.
- **`!!` shorthand** — `!!off` / `!!on` work as equivalents to
  `ddot.it/off` / `ddot.it/on`. Generally `!!<word>` is recognised
  alongside `ddot.it/<word>` as a `keyword.control.ddot`.
- **Inline metadata sub-tokens** — content after `,, …` on the same line
  now emits distinct `comment.metadata.{operator,relation,object}.ddot`
  scopes instead of a single uniform comment scope. Block-metadata bodies
  unchanged.
- **`Alpha .. .. Beta` is now untyped** — fixed a pattern-ordering bug
  where the typed-triple regex's relation capture allowed a single
  whitespace as a relation. Untyped is now tried first, so `.. ..` and
  `....` are equivalent untyped-link operators.
- **Untyped continuations in metadata** — `,, .... value` now emits the
  expected operator + object scopes.

### Parser (Export as JSON)

- Empty relation between two `..` separators now produces an untyped event
  rather than dropping the line. Brings the TS parser in line with the
  highlighter.
- `ddot.it/off` / `ddot.it/on` (and the new `!!off` / `!!on` shorthand)
  open and close a muted span. Lines inside are skipped by `Export as
  JSON`. The Java parser had this since 0.0.9 of the IntelliJ plugin; this
  back-ports the same behaviour to VS Code.

### Tooling

- The TextMate grammar is now sourced from the
  `@calpano/ddot-textmate-grammar` npm package (currently wired as a
  `file:` dep on the sibling `ddot.it-syntax-tools` repo). The
  `vscode:prepublish` and `postinstall` scripts copy the canonical grammar
  into `syntaxes/` before packaging.

## 0.0.6

Initial public release on the VS Code Marketplace.
