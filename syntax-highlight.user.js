// ==UserScript==
// @name         MoSES: Syntax highlighting
// @namespace    https://github.com/casparschucan/MoSES
// @version      0.2.0
// @description  Syntax-highlights every text field on ETHZ Moodle STACK question edit pages: Maxima fields get rainbow-matched brackets, a distinct colour for the variables you define, strings, comments and keywords; Question text and feedback get STACK [[...]] tags, inline CAS {@ ... @}, LaTeX and HTML.
// @author       Caspar Schucan
// @match        https://moodle-app2.let.ethz.ch/question/bank/editquestion/question.php*
// @match        https://moodle-app6.let.ethz.ch/question/bank/editquestion/question.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/casparschucan/MoSES/main/syntax-highlight.user.js
// @downloadURL  https://raw.githubusercontent.com/casparschucan/MoSES/main/syntax-highlight.user.js
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * HOW DO YOU SYNTAX-HIGHLIGHT A <textarea> AT ALL?
 * ---------------------------------------------------------------------------
 * You can't. A <textarea> renders its value as plain text; there is no way to
 * put a coloured <span> inside one. Every editor that appears to do it uses
 * one of three tricks, and only one of them is safe here:
 *
 *   1. Replace the textarea with a contenteditable div (what CodeMirror and
 *      Monaco do). Rejected: the textarea is a real form control that Moodle
 *      serialises on submit, so we'd have to own every .value write ourselves
 *      - which destroys the native undo stack, breaks Moodle's own
 *      form-dirty tracking, and instantly kills auto-brackets.user.js and
 *      auto-close-html-tags.user.js, both of which require
 *      event.target.tagName === 'TEXTAREA' and selectionStart to work.
 *
 *   2. @require a real editor library. Rejected for the same reason, plus it
 *      would pull a third-party script into an authenticated exam-Moodle page.
 *
 *   3. THE MIRROR OVERLAY (what this script does). We leave the textarea
 *      exactly where Moodle put it and lay a second element - the "mirror" -
 *      directly on top of it, showing the same text but marked up with
 *      coloured spans. The mirror has pointer-events: none, so every click,
 *      drag, keystroke, caret move and selection still goes to the real
 *      textarea underneath. Then we make the textarea's own text transparent,
 *      so the only glyphs you actually see are the mirror's coloured ones.
 *
 * Nothing about the textarea's value, undo history, form identity or event
 * behaviour changes. If this script breaks, the worst case is cosmetic.
 *
 * IN FRONT, NOT BEHIND
 * -------------------------------------------------------------------------
 * Most tutorials put the mirror *behind* a transparent textarea. Putting it
 * in front is better for two concrete reasons:
 *
 *   - Selection. The blue selection band is painted by the textarea. With the
 *     mirror behind, that band paints over your syntax colours and you get a
 *     solid slab. With the mirror in front, the band shows through the
 *     mirror's transparent background and the coloured glyphs stay readable.
 *     (One rule is still needed - see MOSES_HL_SELECTION_CSS below - because
 *     Chrome forces an opaque text colour on selected text.)
 *   - Chrome. With the mirror behind you must make the textarea's background
 *     transparent and then re-paint its border, focus ring and invalid-field
 *     styling yourself. In front, the textarea just renders its own chrome.
 *
 * WHY THE MIRROR LIVES IN A SHADOW ROOT
 * -------------------------------------------------------------------------
 * Two independent reasons:
 *
 *   - CSS isolation. Moodle ships Bootstrap. A single page-level rule like
 *     `div { line-height: 1.5 }` or a theme rule on `span` would shift the
 *     mirror by a fraction of a pixel per line - which is invisible at the
 *     top of the field and badly wrong 40 lines down. Page author styles do
 *     not cross a shadow boundary, so this whole class of bug disappears.
 *   - It hides our churn from moodle-stack-helper.user.js. That script
 *     watches document.body with { childList, subtree, attributes } and
 *     re-queries every textarea on the page 150ms after any mutation. We
 *     rewrite the mirror's innerHTML on every keystroke - but mutation
 *     records do not cross a shadow boundary either, so that rebuild is
 *     completely invisible to it and costs it nothing.
 *
 * WHY MONOSPACE IS FORCED ON CODE FIELDS
 * -------------------------------------------------------------------------
 * This is not a taste decision, it's a correctness one. In the textarea a
 * line is one continuous text run, so the browser applies kerning across it
 * (the "AV" pair is tucked closer than "AX"). In the mirror the same line is
 * chopped into spans, and kerning does not apply across a span boundary - so
 * with a proportional font the two drift apart *within a line*, by an amount
 * that depends on where the tokens happen to split. With a monospace font
 * every glyph has the same advance and no kerning applies, so splitting the
 * line into spans is provably harmless.
 *
 * The same argument is why ligatures are switched off on both sides: a font
 * like Fira Code shapes ":=" into one glyph in the textarea, but ":" and "="
 * may land in different spans in the mirror and so stay two glyphs.
 *
 * Question text and feedback are prose, so they keep Moodle's own font
 * rather than being forced to monospace. They get `font-kerning: none`
 * instead, which removes the drift at its source: with kerning off there is
 * nothing left that depends on the neighbouring glyph, so span boundaries
 * stop mattering. The cost is that a few letter pairs sit a hair looser
 * than they otherwise would.
 *
 * THE TWO LANGUAGES
 * -------------------------------------------------------------------------
 * The form holds two quite different things, told apart by the same
 * id/name-contains-"variables" heuristic auto-close-html-tags.user.js uses:
 *
 *   Maxima  - Question variables, each PRT's Feedback variables.
 *   CASText - Question text, General feedback, PRT node feedback. This is
 *             HTML with three other languages embedded in it: STACK's
 *             [[input:ans1]] style tags, inline CAS in {@ ... @} / {# ... #},
 *             and LaTeX in \( ... \) / \[ ... \]. The CASText tokenizer is
 *             therefore a dispatcher rather than a grammar, and it hands
 *             {@ ... @} contents to the Maxima tokenizer, since that is
 *             exactly what they are.
 *
 * WHAT HAPPENS IF IT GOES WRONG
 * -------------------------------------------------------------------------
 * The failure mode to be afraid of is "your text is now invisible", so the
 * textarea's colour is only made transparent *after* a first render has
 * succeeded and an alignment check has passed. Every later render is wrapped
 * in try/catch, and any failure detaches the overlay and restores the field
 * to plain text. There is also a Tampermonkey menu command to turn the whole
 * thing off without reloading the page (which would lose unsaved edits).
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[MoSES Highlight]';

  // Tunable constants live up top so they're easy to find/change later.
  const ENABLED_STORAGE_KEY = 'hl_enabled';  // key used in Tampermonkey's storage
  const CODE_FONT_STACK =
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  const MAX_FIELD_CHARS = 100000;   // don't attach to something pathologically large
  const ALIGN_TOLERANCE_PX = 1;     // sub-pixel rounding is fine; more than this is a bug
  const RAINBOW_DEPTHS = 5;         // bracket colours before the cycle repeats
  const RENDER_BUDGET_MS = 8;       // above this a re-render no longer fits comfortably in a frame
  const SLOW_RENDER_DELAY_MS = 120; // ...so back off to a trailing debounce on such fields

  // The one rule that cannot live inside the shadow root, because it targets
  // the textarea itself (which is in the normal page DOM). Chrome paints
  // selected text in an opaque colour unless you say otherwise, which would
  // make the real - invisible - text reappear on top of the mirror.
  const MOSES_HL_SELECTION_CSS = 'textarea.moses-hl::selection { color: transparent; }';

  /**
   * Every computed style that has to match between the textarea and the
   * mirror. Getting one of these wrong is the difference between "perfect"
   * and "drifts a bit further with every line", so the list is deliberately
   * exhaustive rather than minimal. Three groups:
   *   - font shaping: a difference compounds along each line
   *   - wrapping: a difference breaks every line after the first wrap
   *   - box: a difference offsets the whole block
   */
  const MIRRORED_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'fontStretch', 'fontVariantLigatures', 'fontFeatureSettings', 'fontKerning',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform',
    'textIndent', 'textRendering',
    'whiteSpace', 'overflowWrap', 'wordBreak', 'tabSize',
    'direction', 'unicodeBidi', 'textAlign',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  ];

  const KEYWORDS = new Set([
    'if', 'then', 'else', 'elseif', 'and', 'or', 'not', 'block', 'for', 'do',
    'while', 'thru', 'step', 'unless', 'next', 'return', 'true', 'false', 'done',
    'in', 'from',
  ]);

  // Deliberately modest and STACK-flavoured. Anything starting with "stack_"
  // is treated as a builtin too, without having to list them all.
  const BUILTINS = new Set([
    'sqrt', 'exp', 'log', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'abs',
    'float', 'ratsimp', 'radcan', 'factor', 'expand', 'simp', 'ev', 'subst',
    'matrix', 'transpose', 'determinant', 'invert', 'sum', 'product', 'diff',
    'integrate', 'limit', 'solve', 'rand', 'random', 'makelist', 'append',
    'length', 'first', 'last', 'rest', 'reverse', 'sort', 'map', 'apply',
    'lambda', 'sublist', 'setify', 'cons', 'part', 'num', 'denom', 'sconcat',
    'string', 'print', 'error',
  ]);

  const PAIR = { '(': ')', '[': ']', '{': '}' };

  // Longest first, so ":=" is never mistaken for ":" followed by "=".
  const OPERATORS = [
    '::=', ':=', '::', '<=', '>=', '^^', '#',
    '+', '-', '*', '/', '^', '=', '<', '>', ':', '!', ',', '.', "'", '@',
  ];

  // Sticky (/y) regexes match only at lastIndex, so they can be used as
  // "does a number/identifier start exactly here?" without slicing the string.
  const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eEbdf][+-]?\d+)?/y;
  const IDENT_RE = /[A-Za-z_%][A-Za-z0-9_%]*/y;

  const LIGHT_PALETTE = {
    text: '#24292e',
    comment: '#6a737d',
    string: '#032f62',
    number: '#005cc5',
    keyword: '#d73a49',
    builtin: '#6f42c1',
    variable: '#e36209',
    terminator: '#24292e',
    error: '#d73a49',
    caret: '#24292e',
    rainbow: ['#0184bc', '#a626a4', '#50a14f', '#c18401', '#e45649'],
    // CASText
    tag: '#22863a',
    attr: '#6f42c1',
    entity: '#005cc5',
    math: '#0184bc',
    casDelim: '#e36209',
    stackDelim: '#a626a4',
    stackKeyword: '#a626a4',
    stackName: '#0184bc',
  };

  const DARK_PALETTE = {
    text: '#d4d4d4',
    comment: '#6a9955',
    string: '#ce9178',
    number: '#b5cea8',
    keyword: '#c586c0',
    builtin: '#dcdcaa',
    variable: '#ffa657',
    terminator: '#d4d4d4',
    error: '#f14c4c',
    caret: '#d4d4d4',
    rainbow: ['#4fc1ff', '#c586c0', '#6a9955', '#dcdcaa', '#f14c4c'],
    // CASText
    tag: '#4ec9b0',
    attr: '#9cdcfe',
    entity: '#b5cea8',
    math: '#4fc1ff',
    casDelim: '#ffa657',
    stackDelim: '#c586c0',
    stackKeyword: '#c586c0',
    stackName: '#4fc1ff',
  };

  // ---------------------------------------------------------------------
  // Field classification
  // ---------------------------------------------------------------------

  /**
   * Which textareas are Maxima code? The repo already has exactly one way to
   * tell a "Maxima code field" from an "HTML content field", in
   * auto-close-html-tags.user.js: whether the id/name contains "variables".
   * That covers Question variables (id_questionvariables) and every PRT's
   * Feedback variables. We use the same test, inverted, so the two scripts
   * cannot disagree about which field is which.
   */
  function isMaximaField(textarea) {
    const key = (textarea.id + ' ' + textarea.name).toLowerCase();
    return key.includes('variables');
  }

  /**
   * 'maxima'  - Question variables, each PRT's Feedback variables
   * 'castext' - Question text, General feedback, each PRT node's feedback:
   *             HTML with STACK [[...]] tags, inline CAS {@ ... @} and LaTeX
   *             mixed into it
   * null      - not ours (rich-text editors keep a hidden textarea around)
   */
  function classifyField(textarea) {
    if (isEditorManaged(textarea)) {
      return null;
    }
    return isMaximaField(textarea) ? 'maxima' : 'castext';
  }

  /**
   * Moodle's rich-text editors (Atto, TinyMCE) keep the real <textarea> in
   * the DOM but hide it behind their own WYSIWYG UI. Highlighting it would
   * be invisible work at best. The offsetParent check catches most of these
   * already; this catches the case where the editor is initialised but its
   * textarea is still technically laid out.
   */
  function isEditorManaged(textarea) {
    return Boolean(
      textarea.closest('.editor_atto, .tox-tinymce, [data-fieldtype="editor"]')
    );
  }

  // ---------------------------------------------------------------------
  // Maxima tokenizer
  // ---------------------------------------------------------------------

  function nextNonSpaceChar(src, from) {
    let j = from;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t')) {
      j++;
    }
    return src[j];
  }

  function matchOperator(src, i) {
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        return op;
      }
    }
    return null;
  }

  /**
   * When we hit an assignment operator (`:` or `:=`), the thing being
   * assigned to is whatever significant token came immediately before it.
   * Usually that's a bare identifier (`x : 1`), but it can also be the
   * closing bracket of `a[1] : 1` or of `f(x) := ...` - and because the
   * tokenizer already recorded which open bracket each closer matches, we
   * can jump straight to the token before that opener instead of rescanning.
   */
  function markAssignmentTarget(tokens, lastIdx, assigned) {
    if (lastIdx < 0) {
      return;
    }
    const token = tokens[lastIdx];
    let nameIdx = -1;

    if (token.cls === 'ident' || token.cls === 'call' || token.cls === 'builtin') {
      nameIdx = lastIdx;
    } else if (token.cls === 'close' && token.match !== undefined) {
      const before = token.match - 1;
      if (before >= 0) {
        const candidate = tokens[before];
        if (
          candidate.cls === 'ident' ||
          candidate.cls === 'call' ||
          candidate.cls === 'builtin'
        ) {
          nameIdx = before;
        }
      }
    }

    if (nameIdx < 0) {
      return;
    }
    const target = tokens[nameIdx];
    target.cls = target.cls === 'call' ? 'funcdef' : 'assign';
    assigned.add(target.word);
  }

  /**
   * Single-pass scanner producing a flat array of { start, end, cls } records.
   *
   * Why a token array rather than emitting HTML as we go: rainbow brackets
   * need retroactive classification. You don't know whether a "(" is matched
   * until you reach its ")" - or until the end of the field, at which point
   * it becomes an error - and by then a string-emitting scanner would have
   * already flushed it. With an array we just write tokens[i].cls later.
   *
   * Tokens don't have to be contiguous: whatever falls between them is
   * emitted as plain text, so whitespace costs nothing.
   */
  function tokenizeMaxima(src) {
    const tokens = [];
    const openStack = [];
    const assigned = new Set();
    const len = src.length;
    let i = 0;
    let last = -1; // index of the last *significant* token (comments don't count)

    while (i < len) {
      const c = src[i];

      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++;
        continue;
      }

      // Block comments. Maxima's /* */ comments NEST, so we count depth
      // rather than stopping at the first */.
      if (c === '/' && src[i + 1] === '*') {
        const start = i;
        let depth = 0;
        while (i < len) {
          if (src[i] === '/' && src[i + 1] === '*') {
            depth++;
            i += 2;
          } else if (src[i] === '*' && src[i + 1] === '/') {
            depth--;
            i += 2;
            if (depth === 0) {
              break;
            }
          } else {
            i++;
          }
        }
        tokens.push({ start, end: i, cls: depth === 0 ? 'comment' : 'error' });
        continue; // deliberately does NOT update `last`
      }

      if (c === '"') {
        const start = i;
        let closed = false;
        i++;
        while (i < len) {
          if (src[i] === '\\') {
            i += 2;
            continue;
          }
          if (src[i] === '"') {
            i++;
            closed = true;
            break;
          }
          i++;
        }
        last = tokens.push({ start, end: i, cls: closed ? 'string' : 'error' }) - 1;
        continue;
      }

      if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        NUMBER_RE.lastIndex = i;
        const match = NUMBER_RE.exec(src);
        if (match) {
          const start = i;
          i += match[0].length;
          last = tokens.push({ start, end: i, cls: 'number' }) - 1;
          continue;
        }
      }

      if (c === ';' || c === '$') {
        const start = i;
        i++;
        last = tokens.push({ start, end: i, cls: 'terminator', op: c }) - 1;
        continue;
      }

      if (c === '(' || c === '[' || c === '{') {
        const start = i;
        i++;
        const idx =
          tokens.push({ start, end: i, cls: 'open', ch: c, depth: openStack.length }) - 1;
        openStack.push(idx);
        last = idx;
        continue;
      }

      if (c === ')' || c === ']' || c === '}') {
        const start = i;
        i++;
        const idx = tokens.push({ start, end: i, cls: 'close', ch: c }) - 1;
        const openIdx = openStack.pop();
        if (openIdx === undefined) {
          tokens[idx].cls = 'error'; // a closer with nothing to close
        } else if (PAIR[tokens[openIdx].ch] !== c) {
          tokens[idx].cls = 'error'; // ( closed by ], etc
          tokens[openIdx].cls = 'error';
        } else {
          tokens[idx].depth = tokens[openIdx].depth;
          tokens[idx].match = openIdx;
          tokens[openIdx].match = idx;
        }
        last = idx;
        continue;
      }

      IDENT_RE.lastIndex = i;
      const identMatch = IDENT_RE.exec(src);
      if (identMatch) {
        const word = identMatch[0];
        const start = i;
        i += word.length;
        let cls;
        if (KEYWORDS.has(word)) {
          cls = 'keyword';
        } else if (BUILTINS.has(word) || word.startsWith('stack_') || word.startsWith('%')) {
          cls = 'builtin';
        } else if (nextNonSpaceChar(src, i) === '(') {
          cls = 'call';
        } else {
          cls = 'ident';
        }
        last = tokens.push({ start, end: i, cls, word }) - 1;
        continue;
      }

      const op = matchOperator(src, i);
      if (op) {
        const start = i;
        i += op.length;
        const idx = tokens.push({ start, end: i, cls: 'operator', op }) - 1;
        if (op === ':' || op === ':=' || op === '::' || op === '::=') {
          markAssignmentTarget(tokens, last, assigned);
        }
        last = idx;
        continue;
      }

      i++; // unrecognised character - render it as plain text
    }

    // Anything still open at the end was never closed.
    while (openStack.length) {
      tokens[openStack.pop()].cls = 'error';
    }

    // Relabel pass. This is what makes a variable you defined stand out
    // *everywhere it appears*, not just where it was assigned - which is the
    // whole point of colouring variables distinctly from the language.
    for (const token of tokens) {
      if (!token.word || !assigned.has(token.word)) {
        continue;
      }
      if (token.cls === 'ident' || token.cls === 'builtin') {
        token.cls = 'var';
      } else if (token.cls === 'call') {
        token.cls = 'userfunc';
      }
    }

    return { tokens, assigned };
  }

  // ---------------------------------------------------------------------
  // CASText tokenizer (Question text, feedback)
  // ---------------------------------------------------------------------

  /**
   * The [[...]] verbs STACK actually recognises, per its documentation.
   * Anything else gets a "this looks like a typo" colour rather than being
   * silently accepted - which is the cheapest possible spell-checker for the
   * one part of the syntax you can't get wrong quietly.
   */
  const STACK_VERBS = new Set([
    'input', 'validation', 'feedback', 'comment', 'if', 'else', 'elif',
    'foreach', 'define', 'reveal', 'hint', 'adapt', 'todo', 'debug', 'lang',
    'format', 'textdownload', 'include', 'quid', 'template', 'jsxgraph',
    'jsstring', 'geogebra', 'parsons', 'javascript', 'ascii', 'iframe',
    'style', 'script', 'facts', 'score',
  ]);

  // Verbs that must be closed with a matching [[/verb]]. input/validation/
  // feedback/define/debug stand alone and must NOT be flagged as unclosed.
  const STACK_BLOCK_VERBS = new Set([
    'comment', 'if', 'foreach', 'reveal', 'hint', 'adapt', 'todo', 'lang',
    'format', 'textdownload', 'include', 'quid', 'template', 'jsxgraph',
    'jsstring', 'geogebra', 'parsons', 'javascript', 'ascii', 'iframe',
    'style', 'script', 'facts',
  ]);

  const STACK_HEAD_RE = /^(\s*)(\/?)\s*([A-Za-z_][A-Za-z0-9_-]*)/;
  const STACK_NAME_RE = /^:\s*([A-Za-z0-9_]+)/;
  const STACK_ATTR_RE = /^[A-Za-z_][A-Za-z0-9_-]*/;
  const HTML_HEAD_RE = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;
  const HTML_ATTR_RE = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*/;
  const ENTITY_RE = /^&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;

  /**
   * `{@ ... @}` renders a CAS expression as LaTeX, `{# ... #}` as raw Maxima.
   * Either way the contents are Maxima, so we hand them to the Maxima
   * tokenizer and shift the resulting positions back into place. Slicing the
   * substring rather than teaching that tokenizer about bounds keeps it free
   * of off-by-one edge cases at the seam.
   */
  function emitInlineCas(tokens, src, start) {
    const closer = src[start + 1] + '}';
    const innerStart = start + 2;
    const closeAt = src.indexOf(closer, innerStart);
    if (closeAt === -1) {
      tokens.push({ start, end: src.length, cls: 'error' });
      return src.length;
    }
    tokens.push({ start, end: innerStart, cls: 'cas-delim' });
    for (const token of tokenizeMaxima(src.slice(innerStart, closeAt)).tokens) {
      token.start += innerStart;
      token.end += innerStart;
      tokens.push(token);
    }
    tokens.push({ start: closeAt, end: closeAt + 2, cls: 'cas-delim' });
    return closeAt + 2;
  }

  /**
   * Whatever follows the verb inside a [[...]] tag: the `:ansN` / `:prtN`
   * name, and any key="value" attributes.
   */
  function emitTagRemainder(tokens, src, from, to) {
    let i = from;
    while (i < to) {
      const c = src[i];
      const rest = src.slice(i, to);

      if (c === ':') {
        const match = STACK_NAME_RE.exec(rest);
        if (match) {
          const nameStart = i + match[0].length - match[1].length;
          tokens.push({ start: i, end: nameStart, cls: 'stack-delim' });
          tokens.push({ start: nameStart, end: nameStart + match[1].length, cls: 'stack-name' });
          i += match[0].length;
          continue;
        }
      }

      if (c === '"' || c === "'") {
        const quote = src.indexOf(c, i + 1);
        const end = quote === -1 || quote >= to ? to : quote + 1;
        tokens.push({ start: i, end, cls: 'string' });
        i = end;
        continue;
      }

      const attr = STACK_ATTR_RE.exec(rest);
      if (attr) {
        tokens.push({ start: i, end: i + attr[0].length, cls: 'stack-attr' });
        i += attr[0].length;
        continue;
      }

      i++;
    }
  }

  function emitStackTag(tokens, src, start, blockStack) {
    const closeAt = src.indexOf(']]', start + 2);
    if (closeAt === -1) {
      tokens.push({ start, end: src.length, cls: 'error' });
      return src.length;
    }
    const end = closeAt + 2;
    const inner = src.slice(start + 2, closeAt);
    const head = STACK_HEAD_RE.exec(inner);
    if (!head) {
      tokens.push({ start, end, cls: 'error' }); // [[ ]] with no verb at all
      return end;
    }

    const verb = head[3];
    const isCloser = head[2] === '/';
    const verbStart = start + 2 + head[0].length - verb.length;
    const verbEnd = verbStart + verb.length;

    tokens.push({ start, end: verbStart, cls: 'stack-delim' });
    const known = STACK_VERBS.has(verb);
    const verbToken = {
      start: verbStart,
      end: verbEnd,
      cls: known ? 'stack-keyword' : 'stack-unknown',
      verb,
    };
    const verbIdx = tokens.push(verbToken) - 1;

    // Track [[if]]...[[/if]] style pairing so an unclosed or stray block
    // shows up immediately. `[[ define x=1 /]]` closes itself, and
    // input/validation/feedback never take a closer at all.
    if (known && STACK_BLOCK_VERBS.has(verb) && !/\/\s*$/.test(inner)) {
      if (isCloser) {
        const openIdx = blockStack.pop();
        if (openIdx === undefined || tokens[openIdx].verb !== verb) {
          verbToken.cls = 'error';
          if (openIdx !== undefined) {
            blockStack.push(openIdx); // a mismatch doesn't close the opener
          }
        }
      } else {
        blockStack.push(verbIdx);
      }
    }

    emitTagRemainder(tokens, src, verbEnd, closeAt);
    tokens.push({ start: closeAt, end, cls: 'stack-delim' });
    return end;
  }

  function emitHtmlTag(tokens, src, start) {
    const gt = src.indexOf('>', start);
    if (gt === -1) {
      return start + 1; // a bare '<' in prose - leave it as plain text
    }
    const head = HTML_HEAD_RE.exec(src.slice(start, gt + 1));
    if (!head) {
      return start + 1;
    }

    const nameEnd = start + head[0].length;
    tokens.push({ start, end: nameEnd, cls: 'tag' });

    let i = nameEnd;
    while (i < gt) {
      const c = src[i];
      if (c === '"' || c === "'") {
        const quote = src.indexOf(c, i + 1);
        const end = quote === -1 || quote > gt ? gt : quote + 1;
        tokens.push({ start: i, end, cls: 'string' });
        i = end;
        continue;
      }
      const attr = HTML_ATTR_RE.exec(src.slice(i, gt));
      if (attr) {
        tokens.push({ start: i, end: i + attr[0].length, cls: 'attr' });
        i += attr[0].length;
        continue;
      }
      i++;
    }

    tokens.push({ start: gt, end: gt + 1, cls: 'tag' });
    return gt + 1;
  }

  /**
   * CASText is HTML with three other languages embedded in it, so this is a
   * dispatcher rather than a grammar: at each position, work out which of
   * them we're looking at and hand off.
   *
   * The one piece of real state is `mathCloser`. Inside \( ... \) or
   * \[ ... \] everything is maths and gets one colour - except embedded
   * {@ ... @}, which STACK routinely puts inside LaTeX and which should keep
   * its CAS colours. So the loop stays in "maths mode" until it sees the
   * closing delimiter, flushing runs of plain maths text as it goes.
   *
   * Note that $...$ is deliberately NOT treated as maths: STACK's docs say
   * dollar delimiters are unsupported, and guessing would misfire on any
   * question that mentions a price.
   */
  function tokenizeCastext(src) {
    const tokens = [];
    const blockStack = [];
    const len = src.length;
    let i = 0;
    let mathCloser = null;
    let mathDelimIdx = -1;
    let mathTextStart = -1;

    function flushMathText(end) {
      if (mathTextStart >= 0 && end > mathTextStart) {
        tokens.push({ start: mathTextStart, end, cls: 'math' });
      }
      mathTextStart = -1;
    }

    while (i < len) {
      const c = src[i];

      if (mathCloser && src.startsWith(mathCloser, i)) {
        flushMathText(i);
        tokens.push({ start: i, end: i + mathCloser.length, cls: 'math-delim' });
        i += mathCloser.length;
        mathCloser = null;
        mathDelimIdx = -1;
        continue;
      }

      if (c === '{' && (src[i + 1] === '@' || src[i + 1] === '#')) {
        flushMathText(i);
        i = emitInlineCas(tokens, src, i);
        if (mathCloser) {
          mathTextStart = i;
        }
        continue;
      }

      if (mathCloser) {
        if (mathTextStart < 0) {
          mathTextStart = i;
        }
        i++;
        continue;
      }

      if (c === '\\' && (src[i + 1] === '(' || src[i + 1] === '[')) {
        mathCloser = src[i + 1] === '(' ? '\\)' : '\\]';
        mathDelimIdx = tokens.push({ start: i, end: i + 2, cls: 'math-delim' }) - 1;
        i += 2;
        mathTextStart = i;
        continue;
      }

      if (c === '[' && src[i + 1] === '[') {
        i = emitStackTag(tokens, src, i, blockStack);
        continue;
      }

      if (c === '<' && src.startsWith('<!--', i)) {
        const close = src.indexOf('-->', i + 4);
        const end = close === -1 ? len : close + 3;
        tokens.push({ start: i, end, cls: close === -1 ? 'error' : 'comment' });
        i = end;
        continue;
      }

      if (c === '<') {
        const next = emitHtmlTag(tokens, src, i);
        i = next > i ? next : i + 1;
        continue;
      }

      if (c === '&') {
        const entity = ENTITY_RE.exec(src.slice(i, i + 12));
        if (entity) {
          tokens.push({ start: i, end: i + entity[0].length, cls: 'entity' });
          i += entity[0].length;
          continue;
        }
      }

      i++;
    }

    flushMathText(len);
    if (mathDelimIdx >= 0) {
      tokens[mathDelimIdx].cls = 'error'; // a \( that was never closed
    }
    for (const openIdx of blockStack) {
      tokens[openIdx].cls = 'error'; // a [[block]] that was never closed
    }

    return { tokens };
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  const NEEDS_ESCAPE_RE = /[&<>]/;

  function escapeHtml(text) {
    // The overwhelming majority of slices contain none of these, and a
    // single test is far cheaper than three unconditional replaces on a
    // string we rebuild on every keystroke.
    if (!NEEDS_ESCAPE_RE.test(text)) {
      return text;
    }
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Token classes that are rendered in the mirror's base colour anyway, so
   * wrapping them in a <span> would cost bytes and parse time to change
   * nothing. Plain identifiers and operators are the bulk of a Maxima field,
   * and skipping them roughly halves the generated markup.
   */
  const PLAIN_CLASSES = new Set(['ident', 'operator']);

  function renderTokens(src, tokens) {
    let html = '';
    let pos = 0;

    for (const token of tokens) {
      // Tokens must arrive in order and must not overlap, or the text would
      // be silently duplicated - and the mirror showing something other than
      // what you typed is the one bug that would be genuinely dangerous
      // here. Skipping a stray token loses a colour; it never loses text.
      if (token.start < pos) {
        continue;
      }
      if (token.start > pos) {
        html += escapeHtml(src.slice(pos, token.start));
      }
      const text = escapeHtml(src.slice(token.start, token.end));
      if (PLAIN_CLASSES.has(token.cls)) {
        html += text;
      } else {
        const cls =
          token.cls === 'open' || token.cls === 'close'
            ? 'b' + (token.depth % RAINBOW_DEPTHS)
            : token.cls;
        html += '<span class="' + cls + '">' + text + '</span>';
      }
      pos = token.end;
    }

    if (pos < src.length) {
      html += escapeHtml(src.slice(pos));
    }

    // A textarea shows an empty final line for a trailing newline; an inline
    // formatting context won't necessarily generate a line box for it, which
    // would make the mirror one line shorter than the text. A zero-width
    // space forces the box to exist.
    if (src.endsWith('\n')) {
      html += '​';
    }

    return html;
  }

  function isDarkBackground(computedStyle) {
    const match = /rgba?\(([^)]+)\)/.exec(computedStyle.backgroundColor);
    if (!match) {
      return false;
    }
    const parts = match[1].split(',').map(parseFloat);
    if (parts.length > 3 && parts[3] === 0) {
      return false; // fully transparent - assume the usual light Moodle theme
    }
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2] < 128;
  }

  function buildTokenCss(palette) {
    const rules = [
      ':host { display: block; }',
      '.mirror { margin: 0; background: transparent; color: ' + palette.text + '; }',
      '.comment { color: ' + palette.comment + '; font-style: italic; }',
      '.string { color: ' + palette.string + '; }',
      '.number { color: ' + palette.number + '; }',
      '.keyword { color: ' + palette.keyword + '; }',
      '.builtin, .call { color: ' + palette.builtin + '; }',
      '.var, .assign { color: ' + palette.variable + '; }',
      '.userfunc, .funcdef { color: ' + palette.variable + '; font-weight: 700; }',
      // Note: plain identifiers and operators get no span at all (see
      // PLAIN_CLASSES) - they inherit .mirror's colour, which is the point.
      '.terminator { color: ' + palette.terminator + '; font-weight: 700; }',
      '.error { color: ' + palette.error + '; text-decoration: underline wavy ' + palette.error + '; }',
      // CASText
      '.tag { color: ' + palette.tag + '; }',
      '.attr { color: ' + palette.attr + '; }',
      '.entity { color: ' + palette.entity + '; }',
      '.math { color: ' + palette.math + '; }',
      '.math-delim { color: ' + palette.math + '; font-weight: 700; }',
      '.cas-delim { color: ' + palette.casDelim + '; font-weight: 700; }',
      '.stack-delim { color: ' + palette.stackDelim + '; }',
      '.stack-keyword { color: ' + palette.stackKeyword + '; font-weight: 700; }',
      '.stack-name { color: ' + palette.stackName + '; font-weight: 700; }',
      '.stack-attr { color: ' + palette.attr + '; }',
      '.stack-unknown { color: ' + palette.error + '; text-decoration: underline dotted ' + palette.error + '; }',
    ];
    palette.rainbow.forEach((colour, n) => {
      rules.push('.b' + n + ' { color: ' + colour + '; }');
    });
    return rules.join('\n');
  }

  /**
   * Styles go in as a constructed stylesheet rather than a <style> element or
   * a style="" attribute. Both of those are *parsed* CSS and so are subject
   * to the page's Content-Security-Policy; CSSOM assignment is not. (This is
   * also why the existing scripts' element.style.foo = ... writes have never
   * hit a CSP problem.) The <style> path stays as a fallback for browsers
   * without constructable stylesheets.
   */
  function adoptStyles(root, cssText) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      root.adoptedStyleSheets = [sheet];
    } catch (err) {
      const styleEl = document.createElement('style');
      styleEl.textContent = cssText;
      root.appendChild(styleEl);
    }
  }

  let selectionCssInstalled = false;

  function installSelectionCss() {
    if (selectionCssInstalled) {
      return;
    }
    selectionCssInstalled = true;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(MOSES_HL_SELECTION_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch (err) {
      const styleEl = document.createElement('style');
      styleEl.textContent = MOSES_HL_SELECTION_CSS;
      document.head.appendChild(styleEl);
    }
  }

  // ---------------------------------------------------------------------
  // The overlay
  // ---------------------------------------------------------------------

  const attached = new WeakSet();
  const liveStates = new Set();

  function fieldLabel(textarea) {
    return textarea.id || textarea.name || '<unnamed textarea>';
  }

  function syncMetrics(state) {
    const { textarea, host, mirror } = state;
    const cs = getComputedStyle(textarea);

    for (const prop of MIRRORED_PROPS) {
      mirror.style[prop] = cs[prop];
    }
    // Occupy the same border box as the textarea, but paint nothing: the
    // real border is drawn by the textarea underneath.
    mirror.style.borderStyle = 'solid';
    mirror.style.borderColor = 'transparent';
    mirror.style.boxSizing = 'border-box';
    mirror.style.width = '100%';

    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;

    // clientWidth/clientHeight are the padding box MINUS any scrollbar.
    // Sizing the mirror from those (rather than offsetWidth) is what makes
    // wrapping identical once the field is tall enough to need a scrollbar -
    // otherwise every wrapped line would break one character too late.
    host.style.width = textarea.clientWidth + bl + br + 'px';
    host.style.height = textarea.clientHeight + bt + bb + 'px';

    const parent = host.parentElement;
    if (!parent) {
      return;
    }
    const parentRect = parent.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    const parentCs = getComputedStyle(parent);
    // Absolute offsets are measured from the parent's padding box, so the
    // parent's own border width has to come out.
    host.style.left =
      textareaRect.left - parentRect.left - (parseFloat(parentCs.borderLeftWidth) || 0) + 'px';
    host.style.top =
      textareaRect.top - parentRect.top - (parseFloat(parentCs.borderTopWidth) || 0) + 'px';
  }

  function renderOverlay(state) {
    const value = state.textarea.value;
    if (value === state.lastValue) {
      return;
    }
    const started = performance.now();
    const result = state.tokenize(value);
    state.mirror.innerHTML = renderTokens(value, result.tokens);
    state.lastValue = value;
    state.renderMs = performance.now() - started;
  }

  function syncScroll(state) {
    state.host.scrollTop = state.textarea.scrollTop;
    state.host.scrollLeft = state.textarea.scrollLeft;
  }

  /**
   * The overlay is positioned by arithmetic on rectangles, and that
   * arithmetic assumes the parent is a plain block container. If Moodle's
   * theme wraps this field in a flex or grid container, or one with its own
   * transform, the host can land somewhere else entirely. Rather than ship a
   * field whose text ghosts a few pixels off - which is worse than no
   * highlighting at all - measure it and bail out loudly.
   */
  function verifyAlignment(state) {
    const textareaRect = state.textarea.getBoundingClientRect();
    const hostRect = state.host.getBoundingClientRect();
    const dx = Math.abs(textareaRect.left - hostRect.left);
    const dy = Math.abs(textareaRect.top - hostRect.top);
    if (dx > ALIGN_TOLERANCE_PX || dy > ALIGN_TOLERANCE_PX) {
      console.warn(
        LOG_PREFIX +
          ' overlay for "' + fieldLabel(state.textarea) + '" is off by ' +
          dx.toFixed(1) + 'px x ' + dy.toFixed(1) + 'px, so highlighting was ' +
          'disabled for it. Its parent element is probably a flex/grid/' +
          'transformed container. Report those numbers and the field id.'
      );
      return false;
    }
    return true;
  }

  /**
   * The attach-time alignment check compares the two boxes, which catches a
   * mispositioned overlay but not a *mis-wrapped* one: if the mirror breaks
   * lines even one character differently from the textarea, the boxes still
   * line up but the text inside them diverges further down the field. Total
   * height is the cheap tell - different wrapping means a different number
   * of lines. Warn rather than detach, since a one-off transient shouldn't
   * tear down a field that's working.
   */
  function checkWrapping(state) {
    if (state.wrapWarned) {
      return;
    }
    const lineHeight = parseFloat(getComputedStyle(state.textarea).lineHeight) || 16;
    const drift = Math.abs(state.mirror.scrollHeight - state.textarea.scrollHeight);
    if (drift > lineHeight) {
      state.wrapWarned = true;
      console.warn(
        LOG_PREFIX + ' "' + fieldLabel(state.textarea) + '" wraps differently from its ' +
          'overlay (' + state.mirror.scrollHeight + 'px vs ' + state.textarea.scrollHeight +
          'px, line height ' + lineHeight.toFixed(1) + 'px), so colours further down the ' +
          'field may sit under the wrong text. Please report this along with the field id.'
      );
    }
  }

  function detachOverlay(state, reason) {
    if (!state.alive) {
      return;
    }
    state.alive = false;
    liveStates.delete(state);

    if (state.frame) {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    }
    clearTimeout(state.renderTimer);
    if (state.styleObserver) {
      state.styleObserver.disconnect();
    }
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
    }
    for (const [type, handler] of state.listeners) {
      state.textarea.removeEventListener(type, handler);
    }
    state.host.remove();
    if (state.madeParentRelative) {
      state.parent.style.position = '';
    }

    const style = state.textarea.style;
    state.textarea.classList.remove('moses-hl');
    state.textarea.spellcheck = state.originalSpellcheck;
    style.color = state.originalColor;
    style.caretColor = '';
    style.fontFamily = state.originalFontFamily;
    style.removeProperty('font-variant-ligatures');
    style.removeProperty('font-kerning');
    style.removeProperty('font-feature-settings');

    if (reason) {
      console.warn(LOG_PREFIX + ' detached from "' + fieldLabel(state.textarea) + '": ' + reason);
    }
  }

  /**
   * All three kinds of update (re-measure, re-render, re-scroll) share one
   * animation frame. They accumulate as flags rather than as queued
   * callbacks, because several can be requested between two frames - a
   * keystroke that also scrolls the field, say - and the frame must do all
   * of them, in this order, rather than only the first or only the last.
   */
  function schedule(state, job) {
    if (!state.alive) {
      return;
    }
    state.pending[job] = true;
    if (state.frame) {
      return;
    }
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      if (!state.alive) {
        return;
      }
      if (!state.textarea.isConnected) {
        detachOverlay(state, 'the textarea was removed from the page');
        return;
      }
      const jobs = state.pending;
      state.pending = { metrics: false, render: false, scroll: false };
      try {
        if (jobs.metrics) {
          syncMetrics(state);
        }
        if (jobs.render) {
          renderOverlay(state);
          checkWrapping(state);
        }
        syncScroll(state);
      } catch (err) {
        // An exception here would leave transparent text over a stale mirror,
        // i.e. an invisible field. Restoring plain text is always recoverable.
        detachOverlay(state, 'update failed: ' + err);
        console.warn(LOG_PREFIX + ' exception while updating the overlay', err);
      }
    });
  }

  /**
   * Re-highlighting normally happens in the same frame as the keystroke, so
   * the colours never visibly lag behind the caret. On a field big enough
   * that a full re-tokenise no longer fits in a frame, that would instead
   * make typing feel heavy - so such fields fall back to a trailing debounce,
   * trading a moment's delay in the colours for a responsive caret. Scroll
   * and metric syncing always stay on the frame path: a debounced scroll
   * sync is immediately, visibly wrong.
   */
  function scheduleRender(state) {
    if (!state.alive) {
      return;
    }
    if (state.renderMs > RENDER_BUDGET_MS) {
      clearTimeout(state.renderTimer);
      state.renderTimer = setTimeout(() => {
        state.renderTimer = 0;
        schedule(state, 'render');
      }, SLOW_RENDER_DELAY_MS);
      return;
    }
    schedule(state, 'render');
  }

  function attachOverlay(textarea, mode) {
    const parent = textarea.parentElement;
    if (!parent) {
      return;
    }

    // Making the parent a containing block is the least invasive way to get
    // an absolutely positioned sibling to line up. It only affects elements
    // that are themselves absolutely positioned inside it - i.e. ours - and
    // we remember whether we did it so detaching leaves no trace.
    const madeParentRelative = getComputedStyle(parent).position === 'static';
    if (madeParentRelative) {
      parent.style.position = 'relative';
    }

    const host = document.createElement('div');
    host.setAttribute('data-moses-highlight', '');
    host.style.position = 'absolute';
    host.style.pointerEvents = 'none';
    host.style.overflow = 'hidden';
    host.style.zIndex = '2';

    const root = host.attachShadow({ mode: 'open' });
    const palette = isDarkBackground(getComputedStyle(textarea))
      ? DARK_PALETTE
      : LIGHT_PALETTE;
    adoptStyles(root, buildTokenCss(palette));

    const mirror = document.createElement('div');
    mirror.className = 'mirror';
    root.appendChild(mirror);
    // After the textarea, so it paints on top without needing a z-index on
    // the textarea itself. One childList mutation, once, per field.
    parent.insertBefore(host, textarea.nextSibling);

    const state = {
      textarea,
      host,
      mirror,
      palette,
      alive: true,
      frame: 0,
      pending: { metrics: false, render: false, scroll: false },
      renderTimer: 0,
      renderMs: 0,
      lastValue: null,
      listeners: [],
      mode,
      tokenize: mode === 'maxima' ? tokenizeMaxima : tokenizeCastext,
      parent,
      madeParentRelative,
      originalColor: textarea.style.color,
      originalFontFamily: textarea.style.fontFamily,
      originalSpellcheck: textarea.spellcheck,
    };

    // EVERY write to the textarea's own style happens here, before the style
    // MutationObserver below is installed. If one happened afterwards it
    // would retrigger the observer, which would sync, which would... - an
    // infinite loop. After this point we only ever write to the mirror.
    textarea.classList.add('moses-hl');
    if (mode === 'maxima') {
      // Spellchecking Maxima identifiers is pure noise. Question text is
      // prose, though, so it keeps its spellcheck - the squiggles are drawn
      // by the textarea underneath and show through the mirror's
      // transparent background, landing under the right words.
      textarea.spellcheck = false;
      textarea.style.fontFamily = CODE_FONT_STACK;
    }
    // Ligatures and kerning both adjust glyph positions based on the
    // *neighbouring* glyph, and neither applies across a span boundary - so
    // the textarea (one continuous run) and the mirror (chopped into spans)
    // would lay the same line out differently. Monospace makes kerning moot,
    // which is why code fields get it; prose fields keep Moodle's font and
    // switch kerning off instead, which costs a little tightness in pairs
    // like "AV" but keeps the two in lockstep.
    textarea.style.setProperty('font-variant-ligatures', 'none');
    textarea.style.setProperty('font-kerning', 'none');
    textarea.style.setProperty('font-feature-settings', '"liga" 0, "calt" 0, "kern" 0');

    try {
      syncMetrics(state);
      renderOverlay(state);
      syncScroll(state);
    } catch (err) {
      detachOverlay(state, 'first render failed: ' + err);
      console.warn(LOG_PREFIX + ' exception during first render', err);
      return;
    }

    if (!verifyAlignment(state)) {
      detachOverlay(state, null);
      return;
    }

    // Only now, with a proven-good mirror in place, is it safe to hide the
    // real text.
    installSelectionCss();
    textarea.style.color = 'transparent';
    textarea.style.caretColor = palette.caret;
    liveStates.add(state);

    const onInput = () => scheduleRender(state);
    const onScroll = () => schedule(state, 'scroll');
    // During IME composition the pre-edit text is not in .value yet, so the
    // mirror can't show it. Reveal the real text until composition ends.
    const onCompositionStart = () => {
      state.textarea.style.color = state.originalColor;
      state.host.style.display = 'none';
    };
    const onCompositionEnd = () => {
      state.host.style.display = '';
      state.textarea.style.color = 'transparent';
      onInput();
    };

    state.listeners = [
      ['input', onInput],
      ['scroll', onScroll],
      ['compositionstart', onCompositionStart],
      ['compositionend', onCompositionEnd],
    ];
    for (const [type, handler] of state.listeners) {
      textarea.addEventListener(type, handler);
    }

    // moodle-stack-helper.user.js changes this textarea's fontSize (Ctrl+
    // scroll) and height (drag handle) and offers no callback to hook, so
    // the style attribute mutation is the only signal we get.
    state.styleObserver = new MutationObserver(() => schedule(state, 'metrics'));
    state.styleObserver.observe(textarea, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    state.resizeObserver = new ResizeObserver(() => schedule(state, 'metrics'));
    state.resizeObserver.observe(textarea);

    // These numbers are the whole diagnostic story if a field ever looks
    // wrong: the two heights should agree to within a line, and the render
    // time says whether this field is on the frame or the debounce path.
    console.info(
      LOG_PREFIX + ' attached to "' + fieldLabel(textarea) + '" as ' + mode +
        ' (mirror ' + mirror.scrollHeight + 'px vs textarea ' +
        textarea.scrollHeight + 'px, first render ' + state.renderMs.toFixed(1) + 'ms)'
    );
    checkWrapping(state);
  }

  function maybeAttach(node) {
    if (!node || node.tagName !== 'TEXTAREA' || attached.has(node)) {
      return;
    }
    const mode = classifyField(node);
    if (!mode) {
      return;
    }
    // Measuring a hidden element gives a zero-sized rect, so there is no
    // point attaching before it's on screen. Collapsed PRT sections are
    // handled by the focusin path below - you can't type into a field you
    // haven't clicked into.
    if (node.offsetParent === null) {
      return;
    }
    if (node.value.length > MAX_FIELD_CHARS) {
      console.warn(
        LOG_PREFIX + ' skipping "' + fieldLabel(node) + '": ' + node.value.length +
          ' characters is above the ' + MAX_FIELD_CHARS + ' limit for highlighting.'
      );
      attached.add(node);
      return;
    }
    attached.add(node);
    attachOverlay(node, mode);
  }

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------

  function scanNow() {
    document.querySelectorAll('textarea').forEach(maybeAttach);
  }

  function teardownAll() {
    for (const state of Array.from(liveStates)) {
      detachOverlay(state, null);
    }
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Toggle STACK syntax highlighting', () => {
      const nowEnabled = !GM_getValue(ENABLED_STORAGE_KEY, true);
      GM_setValue(ENABLED_STORAGE_KEY, nowEnabled);
      if (nowEnabled) {
        scanNow();
      } else {
        teardownAll();
      }
      console.info(LOG_PREFIX + ' highlighting ' + (nowEnabled ? 'enabled' : 'disabled'));
    });
  }

  if (GM_getValue(ENABLED_STORAGE_KEY, true)) {
    scanNow();
  }

  // Fields inside a collapsed "Potential response tree N" section aren't laid
  // out yet, and new ones can appear later (e.g. an "Add another PRT" button),
  // so a single scan can't see them. Rather than watch the whole document,
  // attach the moment a field is focused: you cannot edit a textarea without
  // focusing it first, so this covers every case for free - and costs nothing
  // while you're not clicking.
  document.addEventListener('focusin', (event) => {
    if (GM_getValue(ENABLED_STORAGE_KEY, true)) {
      maybeAttach(event.target);
    }
  });
})();
