// ==UserScript==
// @name         MoSES: Auto-brackets
// @namespace    https://github.com/casparschucan/MoSES
// @version      0.1.0
// @description  Auto-inserts the matching ), ], }, ", ' when you type the opening character in any text field on the STACK question edit page; skips over an existing closing character instead of duplicating it; deletes both halves of an empty pair on Backspace.
// @author       Caspar Schucan
// @match        https://moodle-app2.let.ethz.ch/question/bank/editquestion/question.php*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/casparschucan/MoSES/main/auto-brackets.user.js
// @downloadURL  https://raw.githubusercontent.com/casparschucan/MoSES/main/auto-brackets.user.js
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * Typing an opening bracket or quote - ( [ { " ' - in any textarea on this
 * page auto-inserts its matching partner and leaves the caret between them,
 * the same behavior as VS Code/most code editors. Typing the closing
 * character when it's already the very next character "types over" it
 * instead of inserting a duplicate. Backspace right inside an empty
 * auto-inserted pair (e.g. caret between "(" and ")") deletes both halves in
 * one step instead of leaving a dangling unmatched bracket.
 *
 * This applies to every textarea on the page (Question text, feedback
 * fields, Question variables, Feedback variables, ...) rather than just the
 * Maxima code fields, via a delegated keydown listener rather than querying
 * specific textareas up front - see keyboard-shortcuts.user.js's
 * findButtonByText() for the same "match broadly at the moment it matters"
 * reasoning, applied here to newly-rendered per-PRT feedback textareas that
 * don't exist yet when the script first runs.
 *
 * WHY execCommand INSTEAD OF SETTING .value DIRECTLY
 * ---------------------------------------------------------------------------
 * Directly assigning textarea.value would silently break the browser's
 * native undo/redo (Ctrl+Z) stack and wouldn't fire a real 'input' event,
 * which Moodle's own form-dirty-tracking JS relies on to know the field
 * changed. document.execCommand('insertText'/'delete') performs the edit
 * the same way as if the user had typed/deleted it, so undo and Moodle's
 * change tracking both keep working. It's deprecated but still implemented
 * by every browser Tampermonkey targets (Firefox/Zen, Chrome) for exactly
 * this kind of use case; a manual fallback covers the case where it isn't.
 *
 * WHY MODIFIER KEYS ARE IGNORED
 * ---------------------------------------------------------------------------
 * If Ctrl/Alt/Meta is held we do nothing at all, so this never fights with
 * keyboard-shortcuts.user.js's Ctrl+S / Ctrl+P / Ctrl+Enter handling (or any
 * other browser/OS shortcut that happens to use one of these characters).
 */

(function () {
  'use strict';

  const PAIR_MAP = {
    '(': ')',
    '[': ']',
    '{': '}',
    '"': '"',
    "'": "'",
  };
  const OPEN_CHARS = new Set(['(', '[', '{']);
  const QUOTE_CHARS = new Set(['"', "'"]);
  const CLOSE_CHARS = new Set([')', ']', '}']);

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

  function deleteRangePreservingUndo(textarea, start, end) {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    if (document.queryCommandSupported && document.queryCommandSupported('delete')) {
      document.execCommand('delete');
      return;
    }
    textarea.value = textarea.value.slice(0, start) + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function handleOpeningChar(textarea, key) {
    const close = PAIR_MAP[key];
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start !== end) {
      // Wrap the current selection instead of replacing it.
      const selected = textarea.value.slice(start, end);
      insertTextPreservingUndo(textarea, key + selected + close);
      textarea.setSelectionRange(start + 1, start + 1 + selected.length);
      return;
    }
    insertTextPreservingUndo(textarea, key + close);
    textarea.setSelectionRange(start + 1, start + 1);
  }

  function handleQuoteChar(textarea, key) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start !== end) {
      handleOpeningChar(textarea, key);
      return;
    }
    const nextChar = textarea.value[start];
    if (nextChar === key) {
      // Skip over an existing closing quote instead of inserting a new pair.
      textarea.setSelectionRange(start + 1, start + 1);
      return;
    }
    handleOpeningChar(textarea, key);
  }

  function handleClosingChar(textarea, key) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start !== end) {
      return false; // let the browser replace the selection normally
    }
    if (textarea.value[start] === key) {
      textarea.setSelectionRange(start + 1, start + 1);
      return true;
    }
    return false;
  }

  function handleBackspace(textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start !== end || start === 0) {
      return false;
    }
    const before = textarea.value[start - 1];
    const after = textarea.value[start];
    if (PAIR_MAP[before] === after) {
      deleteRangePreservingUndo(textarea, start - 1, start + 1);
      return true;
    }
    return false;
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }
      const textarea = event.target;
      if (!textarea || textarea.tagName !== 'TEXTAREA') {
        return;
      }

      const key = event.key;

      if (OPEN_CHARS.has(key)) {
        event.preventDefault();
        handleOpeningChar(textarea, key);
      } else if (QUOTE_CHARS.has(key)) {
        event.preventDefault();
        handleQuoteChar(textarea, key);
      } else if (CLOSE_CHARS.has(key)) {
        if (handleClosingChar(textarea, key)) {
          event.preventDefault();
        }
      } else if (key === 'Backspace') {
        if (handleBackspace(textarea)) {
          event.preventDefault();
        }
      }
    },
    true
  );
})();
