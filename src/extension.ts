import * as vscode from 'vscode';

const DDOT_LANGUAGE = 'ddot.it';

// Formatter Provider
//
// Canonical line shapes:
//   Typed link:        `subject ..predicate.. object`
//   Continuation:      `..predicate.. object`
//   Simple link:       `subject .... object`
//   Continuation:      `.... object`
// Metadata `,,` splits a line into independently-formatted parts joined by ` ,, `.
function formatDdotPart(text: string): string {
  const segments: string[] = [];
  const seps: string[] = [];
  let lastIdx = 0;
  const sepRegex = /\.{4}|\.{2}/g;
  let m: RegExpExecArray | null;
  while ((m = sepRegex.exec(text)) !== null) {
    segments.push(text.substring(lastIdx, m.index).trim());
    seps.push(m[0]);
    lastIdx = m.index + m[0].length;
  }
  segments.push(text.substring(lastIdx).trim());

  if (seps.length === 0) return segments[0];

  // subject .. predicate .. object
  if (seps.length === 2 && seps[0] === '..' && seps[1] === '..') {
    const [s, p, o] = segments;
    const head = s === '' ? `..${p}..` : `${s} ..${p}..`;
    return o === '' ? head : `${head} ${o}`;
  }

  // subject .... object
  if (seps.length === 1 && seps[0] === '....') {
    const [s, o] = segments;
    const head = s === '' ? `....` : `${s} ....`;
    return o === '' ? head : `${head} ${o}`;
  }

  // Fallback: rebuild verbatim with trimmed segments — leave malformed lines
  // alone rather than guess.
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    out += segments[i];
    if (i < seps.length) out += seps[i];
  }
  return out;
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
type Role = 'subject' | 'predicate' | 'object';
const ROLES: Role[] = ['subject', 'predicate', 'object'];

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
  private entitiesByRole: Record<Role, Set<string>> = {
    subject: new Set(),
    predicate: new Set(),
    object: new Set(),
  };

  // Walk a line, calling `visit` on each (segment text, role) pair.
  // `..` advances one slot; `....` skips predicate (advances two).
  private walkSegments(
    line: string,
    visit: (text: string, role: Role, start: number, end: number) => void
  ) {
    const beforeMeta = line.split(',,')[0];
    let slot = 0;
    let lastIdx = 0;
    const sepRegex = /\.{4}|\.{2}/g;
    let m: RegExpExecArray | null;
    while ((m = sepRegex.exec(beforeMeta)) !== null) {
      visit(beforeMeta.substring(lastIdx, m.index), ROLES[Math.min(slot, 2)], lastIdx, m.index);
      slot += m[0].length === 4 ? 2 : 1;
      lastIdx = m.index + m[0].length;
    }
    visit(beforeMeta.substring(lastIdx), ROLES[Math.min(slot, 2)], lastIdx, beforeMeta.length);
  }

  updateEntities(document: vscode.TextDocument) {
    for (const role of ROLES) this.entitiesByRole[role].clear();

    for (const line of document.getText().split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      // Only index when the line has fully-formed link syntax following the
      // subject: either two `..` separators (..rel..) or one `....`.
      // Partial lines like `subject ..` or `subject ..rel` are skipped.
      const seps: string[] = trimmed.match(/\.{4}|\.{2}/g) ?? [];
      const dotDotCount = seps.filter((s) => s === '..').length;
      const hasSimple = seps.includes('....');
      if (dotDotCount < 2 && !hasSimple) continue;

      this.walkSegments(trimmed, (text, role) => {
        const entity = text.trim();
        if (!entity || entity.includes('::')) return;
        this.entitiesByRole[role].add(entity);
      });
    }
  }

  // Determine which role the cursor is currently authoring on its line.
  // Returns null when past a ,, (metadata, not an entity slot).
  private getCursorRole(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Role | null {
    const beforeCursor = document
      .lineAt(position.line)
      .text.substring(0, position.character);

    if (beforeCursor.includes(',,')) return null;

    let slot = 0;
    const sepRegex = /\.{4}|\.{2}/g;
    let m: RegExpExecArray | null;
    while ((m = sepRegex.exec(beforeCursor)) !== null) {
      slot += m[0].length === 4 ? 2 : 1;
    }
    return ROLES[Math.min(slot, 2)];
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
    const sepRegex = /\.{4}|\.{2}|,,|::/g;
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

    // Bail out when the user has typed a stray 3-dot run (only `..` and
    // `....` are valid). A 3-dot tail not preceded by another dot means
    // they typed a third dot after `..` — hide the menu.
    if (/(^|[^.])\.{3}$/.test(beforeCursor)) return [];

    const items: vscode.CompletionItem[] = [];
    const entityRange = this.getEntityRange(document, position);
    const prefix = document.getText(entityRange);
    const role = this.getCursorRole(document, position);

    // Separator snippets — gated by what's syntactically valid at this slot.
    // role=subject  → `..` (advance to pred), `....` (skip pred to obj)
    // role=predicate → `..` (close predicate)
    // role=object   → `,,` (start metadata)
    // role=null (past ,,, in metadata) → `..` (key/value sep), `,,` (close)
    const allSnippets: Record<string, string> = {
      '..': 'Typed link separator',
      '....': 'Simple link separator',
      ',,': 'Metadata separator',
    };
    const validSnippets: Record<Role | 'meta', string[]> = {
      subject: ['..', '....'],
      predicate: ['..'],
      object: [',,'],
      meta: ['..', ',,'],
    };
    // Only emit separator snippets when the user is mid-typing a separator
    // — i.e. the current segment ends in a run of `.` or `,` chars that
    // hasn't yet been recognized as a complete separator (`..`, `....`,
    // `,,` are absorbed by the slot walker, so they don't appear at the
    // tail of `prefix`). The snippet then *replaces* that trailing run
    // rather than inserting after it.
    const trailingSepMatch = prefix.match(/[.,]+$/);
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
      for (const entity of this.entitiesByRole[role]) {
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
        item.detail = `${role[0].toUpperCase() + role.slice(1)} from this document`;
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
      for (const pred of this.entitiesByRole.predicate) {
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
      for (const pred of this.entitiesByRole.predicate) {
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
      '.',
      ','
    )
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
      const events = parseDocument(editor.document);
      const jsonl = events
        .map((e) => {
          const ordered: Record<string, unknown> = { from: e.from };
          if (e.type !== undefined) ordered.type = e.type;
          ordered.to = e.to;
          if (e.meta !== undefined) ordered.meta = e.meta;
          ordered.kind = e.kind;
          ordered.source = e.source;
          ordered.location = e.location;
          return JSON.stringify(ordered);
        })
        .join('\n');

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

// Triple Event — matches the schema documented at
// https://ddot.it/developer-guide.html#events
type DdotMeta = { type: string; to: string };
type DdotEvent = {
  from: string;
  type?: string;
  to: string;
  meta?: DdotMeta[];
  kind: string;
  source: string;
  location: number;
};

// Split a line body into segments between `..`/`....` separators, plus any
// trailing metadata text after `,,`.
function splitLine(text: string): {
  segments: string[];
  seps: string[];
  meta: string;
} {
  const idx = text.indexOf(',,');
  const body = idx >= 0 ? text.substring(0, idx) : text;
  const meta = idx >= 0 ? text.substring(idx + 2).trim() : '';

  const segments: string[] = [];
  const seps: string[] = [];
  let lastIdx = 0;
  const sepRegex = /\.{4}|\.{2}/g;
  let m: RegExpExecArray | null;
  while ((m = sepRegex.exec(body)) !== null) {
    segments.push(body.substring(lastIdx, m.index).trim());
    seps.push(m[0]);
    lastIdx = m.index + m[0].length;
  }
  segments.push(body.substring(lastIdx).trim());
  return { segments, seps, meta };
}

// Extract a {from, type?, to} triple from parsed segments. An empty leading
// segment is a continuation — the inherited subject is used as `from`.
function extractTriple(
  segments: string[],
  seps: string[],
  inheritedSubject: string | null
): { from: string; type?: string; to: string } | null {
  // Typed link: `from ..type.. to`  (continuation: `..type.. to`).
  // Empty type ⇒ `.. ..` form, a typographic variant of `....` (untyped).
  if (
    segments.length === 3 &&
    seps.length === 2 &&
    seps[0] === '..' &&
    seps[1] === '..'
  ) {
    const [s, p, o] = segments;
    if (!o) return null;
    const from = s !== '' ? s : inheritedSubject;
    if (!from) return null;
    if (!p) return { from, to: o };
    return { from, type: p, to: o };
  }
  // Simple link: `from .... to`  (continuation: `.... to`)
  if (segments.length === 2 && seps.length === 1 && seps[0] === '....') {
    const [s, o] = segments;
    if (!o) return null;
    const from = s !== '' ? s : inheritedSubject;
    if (!from) return null;
    return { from, to: o };
  }
  return null;
}

function parseDocument(document: vscode.TextDocument): DdotEvent[] {
  const events: DdotEvent[] = [];
  const lines = document.getText().split('\n');
  const source = vscode.workspace.asRelativePath(document.uri, false);
  const kind = document.languageId;

  let currentSubject: string | null = null;
  let openMetaEvent: DdotEvent | null = null;
  let off = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;

    // Both forms are equivalent: `!!` is shorthand for `ddot.it/`.
    if (trimmed === 'ddot.it/off' || trimmed === '!!off') {
      off = true;
      // An open multi-line meta block can't survive an off span; close it.
      openMetaEvent = null;
      continue;
    }
    if (trimmed === 'ddot.it/on' || trimmed === '!!on') {
      off = false;
      continue;
    }
    if (off) continue;

    // Inside an open multi-line metadata block: each non-`,,` line is a
    // ..key.. value pair appended to the previous event's meta array.
    if (openMetaEvent) {
      if (trimmed === ',,') {
        openMetaEvent = null;
        continue;
      }
      const { segments, seps } = splitLine(trimmed);
      const t = extractTriple(segments, seps, currentSubject);
      if (t && t.type) {
        (openMetaEvent.meta ??= []).push({ type: t.type, to: t.to });
      }
      continue;
    }

    const { segments, seps, meta } = splitLine(trimmed);
    const t = extractTriple(segments, seps, currentSubject);
    if (!t) continue;

    const event: DdotEvent = {
      from: t.from,
      to: t.to,
      kind,
      source,
      location: i + 1,
    };
    if (t.type) event.type = t.type;
    currentSubject = t.from;

    // Inline metadata: `,, ..key.. value`
    if (meta) {
      const mp = splitLine(meta);
      const mt = extractTriple(mp.segments, mp.seps, currentSubject);
      if (mt && mt.type) {
        event.meta = [{ type: mt.type, to: mt.to }];
      }
    } else if (trimmed.endsWith(',,')) {
      // Bare `,,` at line end opens a multi-line metadata block.
      openMetaEvent = event;
    }

    events.push(event);
  }

  return events;
}

export function deactivate() {}

