/** Minimal markdown-it shapes keep this display rule independent of React Native. */
interface InlineSpacingState {
  readonly src: string;
  pos: number;
  readonly posMax: number;
}

interface InlineSpacingParser {
  inline: {
    ruler: {
      before(beforeName: string, ruleName: string, rule: (state: InlineSpacingState, silent: boolean) => boolean): unknown;
    };
  };
}

// Only zero-valued cm/pt spacing is supported. Other TeX, nonzero dimensions,
// escaped examples, and malformed commands remain available to the renderer.
// A sticky expression starts at the parser cursor without copying its suffix.
const zeroWidthHspace = /\\hspace\*?[ \t]*\{[ \t]*[+-]?(?:0+(?:\.0*)?|\.0+)[ \t]*(?:cm|pt)[ \t]*\}/y;

type UrlRange = { start: number; end: number };
const urlRanges = new WeakMap<InlineSpacingState, UrlRange[]>();
const urlTerminator = /[\s<>"'`]/;

/** Bare URLs are plain text when linkify is disabled, so protect them explicitly. */
function insideBareUrl(state: InlineSpacingState): boolean {
  let ranges = urlRanges.get(state);
  if (!ranges) {
    ranges = [];
    const schemes = /https?:\/\//gi;
    let match: RegExpExecArray | null;
    while ((match = schemes.exec(state.src))) {
      let end = schemes.lastIndex; let parentheses = 0; let brackets = 0;
      for (; end < state.src.length; end++) {
        const character = state.src[end];
        if (urlTerminator.test(character)) break;
        if (character === '(') parentheses++;
        else if (character === ')') { if (!parentheses) break; parentheses--; }
        else if (character === '[') brackets++;
        else if (character === ']') { if (!brackets) break; brackets--; }
      }
      ranges.push({ start: match.index, end });
      schemes.lastIndex = end;
    }
    urlRanges.set(state, ranges);
  }
  // Link-label validation can temporarily move the cursor backwards. Binary
  // lookup handles that without repeatedly scanning a long URL or source text.
  let low = 0; let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (state.pos < range.start) high = middle;
    else if (state.pos >= range.end) low = middle + 1;
    else return true;
  }
  return false;
}

function consumeZeroWidthHspace(state: InlineSpacingState): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x5c) return false;
  zeroWidthHspace.lastIndex = state.pos;
  const match = zeroWidthHspace.exec(state.src);
  if (!match || zeroWidthHspace.lastIndex > state.posMax) return false;
  if (insideBareUrl(state)) return false;
  // Advancing the inline cursor renders a zero-width command as zero width.
  // Never rewrite state.src, source messages, links, or stored/imported data.
  state.pos = zeroWidthHspace.lastIndex;
  return true;
}

/**
 * Install before Markdown's escape rule. Backtick/fence and link parsers consume
 * their contents separately, so code and destinations are never rewritten.
 * An explicitly escaped backslash is consumed by the existing escape rule and
 * is not processed a second time as a spacing instruction.
 */
export function zeroWidthHspacePlugin(markdown: InlineSpacingParser): void {
  markdown.inline.ruler.before('escape', 'shiyu_zero_width_hspace', consumeZeroWidthHspace);
}
