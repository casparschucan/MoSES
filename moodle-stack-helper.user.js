// ==UserScript==
// @name         Moodle STACK Helper (ETHZ)
// @namespace    https://github.com/caspar/moodle-stack-helper
// @version      0.1.0
// @description  Makes the "Question variables" textarea on ETHZ Moodle STACK question edit pages resizable, lets you Ctrl+scroll to change the font size across all the question's text fields, and remembers your preferred size/font.
// @author       you
// @match        https://moodle-app2.let.ethz.ch/question/bank/editquestion/question.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/casparschucan/moodle-skin/main/moodle-stack-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/casparschucan/moodle-skin/main/moodle-stack-helper.user.js
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * WHAT IS THIS FILE?
 * ---------------------------------------------------------------------------
 * This is a "userscript" — a small JavaScript file that Tampermonkey injects
 * into matching pages after they load, as if you'd opened devtools and pasted
 * the code into the console yourself. It has no build step and no server
 * component; it just runs in your browser on pages that match the @match rule
 * below.
 *
 * THE METADATA BLOCK (the comment above, between ==UserScript== markers)
 * -------------------------------------------------------------------------
 * Tampermonkey parses that comment block to decide how/when/where to run the
 * script — it is not treated as a normal comment.
 *
 *   @match     Restricts the script to URLs matching this pattern. We scope
 *              it to the exact ETHZ question-edit page family you gave me,
 *              with a trailing "*" so it still matches regardless of the
 *              query string (?cmid=..., ?id=..., etc). Tampermonkey will not
 *              run this script on any other site.
 *
 *   @grant     Userscripts run in a sandbox that is deliberately cut off from
 *              some browser APIs the *page itself* uses (this stops a
 *              userscript from silently colliding with the site's own code,
 *              e.g. both using window.myGlobal). GM_setValue/GM_getValue are
 *              Tampermonkey's own storage APIs — separate from the page's
 *              localStorage — and you must explicitly @grant them or calling
 *              them throws an error. Because this storage lives in
 *              Tampermonkey (not the page), your saved height survives even
 *              across different questions/courses on the same site.
 *
 *   @run-at    document-idle means "wait until the page has finished loading
 *              and gone quiet" (similar to the DOMContentLoaded + a bit more).
 *              We want this rather than document-start because Moodle's own
 *              form-building JavaScript needs to have already built the
 *              "Question variables" field before we try to touch it.
 *
 * A NOTE ON Ctrl+scroll AND preventDefault()
 * -------------------------------------------------------------------------
 * Browsers already bind Ctrl+scroll-wheel to zooming the entire page. To
 * make Ctrl+scroll instead resize *just* a textarea's font, we listen for
 * the 'wheel' event and call event.preventDefault() to cancel the browser's
 * own zoom before it happens. Modern browsers default wheel listeners to
 * "passive" (a performance optimization that forbids preventDefault, so the
 * browser can start scrolling immediately without waiting for our code to
 * finish) — so we explicitly opt out with `{ passive: false }` when adding
 * the listener, otherwise preventDefault() would silently do nothing.
 *
 * A NOTE ON APPLYING THIS TO EVERY TEXT FIELD
 * -------------------------------------------------------------------------
 * Question text, General/Specific feedback, and Feedback variables don't
 * have one stable id each the way Question variables does (feedback fields
 * in particular are named per potential-response-tree). Rather than
 * hardcode a brittle list of selectors for fields we haven't seen the HTML
 * of, the font-size feature just grabs every <textarea> on the page. This
 * is safe as long as those fields render as plain textareas rather than a
 * rich-text (Atto/TinyMCE) editor — which is the case here since the Plain
 * Text editor is used for this account.
 */

(function () {
  'use strict';

  // Tunable constants live up top so they're easy to find/change later.
  const HEIGHT_STORAGE_KEY = 'qv_height_px'; // key used in Tampermonkey's storage
  const DEFAULT_HEIGHT_PX = 300;             // first-run height, taller than Moodle's default
  const MIN_HEIGHT_PX = 100;                 // don't let it collapse to something unusable

  const FONT_STORAGE_KEY = 'qv_font_px';     // key used in Tampermonkey's storage
  const DEFAULT_FONT_PX = 16;                // first-run font size, bigger than Moodle's stock ~13px
  const MIN_FONT_PX = 10;                    // don't let Ctrl+scroll shrink text to unreadable
  const MAX_FONT_PX = 28;                    // don't let it grow past what's still usable

  /**
   * Moodle's STACK question type (qtype_stack) renders the "Question
   * variables" field as a plain <textarea id="id_questionvariables"
   * name="questionvariables">. That id is generated by Moodle core's form
   * library from the field's internal name ("questionvariables"), so it's
   * stable across Moodle sites/themes as long as ETHZ hasn't customised the
   * STACK plugin's form. We try the id first (fast, specific), and fall back
   * to a name-based selector in case the id ever differs.
   */
  function findQuestionVariablesTextarea() {
    return (
      document.getElementById('id_questionvariables') ||
      document.querySelector('textarea[name="questionvariables"]')
    );
  }

  function makeResizableAndPersistent(textarea) {
    // Moodle's theme CSS sometimes sets `resize: none` or a fixed height
    // inline on form textareas. We override that with !important so our
    // rule wins regardless of CSS specificity/load order.
    textarea.style.setProperty('resize', 'vertical', 'important');
    textarea.style.minHeight = MIN_HEIGHT_PX + 'px';

    // Restore a previously saved height, or fall back to a taller default
    // than stock Moodle so the very first use is already an improvement.
    const savedHeight = GM_getValue(HEIGHT_STORAGE_KEY, null);
    textarea.style.height = (savedHeight || DEFAULT_HEIGHT_PX) + 'px';

    // ResizeObserver fires whenever the element's box size changes for any
    // reason — including the user dragging the native resize handle in the
    // textarea's bottom-right corner. This is the modern replacement for
    // older hacks like polling the element's size on a timer or listening
    // for mouseup events on the handle.
    let saveTimer = null;
    const observer = new ResizeObserver((entries) => {
      // Debounce: while the user is actively dragging, this callback can
      // fire many times per second. We only actually write to storage once
      // they've paused for 300ms, to avoid hammering GM_setValue.
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const newHeight = Math.round(entries[0].contentRect.height);
        GM_setValue(HEIGHT_STORAGE_KEY, newHeight);
      }, 300);
    });
    observer.observe(textarea);
  }

  /**
   * The user wants Ctrl+scroll font sizing on *every* text field on the
   * question form — Question text, General feedback, each PRT's Specific
   * feedback, Feedback variables, etc. — not just Question variables. Those
   * fields' exact ids/names vary (feedback fields are named per potential-
   * response-tree, e.g. one per "PRT node"), so rather than hardcoding a
   * long list of selectors we just grab every <textarea> on the page.
   *
   * The one thing to watch for: Moodle's rich-text (Atto/TinyMCE) editor
   * normally *hides* the real <textarea> behind an iframe-based WYSIWYG UI,
   * so blindly grabbing every textarea could silently size an invisible
   * element. You've said you always use the Plain Text editor on this site,
   * so that shouldn't come up — but we filter to visible textareas
   * (`offsetParent !== null`) anyway as a cheap safety net, in case some
   * field still ends up using the rich editor.
   */
  function findAllTextTextareas() {
    return Array.from(document.querySelectorAll('textarea')).filter(
      (el) => el.offsetParent !== null
    );
  }

  /**
   * Lets the user change text size (not box size) on any of the form's text
   * fields by holding Ctrl and scrolling the mouse wheel while hovering it —
   * the same convention VS Code, most browsers' page-zoom, and many other
   * editors use, so it's discoverable without any extra buttons.
   *
   * All fields share a single remembered font size: scrolling on any one of
   * them resizes all of them together and saves one value, so the whole form
   * stays visually consistent rather than each box drifting to a different
   * size.
   */
  function setupFontSizeControl(textareas) {
    // Restore a previously saved font size, or fall back to a larger-than-
    // stock default (Moodle's own textareas are usually ~13px).
    const savedFontPx = GM_getValue(FONT_STORAGE_KEY, null);
    const initialPx = savedFontPx || DEFAULT_FONT_PX;
    textareas.forEach((t) => {
      t.style.fontSize = initialPx + 'px';
    });

    let saveTimer = null;
    function applyFontSize(px) {
      textareas.forEach((t) => {
        t.style.fontSize = px + 'px';
      });
      // Debounce the save the same way as height, so rapid scrolling doesn't
      // spam GM_setValue with a write per wheel notch.
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        GM_setValue(FONT_STORAGE_KEY, px);
      }, 300);
    }

    textareas.forEach((textarea) => {
      textarea.addEventListener('wheel', (event) => {
        // Only hijack scrolling when Ctrl (or Cmd on Mac, which browsers
        // also report as ctrlKey for wheel events) is held. Plain scrolling
        // must keep working normally, including scrolling a textarea's own
        // content when it's taller than the visible box.
        if (!event.ctrlKey) {
          return;
        }

        // Ctrl+wheel normally zooms the whole browser page. preventDefault()
        // stops that so only the textareas' font size changes.
        event.preventDefault();

        const currentPx = parseFloat(getComputedStyle(textarea).fontSize);
        // deltaY is negative when scrolling up ("away" from you) — treat
        // that as zoom in, matching how page-zoom and code editors behave.
        const direction = event.deltaY < 0 ? 1 : -1;
        const nextPx = Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, currentPx + direction));

        applyFontSize(nextPx);
      }, { passive: false }); // passive:false is required for preventDefault() to work on a wheel event
    });
  }

  const questionVariablesTextarea = findQuestionVariablesTextarea();

  if (questionVariablesTextarea) {
    makeResizableAndPersistent(questionVariablesTextarea);
  } else {
    // If ETHZ's theme renders this field differently, fail loudly (in the
    // console only — nothing visible on the page) rather than silently doing
    // nothing. Open devtools (F12) > Console tab to see this message, then
    // inspect the actual field and update the selector above.
    console.warn(
      '[Moodle STACK Helper] Could not find the "Question variables" textarea ' +
      '(tried #id_questionvariables and textarea[name="questionvariables"]). ' +
      'Inspect the field on this page and update the script\'s selector.'
    );
  }

  const allTextareas = findAllTextTextareas();

  if (allTextareas.length > 0) {
    setupFontSizeControl(allTextareas);
  } else {
    console.warn(
      '[Moodle STACK Helper] No visible textareas found on this page for font-size control.'
    );
  }
})();
