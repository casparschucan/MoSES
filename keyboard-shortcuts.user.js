// ==UserScript==
// @name         MoSES: Save/Preview shortcuts (ETHZ)
// @namespace    https://github.com/casparschucan/MoSES
// @version      0.1.0
// @description  Ctrl+S clicks "Save changes and continue editing" and Ctrl+P clicks "Preview" on ETHZ Moodle STACK question edit pages, instead of triggering the browser's own Save Page / Print dialogs.
// @author       Caspar Schucan
// @match        https://moodle-app2.let.ethz.ch/question/bank/editquestion/question.php*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/casparschucan/MoSES/main/keyboard-shortcuts.user.js
// @downloadURL  https://raw.githubusercontent.com/casparschucan/MoSES/main/keyboard-shortcuts.user.js
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * Ctrl+S -> clicks the "Save changes and continue editing" button (NOT the
 *           plain "Save changes" button, which navigates away to the
 *           question bank list instead of staying on this form).
 * Ctrl+P -> clicks the "Preview" button.
 *
 * Both key combos are normally claimed by the browser itself (Ctrl+S = Save
 * Page As..., Ctrl+P = Print). We intercept them with a 'keydown' listener
 * and call event.preventDefault() to stop the browser's own behavior before
 * it happens - the same technique moodle-stack-helper.user.js uses to stop
 * Ctrl+scroll from zooming the whole page.
 *
 * WHY MATCH BUTTONS BY TEXT INSTEAD OF id/name
 * ---------------------------------------------------------------------------
 * We don't know ETHZ's exact id/name attributes for these buttons, and
 * Moodle/STACK form rendering can vary. Rather than hardcode a specific
 * selector that might silently fail, we scan every button/submit-input on
 * the page and match on its visible label text - the same "grab broadly,
 * filter safely" approach findAllTextTextareas() uses in the other script.
 * If a label ever changes, only the pattern strings below need updating.
 */

(function () {
  'use strict';

  const SAVE_TEXT_PATTERN = 'continue editing'; // matches "Save changes and continue editing", excludes plain "Save changes"
  const PREVIEW_TEXT_PATTERN = 'preview';

  function getButtonLabel(el) {
    // <button> elements carry their label as text content; <input type=submit>
    // carries it in the value attribute instead.
    return (el.tagName === 'INPUT' ? el.value : el.textContent).trim().toLowerCase();
  }

  function findButtonByText(pattern) {
    const candidates = document.querySelectorAll('button, input[type="submit"]');
    for (const el of candidates) {
      if (getButtonLabel(el).includes(pattern)) {
        return el;
      }
    }
    return null;
  }

  function clickOrWarn(pattern, shortcutLabel) {
    const button = findButtonByText(pattern);
    if (button) {
      button.click();
    } else {
      console.warn(
        `[Keyboard Shortcuts] ${shortcutLabel}: no button found with text containing "${pattern}". ` +
        'Inspect the form\'s buttons and update the pattern in keyboard-shortcuts.user.js.'
      );
    }
  }

  // Listening on the capture phase means we see the event before Moodle's own
  // page scripts do, so preventDefault() reliably beats the browser default.
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey) {
      return;
    }

    const key = event.key.toLowerCase();

    if (key === 's') {
      event.preventDefault();
      clickOrWarn(SAVE_TEXT_PATTERN, 'Ctrl+S');
    } else if (key === 'p') {
      event.preventDefault();
      clickOrWarn(PREVIEW_TEXT_PATTERN, 'Ctrl+P');
    }
  }, true);
})();
