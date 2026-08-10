// ==UserScript==
// @name         MoSES: STACK autocomplete
// @namespace    https://github.com/casparschucan/MoSES
// @version      0.1.0
// @description  Completion for STACK question editing: [[ offers the block names and this question's actual ansN/prtN names, {@ ... @} and the Maxima fields offer the variables you've defined and common Maxima functions.
// @author       Caspar Schucan
// @match        https://moodle-app2.let.ethz.ch/question/bank/editquestion/question.php*
// @match        https://moodle-app6.let.ethz.ch/question/bank/editquestion/question.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @require      https://raw.githubusercontent.com/casparschucan/MoSES/main/lib/stack-lang.v1.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/casparschucan/MoSES/main/stack-autocomplete.user.js
// @downloadURL  https://raw.githubusercontent.com/casparschucan/MoSES/main/stack-autocomplete.user.js
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * A completion popup at the caret, in three situations:
 *
 *   [[            in Question text / feedback. The contents of [[ ]] are a
 *                 tiny, closed vocabulary - a block name, optionally with an
 *                 input or PRT name after a colon - so the list can be
 *                 exactly right rather than a guess.
 *   {@ ... @}     inline CAS in those same fields: offers the variables you
 *                 actually defined in Question variables. This is the one
 *                 that feels most like an IDE, because it knows about a
 *                 different field than the one you're typing in.
 *   Maxima fields the names assigned earlier in the field, plus the common
 *                 Maxima/STACK functions.
 *
 * Arrow keys move, Enter or Tab accepts, Escape dismisses. Ctrl+Space opens
 * it on demand. It only ever appears when there is something to say.
 *
 * A NOTE ON TYPING "[["
 * -------------------------------------------------------------------------
 * auto-brackets.user.js turns a typed "[" into "[]", so typing "[" twice
 * gives you "[[|]]" with the caret already in the middle - exactly where
 * this wants to trigger. That is a happy accident rather than a design, but
 * it does make "[[" the natural gesture, and accepting a completion notices
 * the "]]" is already there instead of adding a second pair.
 *
 * WHERE THE NAMES COME FROM
 * -------------------------------------------------------------------------
 * Not from a hardcoded list: from the question you're editing. Input names
 * are read out of the [[input:...]] tags you've already written, PRT names
 * from the per-PRT Feedback variables fields, and CAS variables by running
 * the same tokenizer that colours them. That is shared with the linter via
 * the @require'd library, deliberately - if this offered "prt9" while the
 * linter flagged [[feedback:prt9]] as unknown, neither could be trusted.
 *
 * KEYBOARD, AND NOT FIGHTING THE OTHER SCRIPTS
 * -------------------------------------------------------------------------
 * Three other MoSES scripts already listen for keydown on document in the
 * capture phase, and the order userscripts run in is not guaranteed - so
 * this relies on the key sets being disjoint rather than on ordering:
 *
 *   keyboard-shortcuts   Ctrl+S / Ctrl+P / Ctrl+Enter  (needs ctrlKey)
 *   auto-brackets        ( [ { " ' ) ] } Backspace     (bails on modifiers)
 *   auto-close-html-tags >                             (bails on modifiers)
 *   this script          arrows / Enter / Tab / Escape, ONLY while the
 *                        popup is open, and never with a modifier held
 *
 * So Ctrl+Enter still saves even with the popup open. The handler returns
 * immediately when the popup is closed, so it costs nothing the rest of the
 * time, and it uses stopPropagation but never stopImmediatePropagation -
 * which would kill the other scripts' listeners in an order-dependent way.
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[MoSES Autocomplete]';

  if (typeof MosesStackLang === 'undefined') {
    console.error(
      LOG_PREFIX + ' the shared library did not load (@require ' +
        'lib/stack-lang.v1.js), so completion is off. In Tampermonkey, check ' +
        'the script\'s Externals tab and re-install it if the entry is missing.'
    );
    return;
  }
  const {
    BUILTINS,
    KEYWORDS,
    STACK_VERBS,
    STACK_BLOCK_VERBS,
    fieldMode,
    hasRichEditorUi,
    harvestNames,
    tokenizeMaxima,
  } = MosesStackLang;

  // Tunable constants live up top so they're easy to find/change later.
  const ENABLED_STORAGE_KEY = 'ac_enabled';
  const SCAN_BACK = 200;        // how far behind the caret to look for a "[["
  const MIN_WORD_CHARS = 2;     // don't pop up on a single letter, unless asked
  const MAX_ROWS = 12;
  const NAMES_TTL_MS = 2000;    // re-harvest at most this often

  // Blocks worth offering, in the order they're worth offering them. This is
  // deliberately shorter than the full list the tokenizer recognises: the
  // point is the handful you actually reach for, not completeness.
  const OFFERED_BLOCKS = [
    'comment', 'if', 'foreach', 'define', 'reveal', 'hint', 'jsxgraph',
    'todo', 'debug', 'lang', 'format', 'adapt', 'parsons', 'geogebra',
    'javascript', 'include', 'template',
  ];

  // Blocks where something obviously wants filling in once inserted.
  // `caretBack` counts characters of the *body* that follow the caret, so
  // `if test=""` is 1: the caret goes between the quotes. Kept to the two
  // blocks whose skeleton is unambiguous rather than guessing at the rest.
  const BLOCK_TEMPLATES = {
    if: { body: 'if test=""', caretBack: 1 },
    foreach: { body: 'foreach x=""', caretBack: 1 },
  };

  const CAS_OPENERS = ['{@', '{#'];
  const CAS_CLOSERS = ['@}', '#}'];
  const IDENT_TAIL_RE = /[A-Za-z_%][A-Za-z0-9_%]*$/;

  /**
   * Every computed style that has to match for a measurement mirror to break
   * lines where the textarea does. Same list as the highlighter's, and
   * duplicated on purpose: there it drives a live overlay, here a one-shot
   * measurement, and the two have no reason to change together.
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

  // ---------------------------------------------------------------------
  // Editing, the same way the rest of the repo does it
  // ---------------------------------------------------------------------

  /**
   * Copied verbatim from auto-brackets.user.js. execCommand is deprecated but
   * it is still the only way to change a textarea's value while keeping the
   * browser's native undo stack intact and firing a real input event, which
   * Moodle's own form-dirty tracking depends on. Setting .value directly
   * would make Ctrl+Z lose the edit.
   */
  function insertTextPreservingUndo(textarea, text) {
    textarea.focus();
    if (document.queryCommandSupported && document.queryCommandSupported('insertText')) {
      document.execCommand('insertText', false, text);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ---------------------------------------------------------------------
  // Where is the caret, and what does it want?
  // ---------------------------------------------------------------------

  function lastIndexOfAny(text, needles) {
    let best = -1;
    for (const needle of needles) {
      best = Math.max(best, text.lastIndexOf(needle));
    }
    return best;
  }

  /**
   * What, if anything, should be completed at the caret. Returns the region
   * of text to replace along with the kind of thing that belongs there, or
   * null when the caret isn't anywhere interesting.
   *
   * Only ever looks at the SCAN_BACK characters before the caret, so this is
   * constant work per keystroke however long the field is.
   */
  function completionContext(textarea, force) {
    if (textarea.selectionStart !== textarea.selectionEnd) {
      return null; // completing over a selection would be a surprise
    }
    const caret = textarea.selectionStart;
    const value = textarea.value;
    const from = Math.max(0, caret - SCAN_BACK);
    const before = value.slice(from, caret);
    const mode = fieldMode(textarea);

    if (mode === 'castext') {
      const open = before.lastIndexOf('[[');
      if (open !== -1 && open > before.lastIndexOf(']]')) {
        const prefix = before.slice(open + 2);
        if (!/[\]\n]/.test(prefix)) {
          return { kind: 'tag', start: from + open + 2, prefix, caret };
        }
      }

      const casOpen = lastIndexOfAny(before, CAS_OPENERS);
      if (casOpen !== -1 && casOpen > lastIndexOfAny(before, CAS_CLOSERS)) {
        return identifierContext(before, caret, 'cas', force);
      }
      return null;
    }

    return identifierContext(before, caret, 'maxima', force);
  }

  function identifierContext(before, caret, kind, force) {
    const match = IDENT_TAIL_RE.exec(before);
    const word = match ? match[0] : '';
    if (!force && word.length < MIN_WORD_CHARS) {
      return null;
    }
    return { kind, start: caret - word.length, prefix: word, caret };
  }

  /**
   * When the caret sits inside an existing [[...]], the completion should
   * replace the whole of its contents rather than append to them - otherwise
   * fixing "[[inut:ans1]]" would give you "[[input:ans1ut:ans1]]". Finds the
   * closing "]]" if there is one on this line.
   */
  function tagRegionEnd(value, caret) {
    const rest = value.slice(caret, Math.min(value.length, caret + SCAN_BACK));
    const close = rest.indexOf(']]');
    const newline = rest.indexOf('\n');
    if (close !== -1 && (newline === -1 || close < newline)) {
      return caret + close + 2;
    }
    return caret;
  }

  // ---------------------------------------------------------------------
  // What to offer
  // ---------------------------------------------------------------------

  let cachedNames = null;
  let cachedAt = 0;

  function names() {
    const now = Date.now();
    if (!cachedNames || now - cachedAt > NAMES_TTL_MS) {
      cachedNames = harvestNames();
      cachedAt = now;
    }
    return cachedNames;
  }

  function nextFreeInputName(inputNames) {
    let highest = 0;
    for (const name of inputNames) {
      const match = /^ans(\d+)$/.exec(name);
      if (match) {
        highest = Math.max(highest, parseInt(match[1], 10));
      }
    }
    return 'ans' + (highest + 1);
  }

  /**
   * An item is `{ label, body, tail, caretBack, detail }`:
   *   body      goes between the [[ and the ]]
   *   tail      goes after the ]], for blocks that need closing
   *   caretBack how far back from the end of everything inserted the caret
   *             should land, so [[if test="|"]] puts you inside the quotes
   */
  function tagCandidates(prefix, textarea) {
    const { inputNames, prtNames } = names();
    const value = textarea.value;
    const items = [];
    const colon = prefix.indexOf(':');

    if (colon !== -1) {
      // The verb is already typed - only its name is being completed, so the
      // list can be exactly the set of legal answers.
      const verb = prefix.slice(0, colon).trim();
      const namePrefix = prefix.slice(colon + 1).trim();
      let pool = [];
      if (verb === 'input') {
        // The existing names, plus the next unused one - so this works both
        // for correcting an existing tag and for adding a new input.
        pool = [...inputNames, nextFreeInputName(inputNames)];
      } else if (verb === 'validation') {
        // A validation tag is only ever legal for an input that exists.
        pool = [...inputNames];
      } else if (verb === 'feedback') {
        pool = [...prtNames];
      } else {
        return [];
      }
      for (const name of new Set(pool)) {
        items.push(makeTagItem(verb, name, value));
      }
      return rank(items, namePrefix);
    }

    // Completing the verb itself. Offer the fully-formed tags first, since
    // those are what you almost always want, then the bare block names.
    for (const name of inputNames) {
      if (!hasTag(value, 'validation', name)) {
        // Nudge towards the pairing STACK requires and the linter checks.
        items.push(makeTagItem('validation', name, value));
      }
    }
    for (const name of inputNames) {
      items.push(makeTagItem('input', name, value));
    }
    if (!inputNames.size) {
      items.push(makeTagItem('input', nextFreeInputName(inputNames), value));
    }
    for (const name of prtNames) {
      items.push(makeTagItem('feedback', name, value));
    }
    for (const block of OFFERED_BLOCKS) {
      items.push(makeBlockItem(block));
    }
    return rank(items, prefix);
  }

  function hasTag(value, verb, name) {
    return new RegExp('\\[\\[\\s*' + verb + '\\s*:\\s*' + name + '\\s*\\]\\]').test(value);
  }

  function makeTagItem(verb, name, value) {
    const body = verb + ':' + name;
    const item = { label: body, body, tail: '', caretBack: 0, detail: '' };
    // An input tag without its validation tag is an error STACK will
    // complain about, so offer them together unless one is already present.
    if (verb === 'input' && !hasTag(value, 'validation', name)) {
      item.tail = ' [[validation:' + name + ']]';
      item.detail = '+ validation tag';
    }
    return item;
  }

  function makeBlockItem(block) {
    const template = BLOCK_TEMPLATES[block];
    const body = template ? template.body : block;
    const needsClose = STACK_BLOCK_VERBS.has(block);
    const tail = needsClose ? '[[/' + block + ']]' : '';
    // Everything inserted is `body + ']]' + tail`. With no template the
    // caret belongs between the two tags, i.e. just past the ']]'; with one
    // it belongs inside the placeholder, which is further back still by the
    // ']]' plus whatever part of the body follows it.
    const caretBack = template ? tail.length + 2 + template.caretBack : tail.length;
    return {
      label: block,
      body,
      tail,
      caretBack,
      detail: needsClose ? 'block' : '',
    };
  }

  function identifierCandidates(textarea, kind) {
    const { variableNames } = names();
    const items = [];
    const seen = new Set();

    // Names assigned in this very field come first - they're the ones you're
    // most likely reaching for - then everything defined anywhere else.
    if (kind === 'maxima') {
      for (const word of tokenizeMaxima(textarea.value).assigned) {
        if (!seen.has(word)) {
          seen.add(word);
          items.push({ label: word, body: word, detail: 'this field' });
        }
      }
    }
    for (const word of variableNames) {
      if (!seen.has(word)) {
        seen.add(word);
        items.push({ label: word, body: word, detail: 'question variables' });
      }
    }
    if (kind === 'maxima') {
      for (const word of KEYWORDS) {
        items.push({ label: word, body: word, detail: 'keyword' });
      }
    }
    for (const word of BUILTINS) {
      items.push({ label: word, body: word, detail: 'Maxima' });
    }
    return items;
  }

  /**
   * Prefix matches beat substring matches; within a group, shorter labels
   * come first, and ties keep the order the builder produced. Nothing
   * cleverer - a fuzzy matcher would mostly be a way of putting the wrong
   * thing at the top.
   *
   * With no prefix typed there is nothing to score, so the builder's order
   * is used verbatim. That matters: for a bare "[[" the builder deliberately
   * leads with the validation tag that's missing, and sorting by length
   * would bury it under short block names like "if" and "todo".
   */
  function rank(items, prefix) {
    const needle = prefix.toLowerCase();
    if (!needle) {
      return items.slice();
    }
    const scored = [];
    items.forEach((item, index) => {
      const label = item.label.toLowerCase();
      if (label.startsWith(needle)) {
        scored.push({ item, index, score: 0 });
      } else if (label.indexOf(needle) !== -1) {
        scored.push({ item, index, score: 1 });
      }
    });
    scored.sort(
      (a, b) =>
        a.score - b.score ||
        a.item.label.length - b.item.label.length ||
        a.index - b.index
    );
    return scored.map((entry) => entry.item);
  }

  function candidatesFor(context, textarea) {
    if (context.kind === 'tag') {
      return tagCandidates(context.prefix, textarea);
    }
    const items = rank(identifierCandidates(textarea, context.kind), context.prefix);
    // Don't offer a one-item list whose only entry is what's already typed.
    if (items.length === 1 && items[0].label === context.prefix) {
      return [];
    }
    return items;
  }

  // ---------------------------------------------------------------------
  // Where to put the popup
  // ---------------------------------------------------------------------

  /**
   * There is no API for "where is the caret on screen" in a textarea, so
   * build a throwaway element that lays the text out the same way, put a
   * marker where the caret is, and read the marker's position.
   *
   * Deliberately built and thrown away per popup rather than kept around:
   * this runs at human speed (once when the popup opens, once per keystroke
   * while it's open), so a fraction of a millisecond is free, and it avoids
   * this script depending on syntax-highlight.user.js's persistent mirror -
   * which would break the moment that script is disabled.
   */
  function caretPoint(textarea) {
    const cs = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    for (const prop of MIRRORED_PROPS) {
      mirror.style[prop] = cs[prop];
    }
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.left = '-9999px';
    mirror.style.top = '0';
    mirror.style.boxSizing = 'border-box';
    mirror.style.width = textarea.clientWidth + 'px';
    mirror.textContent = textarea.value.slice(0, textarea.selectionStart);

    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const offsetTop = marker.offsetTop;
    const offsetLeft = marker.offsetLeft;
    document.body.removeChild(mirror);

    const rect = textarea.getBoundingClientRect();
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
    const x = rect.left + offsetLeft - textarea.scrollLeft;
    const y = rect.top + offsetTop - textarea.scrollTop;

    // If the measurement lands somewhere impossible, fall back to the bottom
    // left of the field rather than putting the popup in the wrong place.
    if (x < rect.left - 8 || x > rect.right + 8 || y < rect.top - 8 || y > rect.bottom + 8) {
      return { x: rect.left, y: rect.bottom - lineHeight, lineHeight };
    }
    return { x, y, lineHeight };
  }

  // ---------------------------------------------------------------------
  // The popup
  // ---------------------------------------------------------------------

  const POPUP_CSS = [
    ':host { position: fixed; z-index: 2147483000; }',
    '.list { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    '  background: #fff; color: #24292e; border: 1px solid #c8ccd0; border-radius: 4px;',
    '  box-shadow: 0 4px 14px rgba(0,0,0,0.18); overflow-y: auto; max-height: 15em;',
    '  min-width: 14em; padding: 2px 0; }',
    '.row { display: flex; justify-content: space-between; gap: 1.5em;',
    '  padding: 1px 8px; cursor: pointer; white-space: nowrap; }',
    '.row.on { background: #0366d6; color: #fff; }',
    '.detail { opacity: 0.65; font-size: 0.85em; }',
    '.hint { padding: 2px 8px; border-top: 1px solid #e1e4e8; opacity: 0.6; font-size: 0.85em; }',
    '@media (prefers-color-scheme: dark) {',
    '  .list { background: #22262a; color: #d4d4d4; border-color: #3a4046; }',
    '  .hint { border-top-color: #3a4046; }',
    '}',
  ].join('\n');

  let popupHost = null;
  let popupList = null;

  function ensurePopup() {
    if (popupHost) {
      return;
    }
    popupHost = document.createElement('div');
    popupHost.setAttribute('data-moses-autocomplete', '');
    popupHost.style.display = 'none';
    const root = popupHost.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(POPUP_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (err) {
      const style = document.createElement('style');
      style.textContent = POPUP_CSS;
      root.appendChild(style);
    }
    popupList = document.createElement('div');
    popupList.className = 'list';
    root.appendChild(popupList);
    document.body.appendChild(popupHost);
  }

  const session = { open: false, textarea: null, context: null, items: [], index: 0 };

  function closePopup() {
    session.open = false;
    session.textarea = null;
    session.context = null;
    session.items = [];
    if (popupHost) {
      popupHost.style.display = 'none';
    }
  }

  function paintSelection() {
    const rows = popupList.querySelectorAll('.row');
    rows.forEach((row, n) => row.classList.toggle('on', n === session.index));
    const current = rows[session.index];
    if (current && current.scrollIntoView) {
      current.scrollIntoView({ block: 'nearest' });
    }
  }

  function openPopup(textarea, context, items) {
    ensurePopup();
    session.open = true;
    session.textarea = textarea;
    session.context = context;
    session.items = items.slice(0, MAX_ROWS);
    session.index = 0;

    popupList.textContent = '';
    session.items.forEach((item, n) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = item.label;
      row.appendChild(label);
      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      // mousedown, not click: click would come after the textarea had already
      // lost focus. preventDefault keeps the caret where it is.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        session.index = n;
        accept();
      });
      popupList.appendChild(row);
    });

    if (items.length > MAX_ROWS) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '+' + (items.length - MAX_ROWS) + ' more - keep typing';
      popupList.appendChild(hint);
    }

    const point = caretPoint(textarea);
    popupHost.style.display = '';
    popupHost.style.left = Math.round(point.x) + 'px';
    popupHost.style.top = Math.round(point.y + point.lineHeight) + 'px';
    popupHost.style.visibility = 'hidden';

    // Measure, then flip above the caret if it would hang off the bottom.
    const height = popupList.offsetHeight;
    if (point.y + point.lineHeight + height > window.innerHeight - 4) {
      popupHost.style.top = Math.round(Math.max(4, point.y - height)) + 'px';
    }
    const width = popupList.offsetWidth;
    if (point.x + width > window.innerWidth - 4) {
      popupHost.style.left = Math.round(Math.max(4, window.innerWidth - width - 4)) + 'px';
    }
    popupHost.style.visibility = '';
    paintSelection();
  }

  // ---------------------------------------------------------------------
  // Accepting
  // ---------------------------------------------------------------------

  function accept() {
    const { textarea, context, items, index } = session;
    const item = items[index];
    if (!textarea || !item) {
      closePopup();
      return;
    }

    if (context.kind === 'tag') {
      // Replace the tag's whole contents, including its ]] if it has one, so
      // that completing inside an existing tag rewrites rather than appends.
      const end = tagRegionEnd(textarea.value, textarea.selectionStart);
      textarea.setSelectionRange(context.start, end);
      const inserted = item.body + ']]' + (item.tail || '');
      insertTextPreservingUndo(textarea, inserted);
      const caret = context.start + inserted.length - (item.caretBack || 0);
      textarea.setSelectionRange(caret, caret);
    } else {
      textarea.setSelectionRange(context.start, textarea.selectionStart);
      insertTextPreservingUndo(textarea, item.body);
    }

    closePopup();
    // A new [[input:ansN]] changes what should be offered next time.
    cachedNames = null;
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  function eligible(textarea) {
    return Boolean(
      textarea &&
      textarea.tagName === 'TEXTAREA' &&
      textarea.offsetParent !== null &&
      !hasRichEditorUi(textarea)
    );
  }

  function refresh(textarea, force) {
    if (!GM_getValue(ENABLED_STORAGE_KEY, true) || !eligible(textarea)) {
      closePopup();
      return;
    }
    let context;
    let items;
    try {
      context = completionContext(textarea, force);
      items = context ? candidatesFor(context, textarea) : [];
    } catch (err) {
      console.warn(LOG_PREFIX + ' failed while building completions', err);
      closePopup();
      return;
    }
    if (!context || !items.length) {
      closePopup();
      return;
    }
    openPopup(textarea, context, items);
  }

  document.addEventListener('input', (event) => {
    if (event.target && event.target.tagName === 'TEXTAREA') {
      refresh(event.target, false);
    }
  });

  // Moving the caret with the mouse or arrows can leave or enter a [[ ]], so
  // the popup has to re-evaluate - but only when it's already open, or after
  // a click, to avoid popping up while someone is just reading.
  document.addEventListener('click', (event) => {
    if (session.open && event.target !== session.textarea) {
      closePopup();
    }
  });

  document.addEventListener('blur', () => closePopup(), true);
  window.addEventListener('resize', () => closePopup());
  window.addEventListener('scroll', () => closePopup(), true);

  document.addEventListener(
    'keydown',
    (event) => {
      // Ctrl+Space asks for the popup explicitly, which is the one case where
      // a modifier is ours. Nothing else in the repo claims it.
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === ' ') {
        const textarea = document.activeElement;
        if (eligible(textarea)) {
          event.preventDefault();
          event.stopPropagation();
          refresh(textarea, true);
        }
        return;
      }

      if (!session.open) {
        return; // costs nothing when the popup isn't up
      }
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return; // Ctrl+Enter must still save
      }
      if (event.isComposing || event.keyCode === 229) {
        return; // mid-IME, Enter belongs to the input method
      }

      const count = session.items.length;
      switch (event.key) {
        case 'ArrowDown':
          session.index = (session.index + 1) % count;
          paintSelection();
          break;
        case 'ArrowUp':
          session.index = (session.index - 1 + count) % count;
          paintSelection();
          break;
        case 'Enter':
        case 'Tab':
          accept();
          break;
        case 'Escape':
          closePopup();
          break;
        default:
          return; // everything else is none of our business
      }

      event.preventDefault();
      // stopPropagation, never stopImmediatePropagation: the latter would
      // silence the other MoSES scripts' listeners on this same node, in an
      // order that isn't guaranteed and would be miserable to debug.
      event.stopPropagation();
    },
    true
  );

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Toggle STACK autocomplete', () => {
      const nowEnabled = !GM_getValue(ENABLED_STORAGE_KEY, true);
      GM_setValue(ENABLED_STORAGE_KEY, nowEnabled);
      closePopup();
      console.info(LOG_PREFIX + ' completion ' + (nowEnabled ? 'enabled' : 'disabled'));
    });

    GM_registerMenuCommand('Report MoSES autocomplete candidates', () => {
      cachedNames = null;
      const { inputNames, prtNames, variableNames } = names();
      console.info(LOG_PREFIX + ' names harvested from this question:', {
        inputs: [...inputNames],
        prts: [...prtNames],
        variables: [...variableNames],
      });
      if (!inputNames.size && !prtNames.size) {
        console.warn(
          LOG_PREFIX + ' no input or PRT names found. Input names are read ' +
            'from the [[input:...]] tags in the question text, PRT names from ' +
            'textareas whose name ends "feedbackvariables". If this question ' +
            'has both and neither was found, please report the real id/name ' +
            'of those fields.'
        );
      }
    });
  }
})();
