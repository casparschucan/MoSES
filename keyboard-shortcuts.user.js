// ==UserScript==
// @name         MoSES: Save/Preview shortcuts (ETHZ)
// @namespace    https://github.com/casparschucan/MoSES
// @version      0.2.0
// @description  Ctrl+S clicks "Save changes and continue editing", Ctrl+P clicks "Preview", and Ctrl+Enter does both in sequence (refresh the preview) on ETHZ Moodle STACK question edit pages, instead of triggering the browser's own Save Page / Print dialogs.
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
 * Ctrl+S     -> clicks the "Save changes and continue editing" button (NOT
 *               the plain "Save changes" button, which navigates away to
 *               the question bank list instead of staying on this form).
 * Ctrl+P     -> clicks the "Preview" button.
 * Ctrl+Enter -> does both, in order: save-and-continue, THEN open Preview
 *               once the save has gone through. This is meant for the
 *               "tweak the question, refresh the preview" loop, without
 *               having to hit Ctrl+S and then Ctrl+P separately.
 *
 * All three key combos are normally claimed by the browser itself (Ctrl+S =
 * Save Page As..., Ctrl+P = Print, Ctrl+Enter = submit the nearest form in
 * some sites). We intercept them with a 'keydown' listener and call
 * event.preventDefault() to stop the browser's own behavior before it
 * happens - the same technique moodle-stack-helper.user.js uses to stop
 * Ctrl+scroll from zooming the whole page.
 *
 * WHY Ctrl+Enter NEEDS sessionStorage
 * ---------------------------------------------------------------------------
 * "Save changes and continue editing" submits the form, which reloads this
 * page from the server - our script (and all its in-memory state) is
 * destroyed and starts fresh on the new page load. So Ctrl+Enter can't just
 * "click save, then click preview" in one go; the preview click has to
 * happen on the *next* page load, after the reload finishes. We leave a
 * breadcrumb in sessionStorage (survives the reload, scoped to this tab)
 * before clicking save, then check for that breadcrumb on every load and
 * click Preview if it's there.
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
  const AUTO_PREVIEW_FLAG = 'moses_open_preview_after_save'; // sessionStorage key, survives the save's page reload

  function getButtonLabel(el) {
    // <button>/<a> elements carry their label as text content; <input
    // type=submit> carries it in the value attribute instead.
    return (el.tagName === 'INPUT' ? el.value : el.textContent).trim().toLowerCase();
  }

  function findButtonByText(pattern) {
    // Preview is rendered as a plain <a> link (opening preview.php), not a
    // form button, so it has to be included here alongside the actual
    // submit buttons.
    const candidates = document.querySelectorAll('button, input[type="submit"], a');
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
    } else if (key === 'enter') {
      event.preventDefault();
      // Leave a breadcrumb for the *next* page load (see the sessionStorage
      // comment near the top of this file), then trigger the save. If the
      // save button can't be found, don't leave a stale flag behind.
      const saveButton = findButtonByText(SAVE_TEXT_PATTERN);
      if (saveButton) {
        sessionStorage.setItem(AUTO_PREVIEW_FLAG, '1');
        saveButton.click();
      } else {
        console.warn(
          '[Keyboard Shortcuts] Ctrl+Enter: no button found with text containing ' +
          `"${SAVE_TEXT_PATTERN}". Inspect the form's buttons and update the pattern in keyboard-shortcuts.user.js.`
        );
      }
    }
  }, true);

  // Runs on every load of this page, including the reload that "Save changes
  // and continue editing" triggers. If Ctrl+Enter set the breadcrumb before
  // that reload, clear it and open Preview now that the saved page is ready.
  if (sessionStorage.getItem(AUTO_PREVIEW_FLAG)) {
    sessionStorage.removeItem(AUTO_PREVIEW_FLAG);
    clickOrWarn(PREVIEW_TEXT_PATTERN, 'Ctrl+Enter (preview step)');
  }
})();
