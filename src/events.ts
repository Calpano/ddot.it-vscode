// Emits the ddot.it event stream (https://ddot.it/developer-guide.html#events)
// as JSONL. Byte-identical to the Java DdotEventExporter in ddot.it-intellij;
// both are asserted against expected.events.jsonl in the shared corpus.
//
// This is a FOLD OVER THE TOKENIZER, not a parser. It used to be an independent
// line-oriented splitter, which is precisely why it silently dropped four spec'd
// constructs: `!!block` bodies (the literal "!!block" was exported as the field
// value), free meta text, `;;`-separated inline meta pairs, and the untyped
// `,, .... value` shortcut. The tokenizer already implements all of them, so
// consuming its output makes those divergences impossible rather than merely
// fixed.
//
// Reconstruction is positional: the tokenizer's slot phases are recovered by
// replaying its separator transitions over each line's tokens. That matters for
// slots whose entire text is a command (`!!this`, `!!block`), which the
// tokenizer reports as `command` — the token name alone no longer says which
// slot it filled, but its position does.

import { Token, tokenize } from './tokenizer';

export type DdotMeta = { type?: string; to: string };
export type DdotEvent = {
  from: string;
  type?: string;
  to: string;
  meta?: DdotMeta[];
  kind: string;
  source: string;
  location: number;
};

/** The built-in relation carried by free meta text (Parse Spec, Information Model). */
const TEXT_RELATION = 'text';

const OFF_ON = /^(?:(?:https?:\/\/)?ddot\.it\/|!!)(?:off|on)$/;
const BLOCK_OPENER = /^(?:(?:https?:\/\/)?ddot\.it\/|!!)block(?:\?end=\S+)?$/;

const enum Phase {
  Subject,
  Relation,
  Object,
  MetaStart,
  MetaRel,
  MetaObj,
}

export function parseEvents(text: string, kind: string, source: string): DdotEvent[] {
  const lines = text.split('\n');
  const byLine = groupByLine(tokenize(text), lines.length);

  const consumed = new Set<number>();
  const blockBodies = collectBlockBodies(lines, byLine, consumed);

  const events: DdotEvent[] = [];
  let currentSubject: string | null = null;
  let openMetaEvent: DdotEvent | null = null;
  let lastEvent: DdotEvent | null = null;
  // A `,,` block holds either triples or text, never both, and a whole
  // MetaTextBlock is ONE node (`MetaTextBlock *-- "1..n" MetaTextBlockLine`) —
  // so its lines join into a single `text` entry, not one per line.
  let metaTextLines: string[] = [];

  const flushMetaText = (event: DdotEvent): void => {
    if (metaTextLines.length === 0) return;
    (event.meta ??= []).push({ type: TEXT_RELATION, to: metaTextLines.join('\n') });
    metaTextLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const toks = byLine[i];
    if (toks.length === 0 || consumed.has(i)) continue;
    // `!!off` … `!!on`: the directives and everything between them are processed
    // by the reader and never emitted (developer guide).
    if (toks[0].token === 'excluded') continue;
    if (toks.length === 1 && toks[0].token === 'command' && OFF_ON.test(toks[0].text)) continue;

    // A `,,` alone on a line opens a metadata block for the preceding triple, or
    // closes the one that is open.
    if (toks.length === 1 && toks[0].token === 'meta-delim') {
      if (openMetaEvent) {
        flushMetaText(openMetaEvent);
        openMetaEvent = null;
      } else {
        openMetaEvent = lastEvent;
      }
      continue;
    }

    const inMetaBlock = openMetaEvent !== null;
    const parsed = readLine(toks, blockBodies, inMetaBlock ? Phase.MetaStart : Phase.Subject);

    if (openMetaEvent) {
      for (const mp of parsed.meta) {
        if (mp.type === TEXT_RELATION) metaTextLines.push(mp.to);
        else (openMetaEvent.meta ??= []).push(mp);
      }
      continue;
    }

    // A metadata CONTINUATION line (`,, ..since.. 2016` after a block object)
    // belongs to the triple already emitted, not to a new one.
    if ((toks[0].token === 'meta-delim' || toks[0].token === 'meta-separator')
        && lastEvent && parsed.object === undefined) {
      for (const mp of parsed.meta) (lastEvent.meta ??= []).push(mp);
      continue;
    }

    // A block filling the SUBJECT slot puts a subject in scope without producing
    // a triple of its own (`!!block` … then `..knows.. Bob`).
    if (parsed.subject !== undefined) currentSubject = parsed.subject;
    if (parsed.object === undefined) continue;
    if (currentSubject === null) continue; // no subject in scope: not a triple

    const event: DdotEvent = { from: currentSubject, to: parsed.object, kind, source, location: i + 1 };
    if (parsed.relation !== undefined) event.type = parsed.relation;
    if (parsed.meta.length > 0) event.meta = [...parsed.meta];
    events.push(event);
    lastEvent = event;
    if (parsed.opensMetaBlock) openMetaEvent = event;
  }

  // An unterminated `,,` block still contributes its text.
  if (openMetaEvent) flushMetaText(openMetaEvent);

  return events;
}

// --- line reconstruction ----------------------------------------------------

type Line = {
  subject?: string;
  relation?: string;
  object?: string;
  meta: DdotMeta[];
  opensMetaBlock: boolean;
};

/**
 * Replay the tokenizer's phase transitions across one line's tokens and read the
 * slot values back out. `startPhase` is Subject for an ordinary line and
 * MetaStart for a line inside a `,,` block, which is where the tokenizer itself
 * starts those lines — without it a block's `..year.. 2010` would be read as a
 * relation and an object rather than as a meta pair, and silently dropped.
 */
function readLine(toks: Token[], blockBodies: Map<number, string>, startPhase: Phase): Line {
  const line: Line = { meta: [], opensMetaBlock: false };
  let phase = startPhase;
  let pendingMetaRelation: string | undefined;
  let sawMetaDelim = false;

  for (const t of toks) {
    switch (t.token) {
      case 'doubledot':
      case 'meta-doubledot':
        phase = advance(phase, isQuad(t.text));
        break;
      case 'meta-delim':
        phase = Phase.MetaStart;
        sawMetaDelim = true;
        break;
      // `;;` ends the current pair and starts the next one.
      case 'meta-separator':
        phase = Phase.MetaStart;
        pendingMetaRelation = undefined;
        break;
      // `?end=` / the END marker of a marked block opener, and block body lines:
      // all belong to the block, never to the slot it fills.
      case 'command-param':
      case 'block-end':
      case 'verbatim':
        break;
      default: {
        const value = valueOf(t, blockBodies);
        if (value === undefined) break;
        switch (phase) {
          case Phase.Subject:
            line.subject = value;
            break;
          case Phase.Relation:
            line.relation = value;
            break;
          case Phase.Object:
            line.object = value;
            break;
          // Text directly after `,,` with no `..` is meta TEXT, which carries
          // the built-in relation `text`.
          case Phase.MetaStart:
            line.meta.push({ type: TEXT_RELATION, to: value });
            break;
          case Phase.MetaRel:
            pendingMetaRelation = value;
            break;
          case Phase.MetaObj:
            line.meta.push(
              pendingMetaRelation === undefined
                ? { to: value }
                : { type: pendingMetaRelation, to: value }
            );
            pendingMetaRelation = undefined;
            break;
        }
        break;
      }
    }
  }

  // A trailing `,,` with nothing after it opens a multi-line meta block.
  line.opensMetaBlock =
    sawMetaDelim &&
    line.meta.length === 0 &&
    pendingMetaRelation === undefined &&
    phase === Phase.MetaStart;
  return line;
}

/**
 * The text a slot token contributes: a block opener contributes its block's
 * body, every other token its own text.
 */
function valueOf(t: Token, blockBodies: Map<number, string>): string | undefined {
  // Only a block opener that ENDS its line opens a block. Elsewhere —
  // `x ..y.. !!block ,, ..k.. v` — `!!block` is ordinary field text, because "a
  // Command is a part of the text of the field holding it, not a replacement for
  // it" (Parse Spec). Falling through to undefined would drop the whole triple.
  if (t.token === 'command' && BLOCK_OPENER.test(t.text)) {
    return blockBodies.get(t.line) ?? t.text;
  }
  return t.text;
}

const isQuad = (sep: string): boolean =>
  sep.length === 4 || sep.includes(' ') || sep.includes('\t');

/** The tokenizer's transition table; a QuadDot skips the relation slot. */
function advance(phase: Phase, quad: boolean): Phase {
  switch (phase) {
    case Phase.Subject:
      return quad ? Phase.Object : Phase.Relation;
    case Phase.Relation:
      return Phase.Object;
    case Phase.Object:
      return Phase.Object;
    case Phase.MetaStart:
      return quad ? Phase.MetaObj : Phase.MetaRel;
    default:
      return Phase.MetaObj;
  }
}

// --- `!!block` bodies -------------------------------------------------------

/**
 * Map each block opener's line to its body text, and mark the body lines
 * consumed so the event pass skips them.
 *
 * The body is taken from the RAW lines, not from the `verbatim` tokens: a block
 * is verbatim, and the tokens are trimmed, which would drop indentation. Blank
 * lines inside a marked (`?end=`) block survive.
 */
function collectBlockBodies(
  lines: string[],
  byLine: Token[][],
  consumed: Set<number>
): Map<number, string> {
  const bodies = new Map<number, string>();
  let openerLine = -1;
  let marked = false;
  let firstBodyLine = -1;
  let lastBodyLine = -1;

  const close = (): void => {
    // A block that opened but has no body lines still IS a block — empty value.
    bodies.set(openerLine, join(lines, firstBodyLine, lastBodyLine) ?? '');
    openerLine = -1;
    marked = false;
    firstBodyLine = -1;
    lastBodyLine = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const toks = byLine[i];

    if (openerLine >= 0) {
      const isBlockEnd = toks.length > 0 && toks[0].token === 'block-end';
      const isBody = toks.length > 0 && toks[0].token === 'verbatim';
      if (isBody) {
        if (firstBodyLine < 0) firstBodyLine = i;
        lastBodyLine = i;
        consumed.add(i);
        continue;
      }
      // A blank line ends the unmarked form, but is ordinary body content in the
      // marked one — which is exactly why `?end=` exists. Only the END marker
      // closes a marked block.
      if (marked && !isBlockEnd) continue;

      const wasEmpty = toks.length === 0;
      close();
      if (isBlockEnd) {
        consumed.add(i);
        continue;
      }
      if (wasEmpty) continue;
      // else: fall through — this line is ordinary content again
    }

    if (opensBlock(toks)) {
      openerLine = i;
      marked = toks.some((t) => t.token === 'block-end');
    }
  }
  if (openerLine >= 0) close();
  return bodies;
}

const isBlockOpener = (t: Token): boolean =>
  t.token === 'command' && BLOCK_OPENER.test(t.text);

/**
 * True when this line ends by opening a block. The opener is not always the LAST
 * token: the marked form `!!block?end=END` is tokenized as command +
 * command-param + block-end, so the opener is followed by its own parameter
 * tokens and nothing else.
 */
function opensBlock(toks: Token[]): boolean {
  for (let i = toks.length - 1; i >= 0; i--) {
    const name = toks[i].token;
    if (name === 'command-param' || name === 'block-end') continue;
    return isBlockOpener(toks[i]);
  }
  return false;
}

/** Raw lines [from, to], or undefined when the block has no body at all. */
function join(lines: string[], from: number, to: number): string | undefined {
  if (from < 0) return undefined;
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(lines[i].replace(/\r$/, ''));
  return out.join('\n');
}

function groupByLine(tokens: Token[], lineCount: number): Token[][] {
  const byLine: Token[][] = Array.from({ length: lineCount }, () => []);
  for (const t of tokens) if (t.line >= 0 && t.line < lineCount) byLine[t.line].push(t);
  return byLine;
}

// --- JSONL ------------------------------------------------------------------

/** Field order matches the spec: from, type?, to, meta?, kind, source, location. */
export function toJsonl(events: DdotEvent[]): string {
  return events
    .map((e) => {
      const ordered: Record<string, unknown> = { from: e.from };
      if (e.type !== undefined) ordered.type = e.type;
      ordered.to = e.to;
      if (e.meta !== undefined && e.meta.length > 0) {
        ordered.meta = e.meta.map((m) =>
          m.type === undefined ? { to: m.to } : { type: m.type, to: m.to }
        );
      }
      ordered.kind = e.kind;
      ordered.source = e.source;
      ordered.location = e.location;
      return JSON.stringify(ordered);
    })
    .join('\n');
}
