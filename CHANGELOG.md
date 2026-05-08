# Changelog

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
