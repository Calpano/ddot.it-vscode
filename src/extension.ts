import * as vscode from 'vscode';
import { DdotEvent, parseEvents, toJsonl } from './events';

const DDOT_LANGUAGE = 'ddot.it';

// Formatter Provider
//
// Canonical line shapes:
//   Typed link:        `subject ..predicate.. object`
//   Continuation:      `..predicate.. object`
//   Simple link:       `subject .... object`
//   Continuation:      `.... object`
// Metadata `,,` splits a line into independently-formatted parts joined by ` ,, `.
// subject .. relation .. object (relation empty ⇒ untyped `....`). Subject and relation contain no `..`;
// the object is the rest and may contain `..` (a URL or relative path) as long as the operator is followed
// by a non-dot — matching the canonical parser (DdotEventExporter) and the TextMate grammar.
const TRIPLE_RE = /^((?:(?!\.\.).)*)\.\.((?:(?!\.\.).)*)\.\.((?!\.).+)$/;

function formatDdotPart(text: string): string {
  const m = TRIPLE_RE.exec(text);
  if (!m) return text.trim(); // not a well-formed triple — leave it alone rather than guess

  const s = m[1].trim();
  const p = m[2].trim();
  const o = m[3].trim();
  const head = p === ''
    ? (s === '' ? `....` : `${s} ....`)
    : (s === '' ? `..${p}..` : `${s} ..${p}..`);
  return o === '' ? head : `${head} ${o}`;
}

function formatDdotLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed === '') return line.trimEnd();
  if (trimmed === ',,') return ',,';

  // Each ,,-separated part is formatted independently. ' ,, ' joins them; a
  // trailing empty part becomes ' ,,' (line ends in ,, then newline).
  const parts = trimmed.split(',,').map(formatDdotPart);
  return parts
    .reduce<string>((acc, p, i) => {
      if (i === 0) return p;
      return p === '' ? `${acc} ,,` : `${acc} ,, ${p}`;
    }, '')
    .trim();
}

class DdotFormatter implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.TextEdit[]> {
    const text = document.getText();
    const lines = text.split('\n');
    const formatted = lines.map(formatDdotLine).join('\n');

    if (formatted === text) return [];

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(text.length)
    );
    return [vscode.TextEdit.replace(fullRange, formatted)];
  }
}

// Code Folding Provider
class DdotFoldingRangeProvider implements vscode.FoldingRangeProvider {
  provideFoldingRanges(
    document: vscode.TextDocument,
    context: vscode.FoldingContext,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.FoldingRange[]> {
    const ranges: vscode.FoldingRange[] = [];
    const lines = document.getText().split('\n');
    let currentStart: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Start a fold region when we see a triple (subject .. predicate .. object)
      if (line.includes('..')) {
        if (currentStart === null) {
          currentStart = i;
        }
      }
      
      // End fold region at blank lines
      if (line === '' && currentStart !== null && i > currentStart) {
        ranges.push(new vscode.FoldingRange(currentStart, i - 1));
        currentStart = null;
      }
    }

    // Close any open range
    if (currentStart !== null && lines.length > currentStart + 1) {
      ranges.push(new vscode.FoldingRange(currentStart, lines.length - 1));
    }

    return ranges;
  }
}

// Document Symbol Provider
class DdotDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.SymbolInformation[] | vscode.DocumentSymbol[]> {
    const symbols: vscode.DocumentSymbol[] = [];
    const text = document.getText();
    const lines = text.split('\n');
    const subjects = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line === '') continue;
      // Skip continuation/metadata lines (no subject of their own)
      if (line.startsWith('..') || line.startsWith(',,')) continue;

      // Extract subject (everything before first ..) — supports multi-word
      const match = line.match(/^(.+?)\s*\.\./);
      if (match && match[1]) {
        const subject = match[1].trim();

        if (!subjects.has(subject)) {
          subjects.add(subject);
          const position = new vscode.Position(i, 0);
          const symbol = new vscode.DocumentSymbol(
            subject,
            'Entity',
            vscode.SymbolKind.Variable,
            new vscode.Range(position, position.translate(0, subject.length)),
            new vscode.Range(position, position.translate(0, subject.length))
          );
          symbols.push(symbol);
        }
      }
    }

    return symbols;
  }
}

// Completion Provider
//
// Slot detection follows ddot-it-autocomplete.adoc#cursor-state: run the parse
// automaton over the line prefix and read the slot off the state it reaches.
// There is deliberately no second grammar — the automaton is prefix-driven, so
// a half-written line lands in a sensible state on its own (typing `Dir`
// reaches Subject), and it is defined over real DT2/DT4 tokens, so stray runs
// of dots cannot be miscounted as separators.
type Role = 'subject' | 'predicate' | 'object' | 'meta-relation' | 'meta-object';

// The Autocomplete Specification's query catalog: for each cursor slot, the
// pools to draw on in ranking order. The two families are value-like
// (s / o / mo) and relation-like (p / mr); each query lists its own slot, then
// the rest of its family, then the other family. A relation-like cursor never
// leaves its family.
const QUERY_CATALOG: Record<Role, Role[]> = {
  subject: ['subject', 'object', 'meta-object', 'predicate', 'meta-relation'],
  predicate: ['predicate', 'meta-relation'],
  object: ['object', 'subject', 'meta-object', 'predicate', 'meta-relation'],
  'meta-relation': ['meta-relation', 'predicate'],
  'meta-object': ['meta-object', 'object', 'subject', 'meta-relation', 'predicate'],
};
const ROLES: Role[] = [
  'subject',
  'predicate',
  'object',
  'meta-relation',
  'meta-object',
];

// --- lexical tokens (Parse Spec, "Token Sequences") ------------------------
// Runs of EXACTLY n, neither preceded nor followed by the same character. The
// lookarounds are load-bearing: `\.{2}` alone matches the first two dots of
// `...`, which the tokenization rule forbids.
const DT2_SRC = String.raw`(?<!\.)\.{2}(?!\.)`;
const QUAD_SRC = String.raw`(?<!\.)(?:\.{4}|\.{2}[ \t]+\.{2})(?!\.)`;
const CM2_SRC = String.raw`(?<!,),,(?!,)`;
const SC2_SRC = String.raw`(?<!;);;(?!;)`;
// A command needs the slash and a non-empty name; bare `ddot.it` is not one.
// `?` and `#` do not terminate a command — they introduce its query/fragment.
const CMD_SRC = String.raw`(?:(?:https?://)?ddot\.it/|!!)[^\s?#]+(?:\?[^\s#]*)?(?:#\S*)?`;
const BLOCK_SRC = String.raw`(?:(?:https?://)?ddot\.it/|!!)block`;

const CMD_RE = new RegExp(CMD_SRC);
const CMD_ONLY_RE = new RegExp(`^${CMD_SRC}$`);
// Recognised ANYWHERE on a line, so the usual host-language comment forms work:
// `<!-- ddot.it/off -->`, `# !!off`, `// !!on`. `(?![^\s?#])` pins the command
// name so `!!office` is not `!!off`.
const OFF_RE = /(?:(?:https?:\/\/)?ddot\.it\/|!!)off(?![^\s?#])/;
const ON_RE = /(?:(?:https?:\/\/)?ddot\.it\/|!!)on(?![^\s?#])/;
// A block opener must END its physical line (block-as-field).
const BLOCK_OPENER_RE = new RegExp(`${BLOCK_SRC}(?:\\?end=(\\S+))?[ \t]*$`);

// Significant tokens, QUAD before DT2 so `.. ..` is ONE operator, not two.
const SIGNIFICANT_RE = new RegExp(
  `${QUAD_SRC}|${DT2_SRC}|${CM2_SRC}|${SC2_SRC}`,
  'g'
);

type AutomatonState =
  | 'StartOfLine'
  | 'Subject'
  | 'RelationStart'
  | 'Relation'
  | 'ObjectStart'
  | 'TripleObject'
  | 'MetaStart'
  | 'MetaRelationInline'
  | 'MetaObjectInline'
  | 'MetaNextInline'
  | 'MetaTextInline'
  | 'NotATriple';

// Automaton state → the slot whose candidates should be offered. States with
// no entry offer nothing (meta text, NotATriple).
const SLOT_OF: Partial<Record<AutomatonState, Role>> = {
  StartOfLine: 'subject',
  Subject: 'subject',
  RelationStart: 'predicate',
  Relation: 'predicate',
  ObjectStart: 'object',
  TripleObject: 'object',
  MetaStart: 'meta-relation',
  MetaRelationInline: 'meta-relation',
  MetaNextInline: 'meta-relation',
  MetaObjectInline: 'meta-object',
};

function onText(state: AutomatonState): AutomatonState {
  switch (state) {
    case 'StartOfLine':
      return 'Subject';
    case 'RelationStart':
      return 'Relation';
    case 'ObjectStart':
      return 'TripleObject';
    // Text after `,,` with no `..` is meta TEXT, not a meta relation.
    case 'MetaStart':
      return 'MetaTextInline';
    case 'MetaNextInline':
      return 'NotATriple';
    default:
      return state;
  }
}

function onToken(state: AutomatonState, tok: string): AutomatonState {
  const isQuad = /^\.{4}$|^\.{2}[ \t]+\.{2}$/.test(tok);
  const isDot = isQuad || /^\.{2}$/.test(tok);
  const isComma = /^,,$/.test(tok);
  const isSemi = /^;;$/.test(tok);

  if (isQuad) {
    // QuadDot carries the implicit relation, so the relation slot is skipped.
    switch (state) {
      case 'StartOfLine':
      case 'Subject':
        return 'ObjectStart';
      case 'MetaStart':
      case 'MetaNextInline':
        return 'MetaObjectInline';
      case 'TripleObject':
      case 'MetaObjectInline':
        return state; // an object may contain `..`
      default:
        return 'NotATriple';
    }
  }
  if (isDot) {
    switch (state) {
      case 'StartOfLine':
      case 'Subject':
        return 'RelationStart';
      case 'RelationStart': // `.. ..` typed as two separate DT2
      case 'Relation':
        return 'ObjectStart';
      case 'TripleObject':
        return 'TripleObject'; // the object may contain `..`
      case 'MetaStart':
      case 'MetaNextInline':
        return 'MetaRelationInline';
      case 'MetaRelationInline':
        return 'MetaObjectInline';
      case 'MetaObjectInline':
        return 'MetaObjectInline';
      default:
        return 'NotATriple';
    }
  }
  if (isComma) {
    switch (state) {
      case 'TripleObject':
      case 'ObjectStart':
        return 'MetaStart';
      default:
        return 'NotATriple';
    }
  }
  if (isSemi) {
    // `;;` separates inline meta pairs; elsewhere it is ordinary text.
    return state === 'MetaObjectInline' ? 'MetaNextInline' : state;
  }
  return state;
}

// Run the automaton over the text before the cursor and return the slot.
function slotForLinePrefix(prefix: string): Role | null {
  let state: AutomatonState = 'StartOfLine';
  let last = 0;
  for (const m of prefix.matchAll(SIGNIFICANT_RE)) {
    if (prefix.slice(last, m.index).trim() !== '') state = onText(state);
    state = onToken(state, m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  if (prefix.slice(last).trim() !== '') state = onText(state);
  return SLOT_OF[state] ?? null;
}

// Name -> occurrence count. Counts, not a set, because the ranking spec orders
// candidates by descending corpus frequency (key 6); a set only records that a
// name exists, so a one-off typo would rank level with the most-used relation.
type Vocabulary = Record<Role, Map<string, number>>;

function emptyIndex(): Vocabulary {
  return {
    subject: new Map(),
    predicate: new Map(),
    object: new Map(),
    'meta-relation': new Map(),
    'meta-object': new Map(),
  };
}

type Region = 'plain' | 'excluded' | 'verbatim';

// Which pre-parse region a line sits in. Completion is silent in the inert
// ones (autocomplete spec, "Where completion fires").
function regionAt(document: vscode.TextDocument, line: number): Region {
  let region: Region = 'plain';
  let blockEnd: string | null = null;
  for (let i = 0; i < line; i++) {
    const text = document.lineAt(i).text;
    if (region === 'excluded') {
      if (ON_RE.test(text)) region = 'plain';
      continue;
    }
    if (region === 'verbatim') {
      if (blockEnd !== null) {
        if (text.trim() === blockEnd) {
          region = 'plain';
          blockEnd = null;
        }
      } else if (text.trim() === '') {
        region = 'plain';
      }
      continue;
    }
    if (OFF_RE.test(text)) {
      region = 'excluded';
      continue;
    }
    const opener = BLOCK_OPENER_RE.exec(text);
    if (opener) {
      region = 'verbatim';
      blockEnd = opener[1] ?? null;
    }
  }
  return region;
}

// Returns the start index of a `..` separator that immediately precedes
// the cursor (allowing for trailing whitespace), but only if it's an
// isolated `..` — not part of a `....` simple-link separator. Returns
// null otherwise.
function findPrecedingDotDot(beforeCursor: string): number | null {
  let end = beforeCursor.length;
  while (end > 0 && /\s/.test(beforeCursor[end - 1])) end--;
  if (end < 2 || beforeCursor.substring(end - 2, end) !== '..') return null;
  if (end >= 3 && beforeCursor[end - 3] === '.') return null;
  return end - 2;
}

// True when an earlier line (since the most recent blank line) contains a
// complete triple — i.e. there is a current subject in scope, so a fresh
// line continues that subject and should suggest predicates as `..rel..`.
function isContinuationContext(
  document: vscode.TextDocument,
  line: number
): boolean {
  for (let i = line - 1; i >= 0; i--) {
    const text = document.lineAt(i).text.trim();
    if (text === '') return false;
    const seps: string[] = text.match(/\.{4}|\.{2}/g) ?? [];
    const dotDotCount = seps.filter((s) => s === '..').length;
    const hasSimple = seps.includes('....');
    if (dotDotCount >= 2 || hasSimple) return true;
  }
  return false;
}

class DdotCompletionProvider implements vscode.CompletionItemProvider {
  // Candidates from the file being edited, and from every other indexed file.
  // The spec ranks same-file above other-file, so they are kept apart.
  private sameFile: Vocabulary = emptyIndex();
  private otherFiles: Vocabulary = emptyIndex();

  // Command names seen anywhere, beyond the four built-ins.
  private corpusCommands = new Set<string>();

  // Harvest every slot value on a line by running the same automaton used for
  // cursor detection, so indexing and completion always agree about slots.
  private harvest(line: string, into: Vocabulary) {
    let state: AutomatonState = 'StartOfLine';
    let last = 0;
    const add = (text: string, st: AutomatonState) => {
      const value = text.trim();
      if (!value) return;
      const role = SLOT_OF[st];
      // Every occurrence counts, including repeats within one file.
      if (role) into[role].set(value, (into[role].get(value) ?? 0) + 1);
      const cmd = CMD_RE.exec(value);
      if (cmd && CMD_ONLY_RE.test(value)) {
        const name = value.replace(/^(?:(?:https?:\/\/)?ddot\.it\/|!!)/, '')
          .replace(/[?#].*$/, '');
        if (name) this.corpusCommands.add(name);
      }
    };
    for (const m of line.matchAll(SIGNIFICANT_RE)) {
      const between = line.slice(last, m.index);
      if (between.trim() !== '') {
        add(between, onText(state));
        state = onText(state);
      }
      state = onToken(state, m[0]);
      last = (m.index ?? 0) + m[0].length;
    }
    const tail = line.slice(last);
    if (tail.trim() !== '') add(tail, onText(state));
  }

  private indexText(text: string, into: Vocabulary) {
    const lines = text.split('\n');
    let region: Region = 'plain';
    let blockEnd: string | null = null;
    for (const line of lines) {
      // Inert regions contribute no candidates.
      if (region === 'excluded') {
        if (ON_RE.test(line)) region = 'plain';
        continue;
      }
      if (region === 'verbatim') {
        if (blockEnd !== null) {
          if (line.trim() === blockEnd) { region = 'plain'; blockEnd = null; }
        } else if (line.trim() === '') region = 'plain';
        continue;
      }
      if (OFF_RE.test(line)) { region = 'excluded'; continue; }
      const opener = BLOCK_OPENER_RE.exec(line);
      if (opener) { region = 'verbatim'; blockEnd = opener[1] ?? null; }
      this.harvest(line, into);
    }
  }

  // Other indexed files. Cached; refreshed when the workspace changes.
  private otherFilesLoaded = false;
  async loadOtherFiles(current: vscode.Uri) {
    this.otherFiles = emptyIndex();
    const uris = await vscode.workspace.findFiles('**/*.ddot', '**/node_modules/**', 500);
    for (const uri of uris) {
      if (uri.toString() === current.toString()) continue;
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        this.indexText(doc.getText(), this.otherFiles);
      } catch {
        // unreadable file: skip it rather than fail the whole completion
      }
    }
    this.otherFilesLoaded = true;
  }

  invalidateOtherFiles() {
    this.otherFilesLoaded = false;
  }

  updateEntities(document: vscode.TextDocument) {
    this.sameFile = emptyIndex();
    this.corpusCommands = new Set();
    this.indexText(document.getText(), this.sameFile);
    if (!this.otherFilesLoaded) void this.loadOtherFiles(document.uri);
  }

  // Candidates for a slot, in the Autocomplete Specification's query-catalog
  // order (pool first, then same-file before other-file). VS Code preserves the
  // order we return when `sortText` is set, so the rank is encoded there.
  //
  // Breadth is deliberate: an entity named as a subject elsewhere is a perfectly
  // good object, so the object query is `o, s, mo, p, mr`. Relation-like slots
  // stay inside their own family — offering values where a relation name belongs
  // would be a category error.
  private candidates(
    role: Role
  ): Array<{ value: string; here: boolean; from: Role; pool: number }> {
    const out: Array<{ value: string; here: boolean; from: Role; pool: number }> = [];
    const seen = new Set<string>();
    const pools = QUERY_CATALOG[role];
    // Within a (pool, locality) group: descending frequency (key 6), then
    // alphabetically (key 7). Map iteration order is insertion order, which
    // would otherwise make the list depend on which file was indexed first.
    const byRank = (
      [aName, aCount]: [string, number],
      [bName, bCount]: [string, number]
    ): number => {
      if (aCount !== bCount) return bCount - aCount;
      const a = aName.toLowerCase();
      const b = bName.toLowerCase();
      if (a !== b) return a < b ? -1 : 1;
      return aName < bName ? -1 : aName > bName ? 1 : 0;
    };
    for (let pool = 0; pool < pools.length; pool++) {
      const from = pools[pool];
      for (const here of [true, false]) {
        const source = here ? this.sameFile[from] : this.otherFiles[from];
        for (const [v] of [...source].sort(byRank)) {
          if (seen.has(v)) continue;
          seen.add(v);
          out.push({ value: v, here, from, pool });
        }
      }
    }
    return out;
  }

  // Which slot the cursor is authoring, per ddot-it-autocomplete.adoc#cursor-state.
  // Returns null in meta text, on a NotATriple line, and in inert regions.
  private getCursorRole(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Role | null {
    if (regionAt(document, position.line) !== 'plain') return null;
    const beforeCursor = document
      .lineAt(position.line)
      .text.substring(0, position.character);
    return slotForLinePrefix(beforeCursor);
  }

  // Find the range of the entity-in-progress at the cursor: from after the
  // most recent separator (.., ,,, ::, or line start) up to the cursor.
  private getEntityRange(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Range {
    const beforeCursor = document
      .lineAt(position.line)
      .text.substring(0, position.character);

    let lastSepEnd = 0;
    const sepRegex = new RegExp(`${QUAD_SRC}|${DT2_SRC}|${CM2_SRC}|${SC2_SRC}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = sepRegex.exec(beforeCursor)) !== null) {
      lastSepEnd = m.index + m[0].length;
    }

    let entityStart = lastSepEnd;
    while (
      entityStart < beforeCursor.length &&
      /\s/.test(beforeCursor[entityStart])
    ) {
      entityStart++;
    }

    return new vscode.Range(
      new vscode.Position(position.line, entityStart),
      position
    );
  }

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    this.updateEntities(document);

    const beforeCursor = document
      .lineAt(position.line)
      .text.substring(0, position.character);

    // NOTE: there used to be a bail-out here for a stray 3-dot run. It existed
    // to paper over slot detection that counted raw `..` occurrences and so
    // mis-read `...` as a separator. The automaton is defined over DT2/DT4, for
    // which `...` is ordinary text, so the special case is unnecessary — and it
    // was harmful: it suppressed the `....` separator snippet at exactly the
    // moment the user was typing toward it.

    const items: vscode.CompletionItem[] = [];
    const entityRange = this.getEntityRange(document, position);
    const prefix = document.getText(entityRange);
    const role = this.getCursorRole(document, position);

    // ── Command completion ────────────────────────────────────────────
    // All four spellings trigger it, not just `!!`. Built-ins first (ranked
    // by slot-appropriateness), then commands harvested from the corpus.
    const cmdStart = /(?:(?:https?:\/\/)?ddot\.it\/|!!)([^\s?#]*)$/.exec(beforeCursor);
    if (cmdStart) {
      const typed = cmdStart[1] ?? '';
      const cmdRange = new vscode.Range(
        new vscode.Position(position.line, position.character - typed.length),
        position
      );
      // `block` may only open in Subject, Object or MetaObject (block-as-field);
      // `this` names the current document, so it belongs in a Subject.
      // `off`/`on` are pre-parse commands and rank last inside any slot.
      const preferred: string[] =
        role === 'subject' ? ['this', 'block']
        : role === 'object' || role === 'meta-object' ? ['block']
        : [];
      const builtins = ['on', 'off', 'block', 'this'];
      const rest = [
        ...builtins.filter((c) => !preferred.includes(c) && c !== 'off' && c !== 'on'),
        ...[...this.corpusCommands].filter((c) => !builtins.includes(c)).sort(),
        // pre-parse commands last in a slot, first outside one
        ...(role === null ? [] : ['off', 'on']),
      ];
      const ordered = role === null
        ? ['off', 'on', 'block', 'this', ...[...this.corpusCommands].filter((c) => !builtins.includes(c)).sort()]
        : [...preferred, ...rest];

      const typedLower = typed.toLowerCase();
      let cmdRank = 0;
      for (const name of ordered) {
        if (typedLower && !name.toLowerCase().startsWith(typedLower)) continue;
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword);
        item.detail = builtins.includes(name) ? 'built-in command' : 'command (from corpus)';
        item.range = cmdRange;
        item.filterText = name;
        item.insertText = name;
        item.sortText = String(cmdRank++).padStart(4, '0');
        // `block` takes the only defined parameter; offer it straight after.
        if (name === 'block') {
          item.command = { title: 'Trigger Suggest', command: 'editor.action.triggerSuggest' };
        }
        items.push(item);
      }
      // Right after `block`, offer its `?end=` parameter. The marker VALUE is
      // not completed — it is an arbitrary string with nothing to draw on.
      if (/(?:(?:https?:\/\/)?ddot\.it\/|!!)block$/.test(beforeCursor)) {
        const item = new vscode.CompletionItem('?end=', vscode.CompletionItemKind.Property);
        item.detail = 'custom block terminator (blank lines then stay inside the block)';
        item.insertText = '?end=';
        items.push(item);
      }
      return items;
    }

    // Separator snippets — gated by what is syntactically valid at this slot.
    //   subject       → `..` (open relation), `....` (skip it, untyped link)
    //   predicate     → `..` (close relation)
    //   object        → `,,` (start meta)
    //   meta-relation → `..` (close meta relation)
    //   meta-object   → `;;` (next pair), `,,` (close a meta block)
    const allSnippets: Record<string, string> = {
      '..': 'Typed link separator',
      '....': 'Simple link separator',
      ',,': 'Metadata separator',
      ';;': 'Next metadata pair',
    };
    const validSnippets: Record<Role | 'meta', string[]> = {
      subject: ['..', '....'],
      predicate: ['..'],
      object: [',,'],
       'meta-relation': ['..'],
      'meta-object': [';;', ',,'],
      meta: ['..', ',,'],
    };
    // Only emit separator snippets when the user is mid-typing a separator
    // — i.e. the current segment ends in a run of `.` or `,` chars that
    // hasn't yet been recognized as a complete separator (`..`, `....`,
    // `,,` are absorbed by the slot walker, so they don't appear at the
    // tail of `prefix`). The snippet then *replaces* that trailing run
    // rather than inserting after it.
    const trailingSepMatch = prefix.match(/[.,;]+$/);
    const trailingSep = trailingSepMatch ? trailingSepMatch[0] : '';
    const wantsSnippets = trailingSep.length > 0;

    if (wantsSnippets) {
      const snippetLabels = role ? validSnippets[role] : validSnippets.meta;
      const snippetRange = new vscode.Range(
        new vscode.Position(
          position.line,
          position.character - trailingSep.length
        ),
        position
      );
      for (const label of snippetLabels) {
        const item = new vscode.CompletionItem(
          label,
          vscode.CompletionItemKind.Snippet
        );
        item.detail = allSnippets[label];
        // Replace the partial separator (e.g. `.` → `..`, `,` → `,,`).
        item.filterText = label;
        item.insertText = label;
        item.range = snippetRange;
        items.push(item);
      }
    }

    // When the cursor sits right after a `..` separator with no predicate
    // text typed yet (e.g. `subject..|` or `..|` on a continuation line),
    // surface predicates as `..rel..` items whose range covers the
    // preceding `..` — accepting yields `subject..rel.. ` (cursor in
    // object slot) instead of doubled dots.
    const afterDotDot =
      role === 'predicate' && prefix === '' && findPrecedingDotDot(beforeCursor);

    // Add entities matching the current role only — replace the full
    // entity-in-progress range so multi-word entities complete correctly.
    // For predicates, append `.. ` so selecting auto-closes the predicate
    // and advances to the object slot.
    //
    // Only suggest entities that PREFIX-match what the user has typed
    // (case-insensitive). VSCode's default fuzzy/subsequence matching is
    // too aggressive — typing a new entity like `ccc` would otherwise
    // surface unrelated entities containing those letters and ENTER
    // would commit one. Prefix matching keeps normal typing un-intrusive.
    // Skip bare-name predicate suggestions in the after-`..` case below;
    // they're replaced with `..rel..`-form items.
    if (role && !afterDotDot) {
      const prefixLower = prefix.toLowerCase();
      let rank = 0;
      for (const { value: entity, here, from, pool } of this.candidates(role)) {
        if (entity === prefix) continue;
        if (
          prefixLower !== '' &&
          !entity.toLowerCase().startsWith(prefixLower)
        ) {
          continue;
        }
        const item = new vscode.CompletionItem(
          entity,
          vscode.CompletionItemKind.Variable
        );
        item.detail = here ? `${from} — this file` : `${from} — other file`;
        // Query slot first, then same-file before other-file (autocomplete spec).
        item.sortText = `${pool}${here ? '0' : '1'}${String(rank++).padStart(4, '0')}`;
        item.range = entityRange;
        item.filterText = entity;
        // subject   → append ` ..` so the next slot (predicate) is opened
        // predicate → close pred and advance to object slot
        // object    → insert entity + newline so the user can keep going
        item.insertText =
          role === 'subject'
            ? `${entity} ..`
            : role === 'predicate'
              ? `${entity}.. `
              : role === 'object'
                ? `${entity}\n`
                : entity;
        // After picking a subject or predicate, immediately surface the
        // suggestions for the next slot.
        if (role === 'subject' || role === 'predicate') {
          item.command = {
            title: 'Trigger Suggest',
            command: 'editor.action.triggerSuggest',
          };
        }
        items.push(item);
      }
    }

    // After-`..` predicate suggestions: cursor sits right after a `..`
    // separator and the user hasn't started the predicate yet. Emit
    // `..rel..` items whose range spans the existing `..` so accepting
    // replaces it cleanly (no doubled dots).
    if (afterDotDot !== null && afterDotDot !== false) {
      const replaceRange = new vscode.Range(
        new vscode.Position(position.line, afterDotDot),
        position
      );
      for (const { value: pred } of this.candidates('predicate')) {
        const label = `..${pred}..`;
        const item = new vscode.CompletionItem(
          label,
          vscode.CompletionItemKind.Snippet
        );
        item.detail = 'Predicate';
        item.filterText = label;
        item.insertText = `..${pred}.. `;
        item.range = replaceRange;
        item.command = {
          title: 'Trigger Suggest',
          command: 'editor.action.triggerSuggest',
        };
        items.push(item);
      }
    }

    // On a fresh line in continuation context (a current subject is in
    // scope), surface predicates pre-wrapped as `..rel..` so accepting one
    // produces a complete continuation in a single step. Triggered when
    // the cursor sits on a line whose text up to the cursor is empty or
    // whitespace.
    if (
      /^\s*$/.test(beforeCursor) &&
      isContinuationContext(document, position.line)
    ) {
      for (const { value: pred } of this.candidates('predicate')) {
        const label = `..${pred}..`;
        const item = new vscode.CompletionItem(
          label,
          vscode.CompletionItemKind.Snippet
        );
        item.detail = 'Continuation predicate';
        item.filterText = label;
        item.insertText = `..${pred}.. `;
        item.range = entityRange;
        item.command = {
          title: 'Trigger Suggest',
          command: 'editor.action.triggerSuggest',
        };
        items.push(item);
      }
    }

    return items;
  }
}

// Hover Provider
class DdotHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const line = document.lineAt(position.line).text;
    const word = document.getWordRangeAtPosition(position);
    
    if (!word) return null;

    const wordText = document.getText(word);

    // Detect ddot.it syntax and provide help
    if (line.includes('..')) {
      const parts = line.split(/\s*\.\.\s*/);
      
      if (parts.length >= 3) {
        return new vscode.Hover(
          new vscode.MarkdownString(
            '**Typed Link**: `subject .. type .. object`\n\n' +
            'Creates a typed link with:\n' +
            '- **Subject**: ' + parts[0].trim() + '\n' +
            '- **Type**: ' + parts[1].trim() + '\n' +
            '- **Object**: ' + parts.slice(2).join(' .. ').trim()
          )
        );
      } else if (parts.length === 2) {
        return new vscode.Hover(
          new vscode.MarkdownString(
            '**Simple Link**: `subject .... object`\n\n' +
            'Creates an untyped link between two entities.'
          )
        );
      }
    }

    if (line.includes(',,')) {
      return new vscode.Hover(
        new vscode.MarkdownString(
          '**Metadata**: `triple ,, key :: value`\n\n' +
          'Adds metadata or annotations to a triple.'
        )
      );
    }

    return null;
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('ddot.it extension is now active!');

  const selector = { language: DDOT_LANGUAGE };

  // Register Formatter
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      selector,
      new DdotFormatter()
    )
  );

  // Register Code Folding
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(
      selector,
      new DdotFoldingRangeProvider()
    )
  );

  // Register Document Symbols
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      selector,
      new DdotDocumentSymbolProvider()
    )
  );

  // Register Completions
  const completionProvider = new DdotCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      completionProvider,
      // Separators, plus the characters that begin a command in each of its
      // four spellings: `!!…` and `…ddot.it/…`.
      '.',
      ',',
      ';',
      '!',
      '/'
    )
  );

  // The cross-file candidate index is cached; drop it when the set of .ddot
  // files or their contents could have changed.
  const ddotWatcher = vscode.workspace.createFileSystemWatcher('**/*.ddot');
  ddotWatcher.onDidCreate(() => completionProvider.invalidateOtherFiles());
  ddotWatcher.onDidChange(() => completionProvider.invalidateOtherFiles());
  ddotWatcher.onDidDelete(() => completionProvider.invalidateOtherFiles());
  context.subscriptions.push(ddotWatcher);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === DDOT_LANGUAGE) completionProvider.invalidateOtherFiles();
    })
  );

  // Register Hover
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      selector,
      new DdotHoverProvider()
    )
  );

  // Auto-trigger suggestions when the user lands on a fresh line in
  // continuation context (e.g. just hit ENTER after a complete triple).
  // Two-step handshake: a newline edit sets a pending flag; the next
  // selection-change event (after VSCode has moved the cursor to the new
  // line) fires the suggest trigger. setTimeout-based deferral was
  // unreliable — the cursor sometimes hadn't moved yet when the timer ran.
  let pendingNewlineCheck = false;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== DDOT_LANGUAGE) return;
      if (!event.contentChanges.some((c) => c.text.includes('\n'))) return;
      pendingNewlineCheck = true;
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!pendingNewlineCheck) return;
      pendingNewlineCheck = false;

      const editor = event.textEditor;
      if (editor.document.languageId !== DDOT_LANGUAGE) return;

      const position = editor.selection.active;
      const lineUpToCursor = editor.document
        .lineAt(position.line)
        .text.substring(0, position.character);
      if (!/^\s*$/.test(lineUpToCursor)) return;
      if (!isContinuationContext(editor.document, position.line)) return;

      vscode.commands.executeCommand('editor.action.triggerSuggest');
    })
  );

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('ddot.validate', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== DDOT_LANGUAGE) {
        vscode.window.showWarningMessage('No ddot.it file is currently active');
        return;
      }

      const diagnostics = validateDocument(editor.document);
      if (diagnostics.length === 0) {
        vscode.window.showInformationMessage('✓ Document is valid');
      } else {
        vscode.window.showWarningMessage(
          `Found ${diagnostics.length} issue(s) in the document`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ddot.format', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== DDOT_LANGUAGE) {
        vscode.window.showWarningMessage('No ddot.it file is currently active');
        return;
      }

      vscode.commands.executeCommand('editor.action.formatDocument');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ddot.exportJson', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== DDOT_LANGUAGE) {
        vscode.window.showWarningMessage('No ddot.it file is currently active');
        return;
      }

      // Emit one event per line (JSONL), matching
      // https://ddot.it/developer-guide.html#events
      // Spec field order: from, type, to, meta, kind, source, location.
      const jsonl = toJsonl(parseDocument(editor.document));

      vscode.workspace
        .openTextDocument({ language: 'jsonl', content: jsonl })
        .then((doc) => {
          vscode.window.showTextDocument(doc);
        });
    })
  );
}

function validateDocument(document: vscode.TextDocument): any[] {
  const issues: any[] = [];
  const lines = document.getText().split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === '') continue;

    const doubleDots = (line.match(/\.\./g) || []).length;
    
    // Check for incomplete triples (has .. but not at least 2)
    if (doubleDots === 1 && !line.includes('....')) {
      issues.push({
        line: i,
        message: 'Incomplete triple: expected at least 2 ".." separators'
      });
    }
  }

  return issues;
}

// Events come from the shared fold over the tokenizer (src/events.ts), which is
// byte-identical to the Java DdotEventExporter and verified against the
// cross-implementation corpus by `npm run check-corpus`. The line splitter that
// used to live here silently dropped `!!block` bodies, free meta text,
// `;;`-separated meta pairs and the untyped `,, .... value` shortcut.
function parseDocument(document: vscode.TextDocument): DdotEvent[] {
  return parseEvents(
    document.getText(),
    document.languageId,
    vscode.workspace.asRelativePath(document.uri, false)
  );
}

export function deactivate() {}

