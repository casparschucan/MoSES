// ==UserScript==
// @name         MoSES: Save/Preview shortcuts (ETHZ)
// @namespace    https://github.com/casparschucan/MoSES
// @version      0.2.2
// @description  Ctrl+S clicks "Save changes and continue editing", Ctrl+P clicks "Preview", and Ctrl+Enter does both in sequence (refresh the preview) on ETHZ Moodle STACK question edit pages, instead of triggering the browser's own Save Page / Print dialogs.
// @author       Caspar Schucan
// @match        https://moodle-app2.let.ethz.ch/question/bank/editquestion/question.php*
// @match        https://moodle-app6.let.ethz.ch/question/bank/editquestion/question.php*
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
 * open Preview if it's there.
 *
 * WHY THE POST-SAVE PREVIEW NEEDS window.open() INSTEAD OF A CLICK, AND WHY
 * IT NEEDS YOUR BROWSER'S PERMISSION
 * ---------------------------------------------------------------------------
 * Moodle's Preview link normally opens in a new window/tab because its own
 * click handler calls window.open(). Browsers only allow window.open() to
 * actually open a new window when it happens as the direct, immediate result
 * of the user physically clicking something ("user activation") - by design,
 * to stop sites from popping up windows on their own. Our post-save preview
 * step runs after a full page reload, with no user click at that exact
 * moment, so it doesn't qualify. If we just click Moodle's link like Ctrl+P
 * does, Moodle's own code detects the blocked popup and quietly falls back
 * to navigating *this* window to the preview instead - not what you want.
 * Calling window.open() ourselves on the preview URL sidesteps that
 * same-window fallback, but it's still subject to the same browser
 * popup-blocking rule: unless you've told your browser to always allow
 * popups for this Moodle site, it may block this call outright and open
 * nothing. (Chrome/Firefox: click the popup-blocked icon in the address bar
 * once, or add moodle-app2.let.ethz.ch to Settings > Privacy > Pop-ups and
 * redirects > Allowed.) Once allowed, the site-level permission applies
 * regardless of whether there was a recent click, so this keeps working.
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
  // that reload, clear it and open Preview in a new window now that the
  // saved page is ready - see the window.open() comment near the top of this
  // file for why this can't just be a click() like the plain Ctrl+P path.
  if (sessionStorage.getItem(AUTO_PREVIEW_FLAG)) {
    sessionStorage.removeItem(AUTO_PREVIEW_FLAG);
    const previewLink = findButtonByText(PREVIEW_TEXT_PATTERN);
    if (previewLink && previewLink.href) {
      const popup = window.open(previewLink.href, '_blank', 'noopener');
      if (!popup) {
        console.warn(
          '[Keyboard Shortcuts] Ctrl+Enter (preview step): the browser blocked the ' +
          'preview popup. Allow pop-ups for this site to let this open automatically.'
        );
      }
    } else {
      console.warn(
        '[Keyboard Shortcuts] Ctrl+Enter (preview step): no link found with text ' +
        `containing "${PREVIEW_TEXT_PATTERN}". Inspect the form's buttons and update the pattern in keyboard-shortcuts.user.js.`
      );
    }
  }
})();
