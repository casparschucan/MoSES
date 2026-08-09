// ==UserScript==
// @name         MoSES: Syntax highlighting
// @namespace    https://github.com/casparschucan/MoSES
// @version      0.1.0
// @description  Syntax-highlights the Maxima code fields (Question variables, each PRT's Feedback variables) on ETHZ Moodle STACK question edit pages: rainbow-matched brackets, a distinct colour for the variables you define, plus strings, comments, numbers and keywords.
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
    'fontStretch', 'fontVariantLigatures', 'fontFeatureSettings',
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
    const result = tokenizeMaxima(value);
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
    state.textarea.spellcheck = true;
    style.color = state.originalColor;
    style.caretColor = '';
    style.fontFamily = state.originalFontFamily;
    style.removeProperty('font-variant-ligatures');
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

  function attachOverlay(textarea) {
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
      parent,
      madeParentRelative,
      originalColor: textarea.style.color,
      originalFontFamily: textarea.style.fontFamily,
    };

    // EVERY write to the textarea's own style happens here, before the style
    // MutationObserver below is installed. If one happened afterwards it
    // would retrigger the observer, which would sync, which would... - an
    // infinite loop. After this point we only ever write to the mirror.
    textarea.classList.add('moses-hl');
    textarea.spellcheck = false;   // squiggles would show through the overlay
    textarea.style.fontFamily = CODE_FONT_STACK;
    textarea.style.setProperty('font-variant-ligatures', 'none');
    textarea.style.setProperty('font-feature-settings', '"liga" 0, "calt" 0');

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

    // These three numbers are the whole diagnostic story if a field ever
    // looks wrong: the two heights should agree to within a line, and the
    // render time says whether this field is on the frame or debounce path.
    console.info(
      LOG_PREFIX + ' attached to "' + fieldLabel(textarea) + '" (mirror ' +
        mirror.scrollHeight + 'px vs textarea ' + textarea.scrollHeight + 'px, ' +
        'first render ' + state.renderMs.toFixed(1) + 'ms)'
    );
  }

  function maybeAttach(node) {
    if (!node || node.tagName !== 'TEXTAREA' || attached.has(node)) {
      return;
    }
    if (!isMaximaField(node) || isEditorManaged(node)) {
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
    attachOverlay(node);
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
