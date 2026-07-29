// Pure positional tokenizer producing the canonical highlighter token stream
// defined by the cross-implementation corpus at ../ddot.it/test-data/ — a flat
// list of {line, start, end, token, text} (0-based, end-exclusive; whitespace is
// not tokenized).
//
// The TextMate grammar in ddot.it-syntax-tools is CANONICAL for that stream;
// this is a conforming mirror, kept byte-identical to the Java mirror
// (DdotTokenizer in ddot.it-intellij). `npm run check-corpus` asserts both the
// token stream and the event stream against the corpus.
//
// It exists here because the event exporter needs a real parse: the previous
// hand-rolled line splitter silently dropped `!!block` bodies, free meta text,
// `;;`-separated meta pairs and the untyped `,, .... value` shortcut. Deriving
// events from these tokens makes that class of divergence impossible.

export type Token = {
  line: number;
  start: number;
  end: number;
  token: string;
  text: string;
};

// --- lexical tokens (Parse Spec, "Token Sequences") ------------------------
// Runs of EXACTLY n, neither preceded nor followed by the same character. The
// lookarounds carry the rule: `\.{2}` alone matches the first two dots of `...`,
// which the tokenization rule forbids.
const DT2_SRC = '(?<!\\.)\\.{2}(?!\\.)';
const QUAD_SRC = '(?<!\\.)(?:\\.{4}|\\.{2}[ \\t]+\\.{2})(?!\\.)';
const CM2_SRC = '(?<!,),,(?!,)';
const SC2_SRC = '(?<!;);;(?!;)';

// A command needs the slash and a non-empty name; bare `ddot.it` is not one.
// `?` and `#` do not terminate a command; they introduce its query/fragment.
const CMD_SRC = '(?:(?:https?://)?ddot\\.it/|!!)[^\\s?#]+(?:\\?[^\\s#]*)?(?:#\\S*)?';
const BLOCK_SRC = '(?:(?:https?://)?ddot\\.it/|!!)block';

const CMD_ONLY = new RegExp(`^${CMD_SRC}$`);
// `!!off` / `!!on` are recognised ANYWHERE on a line, not only alone on one:
// the common way to write them is inside a host-language comment
// (`<!-- ddot.it/off -->`, `# !!off`). The directive line yields only the command
// token; the region starts on the NEXT line. `(?![^\s?#])` pins the command NAME,
// so `!!office` is not `!!off`.
const OFF_LINE = /((?:(?:https?:\/\/)?ddot\.it\/|!!)off)(?![^\s?#])/;
const ON_LINE = /((?:(?:https?:\/\/)?ddot\.it\/|!!)on)(?![^\s?#])/;
// A line-initial `,,` followed by a meta pair: a metadata continuation.
// Parse Spec "block-continuation" — after a block that filled the OBJECT, a
// leading CM2 continues the logical line as metadata. Without it the line reads
// as a fresh triple whose subject is `,,`. Keyed on shape, because a per-line
// pass cannot see the preceding block.
const META_CONTINUATION =
  /^[ \t]*(?:((?<!,),,(?!,))|((?<!;);;(?!;)))(?=[ \t]+(?<!\.)\.{2}(?!\.))/;

/** A block opener must END its physical line (block-as-field). */
const BLOCK_OPENER = new RegExp(`(${BLOCK_SRC})(?:(\\?end=)(\\S+))?[ \\t]*$`);

/** QUAD before DT2 so `.. ..` is ONE operator, not two. */
const SIGNIFICANT_SRC = `${QUAD_SRC}|${DT2_SRC}|${CM2_SRC}|${SC2_SRC}`;

/**
 * The line-shape gate: a line is ddot.it only when it carries a complete
 * operator skeleton — two DT2, or one DT4 / `.. ..`. A lone `..` in prose does
 * not qualify, which is what keeps 23-not-a-triple entirely plain.
 */
const GATE = /(?:(?<!\.)\.{4}(?!\.)|(?<!\.)\.{2}(?!\.).*(?<!\.)\.{2}(?!\.))/;

const isCommand = (s: string): boolean => CMD_ONLY.test(s);

/** Slot phases within one logical line. */
const enum Phase {
  Subject,
  Relation,
  Object,
  MetaStart,
  MetaRel,
  MetaObj,
}

type BlockState = { opensBlock: boolean; opensMetaBlock: boolean; blockEnd?: string };

/** Tokenize ddot source into the canonical highlighter token stream. */
export function tokenize(raw: string): Token[] {
  const out: Token[] = [];
  const lines = raw.split('\n');

  let off = false; // inside !!off … !!on
  let verbatim = false; // inside a !!block body
  let blockEnd: string | undefined; // custom ?end= marker, undefined = blank-line form
  let inMetaBlock = false; // inside a ,, … ,, block

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // --- excluded span -----------------------------------------------------
    if (off) {
      const on = ON_LINE.exec(line);
      if (on) {
        emitGroup(out, i, on, 1, 'command');
        off = false;
      } else if (trimmed !== '') {
        emitTrimmed(out, i, line, 'excluded');
      }
      continue;
    }
    // --- verbatim (!!block body) -------------------------------------------
    if (verbatim) {
      if (blockEnd !== undefined) {
        if (trimmed === blockEnd) {
          emitTrimmed(out, i, line, 'block-end');
          verbatim = false;
          blockEnd = undefined;
        } else if (trimmed !== '') {
          emitTrimmed(out, i, line, 'verbatim');
        }
      } else if (trimmed === '') {
        verbatim = false; // blank line ends the unmarked form
      } else {
        emitTrimmed(out, i, line, 'verbatim');
      }
      continue;
    }
    const offM = OFF_LINE.exec(line);
    if (offM) {
      emitGroup(out, i, offM, 1, 'command');
      off = true;
      inMetaBlock = false;
      continue;
    }

    // --- inside a ,, block --------------------------------------------------
    if (inMetaBlock) {
      if (trimmed === ',,') {
        emitTrimmed(out, i, line, 'meta-delim');
        inMetaBlock = false;
      } else if (trimmed !== '') {
        if (startsWithOperator(line)) {
          // `..mr.. mo` — MetaObjectInBlock runs to end of line, so `;;` is content.
          emitLine(out, i, line, Phase.MetaStart, true);
        } else {
          emitTrimmed(out, i, line, 'meta-text');
        }
      }
      continue;
    }
    if (trimmed === '') continue;

    // --- a standalone `,,` opens a block for the previous triple -------------
    if (trimmed === ',,') {
      emitTrimmed(out, i, line, 'meta-delim');
      inMetaBlock = true;
      continue;
    }

    // --- `,, ..mr.. mo` continues the previous logical line -------------------
    const mc = META_CONTINUATION.exec(line);
    if (mc) {
      const end = mc.index + mc[0].length;
      const g = mc[1] !== undefined ? 1 : 2;
      emitGroup(out, i, mc, g, g === 1 ? 'meta-delim' : 'meta-separator');
      // Blank out the consumed ',,' so column offsets stay true to the source.
      emitLine(out, i, line.slice(0, end).replace(/[^ \t]/g, ' ') + line.slice(end),
        Phase.MetaStart, false);
      continue;
    }

    // --- `!!block` alone on a line = a SUBJECT opener ------------------------
    const bo = BLOCK_OPENER.exec(line);
    if (bo && line.substring(0, bo.index).trim() === '') {
      emitBlockOpener(out, i, bo);
      verbatim = true;
      blockEnd = bo[3];
      continue;
    }

    // --- the gate ------------------------------------------------------------
    if (!GATE.test(line)) continue; // NotATriple: no tokens

    const st = emitLine(out, i, line, Phase.Subject, false);
    if (st.opensBlock) {
      verbatim = true;
      blockEnd = st.blockEnd;
    } else if (st.opensMetaBlock) {
      inMetaBlock = true;
    }
  }
  return out;
}

function startsWithOperator(line: string): boolean {
  const re = new RegExp(SIGNIFICANT_SRC, 'g');
  const m = re.exec(line);
  return m !== null && line.substring(0, m.index).trim() === '';
}

/**
 * Emit one line as a sequence of slots and operators, starting in `phase`.
 * Mirrors the parse automaton: the object may contain `..`, `;;` separates
 * inline meta pairs only, and a `!!block` that ends the line opens a verbatim
 * region.
 */
function emitLine(
  out: Token[],
  lineNo: number,
  line: string,
  phase: Phase,
  inBlock: boolean
): BlockState {
  const st: BlockState = { opensBlock: false, opensMetaBlock: false };
  const re = new RegExp(SIGNIFICANT_SRC, 'g');
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(line)) !== null) {
    let sep = m[0];
    let isQuad = sep.length === 4 || sep.includes(' ') || sep.includes('\t');
    const isComma = sep === ',,';
    const isSemi = sep === ';;';
    const sepStart = m.index;
    let sepEnd = m.index + sep.length;

    // Once in an object-ish phase, `..` is content, not a separator.
    if (!isComma && !isSemi && (phase === Phase.Object || phase === Phase.MetaObj)) continue;
    // `;;` separates inline meta pairs ONLY. Inside a `,,` block,
    // MetaObjectInBlock := TextExcept{NL}, so it is ordinary content
    // (28-semicolon-in-meta-block).
    if (isSemi && (inBlock || phase !== Phase.MetaObj)) continue;
    if (isComma && phase !== Phase.Object) continue;

    // The relation-closing operator is always a plain `..`, never the untyped
    // `.. ..` form. Without this, an object that begins with `..` (a relative
    // path) merges with the closing marker and the pair is read as one QuadDot —
    // `a ..links to.. ../../b.adoc` would lose the object's first two dots
    // (20-object-dotdot).
    if (isQuad && sep.length !== 4 && (phase === Phase.Relation || phase === Phase.MetaRel)) {
      isQuad = false;
      sep = line.substring(sepStart, sepStart + 2);
      sepEnd = sepStart + 2;
      re.lastIndex = sepEnd;
    }

    // A `!!block` ending the line makes the pending slot a block opener.
    const bo = matchFrom(BLOCK_OPENER, line, last);
    if (bo && line.substring(last, bo.index).trim() === '' && bo.index < sepStart) {
      emitBlockOpener(out, lineNo, bo);
      st.opensBlock = true;
      st.blockEnd = bo[3];
      return st;
    }

    emitSlot(out, lineNo, line, last, sepStart, phase);
    out.push({
      line: lineNo,
      start: sepStart,
      end: sepEnd,
      token: isComma
        ? 'meta-delim'
        : isSemi
          ? 'meta-separator'
          : phase === Phase.MetaStart ||
              phase === Phase.MetaRel ||
              phase === Phase.MetaObj ||
              inBlock
            ? 'meta-doubledot'
            : 'doubledot',
      text: sep,
    });
    last = sepEnd;

    switch (phase) {
      case Phase.Subject:
        phase = isQuad ? Phase.Object : Phase.Relation;
        break;
      case Phase.Relation:
        phase = Phase.Object;
        break;
      case Phase.Object:
        phase = isComma ? Phase.MetaStart : Phase.Object;
        break;
      // The untyped meta form `,, .... obj` skips the meta relation.
      case Phase.MetaStart:
        phase = isQuad ? Phase.MetaObj : Phase.MetaRel;
        break;
      case Phase.MetaRel:
        phase = Phase.MetaObj;
        break;
      case Phase.MetaObj:
        phase = isSemi ? Phase.MetaStart : Phase.MetaObj;
        break;
    }
  }

  // Trailing slot, or a block opener with no separator after it.
  const bo = matchFrom(BLOCK_OPENER, line, last);
  if (bo && line.substring(last, bo.index).trim() === '') {
    emitBlockOpener(out, lineNo, bo);
    st.opensBlock = true;
    st.blockEnd = bo[3];
    return st;
  }
  if (line.substring(last).trim() === '' && phase === Phase.MetaStart) {
    st.opensMetaBlock = true; // trailing `,,` opened a block
  } else {
    emitSlot(out, lineNo, line, last, line.length, phase);
  }
  return st;
}

/** Java's `Matcher.find(from)`: match the pattern at or after `from`. */
function matchFrom(
  re: RegExp,
  line: string,
  from: number
): (RegExpExecArray & { index: number }) | null {
  const m = re.exec(line.substring(from));
  if (!m) return null;
  m.index += from;
  return m as RegExpExecArray & { index: number };
}

function emitBlockOpener(out: Token[], lineNo: number, bo: RegExpExecArray): void {
  const base = bo.index;
  out.push({ line: lineNo, start: base, end: base + bo[1].length, token: 'command', text: bo[1] });
  if (bo[2] !== undefined) {
    const paramStart = base + bo[1].length;
    out.push({
      line: lineNo,
      start: paramStart,
      end: paramStart + bo[2].length,
      token: 'command-param',
      text: bo[2],
    });
    const endStart = paramStart + bo[2].length;
    out.push({
      line: lineNo,
      start: endStart,
      end: endStart + bo[3].length,
      token: 'block-end',
      text: bo[3],
    });
  }
}

function emitSlot(
  out: Token[],
  lineNo: number,
  line: string,
  lo: number,
  hi: number,
  phase: Phase
): void {
  const r = trimRange(line, lo, hi);
  if (!r) return;
  const text = line.substring(r[0], r[1]);
  let token: string;
  if (isCommand(text)) {
    token = 'command'; // a slot whose whole text is a command IS a command
  } else {
    switch (phase) {
      case Phase.Subject:
        token = 'subject';
        break;
      case Phase.Relation:
        token = 'relation';
        break;
      case Phase.Object:
        token = 'object';
        break;
      case Phase.MetaRel:
        token = 'meta-relation';
        break;
      case Phase.MetaObj:
        token = 'meta-object';
        break;
      default:
        token = 'meta-text'; // text after `,,` with no `..`
        break;
    }
  }
  out.push({ line: lineNo, start: r[0], end: r[1], token, text });
}

function emitGroup(
  out: Token[],
  lineNo: number,
  m: RegExpExecArray,
  group: number,
  token: string
): void {
  const start = m.index + m[0].indexOf(m[group]);
  out.push({ line: lineNo, start, end: start + m[group].length, token, text: m[group] });
}

function emitTrimmed(out: Token[], lineNo: number, line: string, token: string): void {
  const r = trimRange(line, 0, line.length);
  if (!r) return;
  out.push({ line: lineNo, start: r[0], end: r[1], token, text: line.substring(r[0], r[1]) });
}

/** Range of the non-whitespace span within [lo, hi), or null if blank. */
function trimRange(line: string, lo: number, hi: number): [number, number] | null {
  let s = lo;
  let e = hi;
  while (s < e && /\s/.test(line[s])) s++;
  while (e > s && /\s/.test(line[e - 1])) e--;
  return s < e ? [s, e] : null;
}

/**
 * Serialize tokens exactly as `JSON.stringify(arr, null, 2)` plus a trailing
 * newline — byte-identical to the expected.tokens.json corpus files.
 */
export function toJson(tokens: Token[]): string {
  return JSON.stringify(tokens, null, 2) + '\n';
}
