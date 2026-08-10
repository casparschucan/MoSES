// ==UserScript==
// @name         MoSES: STACK lint
// @namespace    https://github.com/casparschucan/MoSES
// @version      0.1.1
// @description  Checks each field on the ETHZ Moodle STACK question edit page as you type - unbalanced brackets, unterminated strings and comments, statements without a semicolon, [[input:ansN]] tags with no matching [[validation:ansN]], and more - and lists what it found under the field.
// @author       Caspar Schucan
// @match        https://moodle-app2.let.ethz.ch/question/bank/editquestion/question.php*
// @match        https://moodle-app6.let.ethz.ch/question/bank/editquestion/question.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @require      https://raw.githubusercontent.com/casparschucan/MoSES/main/lib/stack-lang.v1.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/casparschucan/MoSES/main/stack-lint.user.js
// @downloadURL  https://raw.githubusercontent.com/casparschucan/MoSES/main/stack-lint.user.js
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * Watches every field on the question form and, a moment after you stop
 * typing, lists anything that looks wrong in a small strip underneath it:
 *
 *   Line 7  -  statement doesn't end with ;
 *   Line 12 -  this ( is never closed
 *
 * Clicking a row puts the caret on the offending line. When a field is clean
 * the strip disappears entirely, so it costs no space in the normal case.
 *
 * A STRIP, NOT SQUIGGLY UNDERLINES
 * -------------------------------------------------------------------------
 * Squiggles under the offending text would be prettier, but they would have
 * to be drawn by syntax-highlight.user.js's overlay - which would mean this
 * script silently doing nothing whenever that one is disabled or not
 * installed, and the repo's whole point is that each feature stands alone. A
 * strip also does something squiggles can't: click a row and go straight to
 * the line. So: strip.
 *
 * ERRORS vs SUGGESTIONS
 * -------------------------------------------------------------------------
 * Two severities, and the distinction is deliberate rather than decorative.
 *
 *   error      - this is definitely wrong: brackets that don't balance, a
 *                string or comment that is never closed, an [[input:ans1]]
 *                with no [[validation:ans1]] to go with it.
 *   suggestion - STACK will accept this, but it's probably not what you
 *                meant, or the documentation recommends otherwise.
 *
 * The semicolon check is the reason this split exists. It is tempting to
 * treat a missing ";" as an error, but STACK's documentation is explicit
 * that it isn't one:
 *
 *     "Items are separated by either a newline or ;"
 *     "Adding ; at the end of each statement is optional, but makes it
 *      easier to cut and paste into a Maxima session. Please add these."
 *
 * So it's advice, and it's reported as advice. That matters practically: a
 * field with twenty missing semicolons must not bury the one unbalanced
 * bracket that is actually breaking the question, so errors always sort
 * first and suggestions can be hidden entirely from the menu.
 *
 * WHY IT SHARES A LIBRARY WITH THE HIGHLIGHTER
 * -------------------------------------------------------------------------
 * Both scripts @require lib/stack-lang.v1.js for the tokenisers. That is not
 * about saving lines - it is that the two must agree exactly on where a
 * string ends and what counts as a comment. If they drifted apart, this
 * script would report an error at a position the highlighting shows as the
 * middle of a string, and you would have no way to tell which was lying.
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[MoSES Lint]';

  if (typeof MosesStackLang === 'undefined') {
    console.error(
      LOG_PREFIX + ' the shared library did not load (@require ' +
        'lib/stack-lang.v1.js), so linting is off. In Tampermonkey, check ' +
        'the script\'s Externals tab and re-install it if the entry is missing.'
    );
    return;
  }
  const { fieldMode, hasRichEditorUi, harvestNames, tokenizeMaxima, tokenizeCastext } =
    MosesStackLang;

  // Tunable constants live up top so they're easy to find/change later.
  const ENABLED_STORAGE_KEY = 'lint_enabled';        // Tampermonkey storage
  const SHOW_SUGGESTIONS_STORAGE_KEY = 'lint_suggestions';
  const LINT_DELAY_MS = 400;   // unlike highlighting, latency here is *wanted*
  const MAX_FIELD_CHARS = 100000;
  const MAX_ROWS = 40;         // a field that's mid-paste can produce hundreds

  // STACK input names: "letters followed (optionally) by numbers, with no
  // special characters permitted, and cannot be more than 18 characters".
  const INPUT_NAME_RE = /^[A-Za-z]+[0-9]*$/;
  const MAX_INPUT_NAME_LENGTH = 18;

  /**
   * A line break between two statements only means a missing terminator if
   * neither side is obviously continuing the expression. These are the
   * tokens that say "there's more coming" / "I'm the continuation".
   */
  const CONTINUES_AFTER = new Set([
    ',', '+', '-', '*', '/', '^', '.', ':', '=', ':=', '::', '::=',
    '<', '>', '<=', '>=', '#', 'if', 'then', 'else', 'elseif', 'do', 'while',
    'for', 'thru', 'step', 'block', 'and', 'or', 'not', 'from', 'in',
  ]);
  const CONTINUES_BEFORE = new Set([
    ',', '+', '-', '*', '/', '^', '.', '=', '<', '>', '<=', '>=', '#',
    'then', 'else', 'elseif', 'do', 'step', 'thru', 'and', 'or',
  ]);

  const PROBLEM_MESSAGES = {
    'unterminated-comment': 'this /* comment is never closed, so everything after it is swallowed',
    'unterminated-string': 'this " string is never closed',
    'unterminated-html-comment': 'this <!-- comment is never closed',
    'unmatched-close': 'this closing bracket has nothing to close',
    'mismatched-bracket': 'these brackets don\'t match (a ( closed by a ], or similar)',
    'unclosed-bracket': 'this bracket is never closed',
    'unterminated-tag': 'this [[ tag is never closed with ]]',
    'empty-tag': 'this [[ ]] has no block name in it',
    'unclosed-block': 'this block is never closed',
    'stray-close': 'this closing tag has no matching opening tag',
    'unterminated-cas': 'this {@ is never closed',
    'unterminated-math': 'this LaTeX region is never closed',
  };

  // ---------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------

  function diagnostic(pos, severity, message) {
    return { pos, severity, message };
  }

  /**
   * Everything the tokenizer already discovered while scanning. Unbalanced
   * brackets, unterminated strings and unclosed blocks all come for free
   * here - the tokenizer had to work them out to colour the text correctly,
   * so re-deriving them would only be a chance to disagree with it.
   */
  function problemDiagnostics(tokens) {
    const found = [];
    for (const token of tokens) {
      if (!token.problem || !PROBLEM_MESSAGES[token.problem]) {
        continue;
      }
      // A mismatched pair marks both halves so the highlighting can redden
      // both, but reporting it twice would just be confusing. Report it at
      // the closing bracket, which is the character that's actually wrong.
      if (token.problem === 'mismatched-bracket' && '([{'.indexOf(token.ch) !== -1) {
        continue;
      }
      found.push(diagnostic(token.start, 'error', PROBLEM_MESSAGES[token.problem]));
    }
    return found;
  }

  /**
   * The missing-semicolon check.
   *
   * The naive version - "line doesn't end in ;" - is wrong in at least four
   * common ways, so this works over the token stream instead and only fires
   * when a line break separates two statements that are genuinely finished:
   *
   *   - blank lines and comment-only lines: we walk tokens, never lines, and
   *     comments are skipped without disturbing what counts as "previous"
   *   - a statement spread over several lines: `a : 1 +` continues (the +
   *     is in CONTINUES_AFTER), and so does a line starting with `+ 2`
   *   - a line ending inside an open bracket: depth > 0, never fires
   *   - `if c` / `then ...` across lines: `then` is in CONTINUES_BEFORE
   *
   * Inside block(...) or any other bracket, Maxima separates statements with
   * commas rather than semicolons, so at depth > 0 there is nothing to check.
   */
  function missingTerminators(src, tokens) {
    const found = [];
    let depth = 0;
    let previous = null;

    for (const token of tokens) {
      if (token.cls === 'comment') {
        continue; // not significant: doesn't end a statement or start one
      }
      if (token.cls === 'open') {
        depth++;
      }

      if (
        previous &&
        depth === 0 &&
        previous.cls !== 'terminator' &&
        previous.cls !== 'open' &&
        token.cls !== 'close' &&
        hasLineBreakBetween(src, previous.end, token.start) &&
        !CONTINUES_AFTER.has(previous.op || previous.word) &&
        !CONTINUES_BEFORE.has(token.op || token.word)
      ) {
        found.push(
          diagnostic(previous.end, 'suggestion', 'statement doesn\'t end with ; or $')
        );
      }

      if (token.cls === 'close') {
        depth = Math.max(0, depth - 1);
      }
      previous = token;
    }

    return found;
  }

  /**
   * A `;` inside brackets. Maxima uses commas to separate the statements in
   * block(...) and friends; a semicolon there is a syntax error rather than
   * a style question, so unlike the rule above this one is an error.
   */
  function semicolonsInsideBrackets(tokens) {
    const found = [];
    let depth = 0;
    for (const token of tokens) {
      if (token.cls === 'open') {
        depth++;
      } else if (token.cls === 'close') {
        depth = Math.max(0, depth - 1);
      } else if (token.cls === 'terminator' && token.op === ';' && depth > 0) {
        found.push(
          diagnostic(token.start, 'error', 'use , not ; to separate statements inside brackets')
        );
      }
    }
    return found;
  }

  /**
   * STACK's documentation on Feedback variables: "you cannot redefine the
   * value of an input as a key in the feedback variables. e.g. you cannot
   * have something like ans1:ans1+1. You must use a new variable name."
   */
  function inputsReassigned(assignments, inputNames) {
    const found = [];
    if (!inputNames.size) {
      return found; // no idea what the inputs are called - don't guess
    }
    for (const assignment of assignments) {
      if (inputNames.has(assignment.word)) {
        found.push(
          diagnostic(
            assignment.start,
            'error',
            '"' + assignment.word + '" is an input name; STACK does not let ' +
              'feedback variables reassign one. Use a new name.'
          )
        );
      }
    }
    return found;
  }

  function lintMaxima(src, context) {
    const { tokens, assignments } = tokenizeMaxima(src);
    const found = problemDiagnostics(tokens)
      .concat(semicolonsInsideBrackets(tokens))
      .concat(missingTerminators(src, tokens));
    if (context.isFeedbackVariables) {
      found.push(...inputsReassigned(assignments, context.inputNames));
    }
    return found;
  }

  function lintCastext(src, context) {
    const { tokens, tags, mathRanges } = tokenizeCastext(src);
    const found = problemDiagnostics(tokens);

    const inputs = new Map();      // name -> first position
    const validations = new Map();
    const duplicates = [];

    for (const tag of tags) {
      if (tag.isCloser) {
        continue;
      }

      if (!tag.known) {
        found.push(
          diagnostic(tag.verbStart, 'error', '"' + tag.verb + '" is not a STACK block name')
        );
        continue;
      }

      // Input and feedback tags must not sit inside LaTeX - STACK's docs are
      // explicit, and the failure is confusing when it happens.
      if (
        (tag.verb === 'input' || tag.verb === 'feedback' || tag.verb === 'validation') &&
        mathRanges.some((range) => tag.start >= range.start && tag.end <= range.end)
      ) {
        found.push(
          diagnostic(
            tag.start,
            'error',
            '[[' + tag.verb + ':...]] must not be inside a LaTeX region'
          )
        );
      }

      if (tag.verb === 'input' || tag.verb === 'validation') {
        if (!tag.name) {
          found.push(
            diagnostic(tag.start, 'error', '[[' + tag.verb + ':...]] needs a name, e.g. ans1')
          );
          continue;
        }
        if (!INPUT_NAME_RE.test(tag.name) || tag.name.length > MAX_INPUT_NAME_LENGTH) {
          found.push(
            diagnostic(
              tag.nameStart,
              'error',
              '"' + tag.name + '" is not a valid input name - letters then ' +
                'optional digits, at most ' + MAX_INPUT_NAME_LENGTH + ' characters'
            )
          );
        }
        const seen = tag.verb === 'input' ? inputs : validations;
        if (seen.has(tag.name)) {
          duplicates.push(
            diagnostic(
              tag.start,
              'error',
              '[[' + tag.verb + ':' + tag.name + ']] appears more than once'
            )
          );
        } else {
          seen.set(tag.name, tag.start);
        }
      }

      if (tag.verb === 'feedback' && tag.name && context.prtNames.size &&
          !context.prtNames.has(tag.name)) {
        found.push(
          diagnostic(
            tag.nameStart,
            'suggestion',
            'there is no potential response tree called "' + tag.name + '" on this form'
          )
        );
      }
    }

    found.push(...duplicates);

    // "You will also be required to place a corresponding tag to indicate
    // the position of any validation feedback ... The validation tag must be
    // included even if validation is suppressed with an option."
    for (const [name, pos] of inputs) {
      if (!validations.has(name)) {
        found.push(
          diagnostic(pos, 'error', '[[input:' + name + ']] has no [[validation:' + name + ']]')
        );
      }
    }
    for (const [name, pos] of validations) {
      if (!inputs.has(name)) {
        found.push(
          diagnostic(pos, 'error', '[[validation:' + name + ']] has no [[input:' + name + ']]')
        );
      }
    }

    return found;
  }

  // ---------------------------------------------------------------------
  // Positions
  // ---------------------------------------------------------------------

  /**
   * Whether a line break separates two tokens. Deliberately not "which line
   * is each token on": the tokens are walked in order and the gaps between
   * them don't overlap, so this costs one pass over the field in total,
   * whereas counting newlines from the start for each token would be
   * quadratic - which on a 300-line field is the difference between 2ms and
   * 35ms per keystroke.
   */
  function hasLineBreakBetween(src, from, to) {
    for (let i = from; i < to; i++) {
      if (src[i] === '\n') {
        return true;
      }
    }
    return false;
  }

  /**
   * One pass turning character offsets into 1-based line/column, rather than
   * lineOf() per diagnostic - which would be quadratic on a long field.
   */
  function addLineNumbers(src, diagnostics) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n') {
        starts.push(i + 1);
      }
    }
    for (const item of diagnostics) {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= item.pos) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      item.line = low + 1;
      item.column = item.pos - starts[low] + 1;
      item.lineStart = starts[low];
      item.lineEnd = low + 1 < starts.length ? starts[low + 1] - 1 : src.length;
    }
    return diagnostics;
  }

  function sortDiagnostics(diagnostics) {
    return diagnostics.sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity === 'error' ? -1 : 1; // never bury an error under advice
      }
      return a.pos - b.pos;
    });
  }

  // ---------------------------------------------------------------------
  // The strip
  // ---------------------------------------------------------------------

  const STRIP_CSS = [
    ':host { display: block; }',
    '.strip { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    '  margin: 2px 0 8px; border-left: 3px solid #d73a49; padding: 2px 0 2px 8px; }',
    '.strip.only-suggestions { border-left-color: #b08800; }',
    '.row { display: block; width: 100%; text-align: left; background: none;',
    '  border: 0; padding: 1px 0; cursor: pointer; color: inherit; font: inherit; }',
    '.row:hover { text-decoration: underline; }',
    '.where { color: #6a737d; margin-right: 6px; }',
    '.error .what { color: #b31d28; }',
    '.suggestion .what { color: #7a5b00; }',
    '.more { color: #6a737d; padding: 1px 0; }',
    '@media (prefers-color-scheme: dark) {',
    '  .where, .more { color: #9aa4ae; }',
    '  .error .what { color: #f8837c; }',
    '  .suggestion .what { color: #e2c15d; }',
    '}',
  ].join('\n');

  function createStrip(textarea) {
    const host = document.createElement('div');
    host.setAttribute('data-moses-lint', '');
    const root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STRIP_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (err) {
      const style = document.createElement('style');
      style.textContent = STRIP_CSS;
      root.appendChild(style);
    }
    const strip = document.createElement('div');
    strip.className = 'strip';
    root.appendChild(strip);
    // After the textarea, so nothing about the field itself moves. It's a
    // <div>, not a form control, so the form serialises nothing extra.
    textarea.insertAdjacentElement('afterend', host);
    return { host, strip };
  }

  function jumpTo(textarea, item) {
    textarea.focus();
    textarea.setSelectionRange(item.lineStart, item.lineEnd);
    // Rough but effective: scroll so the target line sits near the middle.
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 16;
    textarea.scrollTop = Math.max(0, (item.line - 1) * lineHeight - textarea.clientHeight / 2);
  }

  function renderStrip(state, diagnostics) {
    const { strip, textarea } = state;
    const showSuggestions = GM_getValue(SHOW_SUGGESTIONS_STORAGE_KEY, true);
    const visible = showSuggestions
      ? diagnostics
      : diagnostics.filter((item) => item.severity === 'error');

    if (!visible.length) {
      state.host.style.display = 'none';
      strip.textContent = '';
      return;
    }

    state.host.style.display = '';
    strip.classList.toggle(
      'only-suggestions',
      !visible.some((item) => item.severity === 'error')
    );
    strip.textContent = '';

    for (const item of visible.slice(0, MAX_ROWS)) {
      const row = document.createElement('button');
      row.type = 'button';   // a bare <button> inside a form would SUBMIT it
      row.className = 'row ' + item.severity;

      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = 'Line ' + item.line;
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = item.message;

      row.appendChild(where);
      row.appendChild(what);
      row.addEventListener('click', () => jumpTo(textarea, item));
      strip.appendChild(row);
    }

    if (visible.length > MAX_ROWS) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = '... and ' + (visible.length - MAX_ROWS) + ' more';
      strip.appendChild(more);
    }
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  const watched = new WeakSet();
  const liveStates = new Set();

  function runLint(state) {
    const src = state.textarea.value;
    if (src.length > MAX_FIELD_CHARS) {
      return;
    }
    const { inputNames, prtNames } = harvestNames();
    const key = (state.textarea.id + ' ' + state.textarea.name).toLowerCase();
    const context = {
      inputNames,
      prtNames,
      isFeedbackVariables: key.includes('feedbackvariables'),
    };

    let diagnostics;
    try {
      diagnostics =
        state.mode === 'maxima' ? lintMaxima(src, context) : lintCastext(src, context);
    } catch (err) {
      console.warn(LOG_PREFIX + ' rule crashed on "' + fieldLabel(state.textarea) + '"', err);
      return;
    }

    sortDiagnostics(addLineNumbers(src, diagnostics));
    renderStrip(state, diagnostics);
  }

  function scheduleLint(state) {
    clearTimeout(state.timer);
    // Deliberately slow: an error popping up mid-word while you're still
    // typing it is worse than useless.
    state.timer = setTimeout(() => runLint(state), LINT_DELAY_MS);
  }

  function fieldLabel(textarea) {
    return textarea.id || textarea.name || '<unnamed textarea>';
  }

  function watch(textarea) {
    if (!textarea || textarea.tagName !== 'TEXTAREA' || watched.has(textarea)) {
      return;
    }
    if (hasRichEditorUi(textarea) || textarea.offsetParent === null) {
      return; // hidden behind a WYSIWYG editor, or in a collapsed section
    }
    watched.add(textarea);

    const { host, strip } = createStrip(textarea);
    const state = { textarea, host, strip, mode: fieldMode(textarea), timer: 0 };
    const onInput = () => scheduleLint(state);
    textarea.addEventListener('input', onInput);
    state.detach = () => {
      clearTimeout(state.timer);
      textarea.removeEventListener('input', onInput);
      host.remove();
      watched.delete(textarea);
      liveStates.delete(state);
    };
    liveStates.add(state);
    runLint(state);
  }

  function scanNow() {
    document.querySelectorAll('textarea').forEach(watch);
  }

  function teardownAll() {
    for (const state of Array.from(liveStates)) {
      state.detach();
    }
  }

  function relintAll() {
    for (const state of liveStates) {
      runLint(state);
    }
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Toggle STACK lint', () => {
      const nowEnabled = !GM_getValue(ENABLED_STORAGE_KEY, true);
      GM_setValue(ENABLED_STORAGE_KEY, nowEnabled);
      teardownAll();
      if (nowEnabled) {
        scanNow();
      }
      console.info(LOG_PREFIX + ' linting ' + (nowEnabled ? 'enabled' : 'disabled'));
    });

    GM_registerMenuCommand('Toggle lint suggestions (semicolons etc.)', () => {
      const nowShown = !GM_getValue(SHOW_SUGGESTIONS_STORAGE_KEY, true);
      GM_setValue(SHOW_SUGGESTIONS_STORAGE_KEY, nowShown);
      relintAll();
      console.info(LOG_PREFIX + ' suggestions ' + (nowShown ? 'shown' : 'hidden'));
    });
  }

  if (GM_getValue(ENABLED_STORAGE_KEY, true)) {
    scanNow();
  }

  // Same reasoning as the highlighter: a field inside a collapsed "Potential
  // response tree" section isn't laid out yet, and you can't edit one without
  // focusing it first, so this catches every field that ever matters -
  // including ones added later by an "Add another PRT" button.
  document.addEventListener('focusin', (event) => {
    if (GM_getValue(ENABLED_STORAGE_KEY, true)) {
      watch(event.target);
    }
  });

  // A [[input:ansN]] typed in the question text changes what the *feedback
  // variables* fields should be linted against, so a change in one field can
  // invalidate another's results. Re-running every field on a 400ms debounce
  // is cheap enough not to need anything cleverer.
  let crossFieldTimer = 0;
  document.addEventListener('input', (event) => {
    if (!event.target || event.target.tagName !== 'TEXTAREA') {
      return;
    }
    clearTimeout(crossFieldTimer);
    crossFieldTimer = setTimeout(() => {
      for (const state of liveStates) {
        if (state.textarea !== event.target) {
          runLint(state);
        }
      }
    }, LINT_DELAY_MS * 2);
  });
})();
