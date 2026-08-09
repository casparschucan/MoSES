// ==UserScript==
// @name         MoSES: Auto-close HTML tags
// @namespace    https://github.com/casparschucan/MoSES
// @version      0.1.1
// @description  Typing the closing > of an opening HTML tag (e.g. <div>) in Question text / feedback fields auto-inserts the matching closing tag and places the caret between them.
// @author       Caspar Schucan
// @match        https://moodle-app2.let.ethz.ch/question/bank/editquestion/question.php*
// @match        https://moodle-app6.let.ethz.ch/question/bank/editquestion/question.php*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/casparschucan/MoSES/main/auto-close-html-tags.user.js
// @downloadURL  https://raw.githubusercontent.com/casparschucan/MoSES/main/auto-close-html-tags.user.js
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * Finishing an opening HTML tag by typing '>' - e.g. typing the '>' in
 * "<div>" - auto-inserts the matching "</div>" right after the caret, same
 * as most HTML/JSX-aware editors. Void elements (br, img, hr, ...) and
 * already self-closing tags ("<br/>") are left alone since they have no
 * closing tag. Closing tags you type yourself ("</div>") are also left
 * alone, since the pattern only matches opening tags.
 *
 * Known limitation, deliberately not solved: if you finish typing the
 * closing tag yourself after this already inserted one for you, you'll end
 * up with a duplicate. Same trade-off most editors with this feature make;
 * not worth the extra complexity of detecting/merging that here.
 *
 * WHY THIS ONLY APPLIES TO SOME FIELDS
 * ---------------------------------------------------------------------------
 * '<' and '>' are comparison operators in the Maxima code that goes in the
 * Question variables / Feedback variables fields (e.g. "a<b", "x>=0"), not
 * markup - auto-closing there would misfire constantly. There's no existing
 * classification in this codebase for "HTML content field" vs "Maxima code
 * field" (moodle-stack-helper.user.js's findAllTextTextareas() treats every
 * textarea the same), so isHtmlContentField() below uses a heuristic: any
 * textarea whose id/name does NOT contain "variables" is treated as an HTML
 * field. This relies on the one confirmed naming convention in this repo -
 * the Question variables field is `id_questionvariables` - and assumes
 * Feedback variables fields follow the same "...variables" pattern. If a
 * Maxima field is ever missed by this heuristic (auto-close firing where it
 * shouldn't), check that field's real id/name in devtools and tighten the
 * pattern here.
 *
 * WHY execCommand INSTEAD OF SETTING .value DIRECTLY
 * ---------------------------------------------------------------------------
 * See the equivalent comment in auto-brackets.user.js - it preserves the
 * browser's native undo/redo stack and fires a real 'input' event that
 * Moodle's own form-dirty tracking relies on.
 */

(function () {
  'use strict';

  const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'source', 'track', 'wbr',
  ]);
  const OPEN_TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?(\/?)>$/;

  function isHtmlContentField(textarea) {
    const key = `${textarea.id} ${textarea.name}`.toLowerCase();
    return !key.includes('variables');
  }

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

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.key !== '>') {
        return;
      }
      const textarea = event.target;
      if (!textarea || textarea.tagName !== 'TEXTAREA' || !isHtmlContentField(textarea)) {
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (start !== end) {
        return; // typing '>' over a selection - let it replace normally
      }

      // The '>' hasn't been inserted yet, so check the text up to the caret
      // plus the '>' this keystroke is about to add.
      const upToCaret = textarea.value.slice(0, start) + '>';
      const match = upToCaret.match(OPEN_TAG_PATTERN);
      if (!match) {
        return;
      }
      const [, tagName, selfClosingSlash] = match;
      if (selfClosingSlash || VOID_ELEMENTS.has(tagName.toLowerCase())) {
        return;
      }

      event.preventDefault();
      const closingTag = `</${tagName}>`;
      insertTextPreservingUndo(textarea, `>${closingTag}`);
      textarea.setSelectionRange(start + 1, start + 1);
    },
    true
  );
})();
