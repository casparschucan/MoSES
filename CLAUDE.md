# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

MoSES (Moodle STACK Editor Skin) — a collection of Tampermonkey userscripts
that improve the ETHZ Moodle STACK question-editing page
(`moodle-app2.let.ethz.ch/question/bank/editquestion/question.php*`). Pure
client-side JS injected into the page by Tampermonkey; no build step, no
package.json, no server component.

## Commands

There is no build/lint/test tooling. The only verification step is a syntax
check, which should be run after every edit to a `.user.js` file:

```
node --check <file>.user.js
```

Manual testing requires an authenticated ETHZ Moodle session, which Claude
cannot access — after making a change, report what to verify and ask the
user to test it live (paste into Tampermonkey, or wait for auto-update) and
report back console warnings or actual DOM HTML if something doesn't work.

## Repo structure / architecture

**One `.user.js` file per independent feature** — this is the core structural
rule of the repo, not just a convention. Each file is a complete, standalone
Tampermonkey script with its own metadata block (`@name`, `@match`, `@grant`,
`@version`, `@updateURL`/`@downloadURL`). Do not add unrelated functionality
to an existing script; create a new sibling file instead. This keeps features
independently enable/disable-able in Tampermonkey. Only share code between
scripts via `@require <raw-github-url>` if two features need real shared
logic (not merely touching the same page).

Current scripts:
- `moodle-stack-helper.user.js` — makes the Question variables textarea
  resizable and persists its height; adds Ctrl+scroll font-size control
  shared across every text field on the form. Uses `GM_setValue`/`GM_getValue`
  (Tampermonkey's own storage, separate from page localStorage) to persist
  height/font size across questions and browser restarts.
- `keyboard-shortcuts.user.js` — Ctrl+S / Ctrl+P / Ctrl+Enter shortcuts (see
  below).
- `auto-brackets.user.js` — auto-closes `( [ { " '` in every text field,
  with skip-over and paired-Backspace-delete behavior.
- `auto-close-html-tags.user.js` — auto-inserts the closing tag when you
  finish an opening HTML tag, restricted to Question text/feedback fields
  (see the field-classification heuristic below).

### Release/update mechanism

Every script's `@updateURL`/`@downloadURL` points at its own raw file on
`main` (`https://raw.githubusercontent.com/casparschucan/MoSES/main/<file>`).
Tampermonkey polls that URL and compares `@version`; a higher version
triggers an auto-update offer. **Bumping `@version` is mandatory for every
shipped change** — forgetting it means Tampermonkey silently ignores the
update. There is no other release step: edit, bump version, commit, push to
`main`.

### Defensive DOM-selector pattern (used throughout)

ETHZ's exact Moodle/STACK theme HTML (ids, names, element types) isn't known
up front and can't be inspected directly (no live authenticated access), and
some fields (e.g. per-PRT feedback textareas) have no single stable
id/name. Both scripts therefore favor grabbing broadly and filtering/matching
safely over hardcoding brittle selectors:
- `moodle-stack-helper.user.js`'s `findAllTextTextareas()` grabs every
  `<textarea>` on the page and filters to visible ones (`offsetParent !==
  null`), rather than listing selectors per field.
- `keyboard-shortcuts.user.js`'s `findButtonByText()` scans
  `button, input[type="submit"], a` and matches on visible label text
  (case-insensitive substring), since the target controls turned out to be a
  mix of real buttons and plain `<a>` links (Preview is an anchor, not a
  button — discovered by trial and had to be added to the selector).

When a selector fails to find its target, scripts `console.warn()` with a
`[<Script Name>]`-prefixed message rather than failing silently — this is the
first thing to check (and to ask the user to check) when a feature "does
nothing."

A variant of this pattern shows up in `auto-close-html-tags.user.js`: since
there's no existing way to distinguish an "HTML content field" (Question
text, feedback) from a "Maxima code field" (Question variables, Feedback
variables) anywhere in this codebase, `isHtmlContentField()` classifies by a
heuristic instead of a hardcoded id list — any textarea whose `id`/`name`
doesn't contain `variables` counts as HTML. This is unverified against a
live page (relies on the one confirmed naming convention,
`id_questionvariables`, generalizing to Feedback variables fields too); if
it ever misclassifies a field, tighten the pattern rather than hardcoding
ids, per the same defensive spirit as the rest of this section.

Both `auto-brackets.user.js` and `auto-close-html-tags.user.js` edit
textareas via `document.execCommand('insertText'/'delete')` rather than
setting `.value` directly — this preserves the browser's native undo/redo
stack and fires a real `input` event that Moodle's own form-dirty tracking
depends on; a manual `.value` + dispatched `input` event is the fallback if
`execCommand` support is ever missing.

### `keyboard-shortcuts.user.js` shortcut design

- **Ctrl+S** clicks "Save changes and continue editing" specifically — text
  pattern `'continue editing'` deliberately excludes the plain "Save changes"
  button, which navigates away from the form.
- **Ctrl+P** clicks "Preview".
- **Ctrl+Enter** chains both: save, then open Preview once the save's page
  reload completes. All three intercept the browser's native behavior
  (Save Page / Print / form-submit) via a capture-phase `keydown` listener +
  `preventDefault()`.
- Ctrl+Enter's chaining crosses a full page reload (the save submits the
  form), which destroys all in-memory script state. It carries intent across
  the reload via a `sessionStorage` breadcrumb (`moses_open_preview_after_save`):
  set right before the save click, checked on every page load, and cleared
  once consumed.
- The post-reload preview step cannot rely on a normal `.click()` on Moodle's
  Preview link: without a live user gesture at that point, Moodle's own popup
  logic detects the blocked popup and falls back to navigating the *current*
  window instead of opening a new one. The workaround is calling
  `window.open(previewHref, '_blank', 'noopener')` directly — but this is
  still subject to the browser's popup blocker, so it only works once the
  user has allowed pop-ups for the Moodle site (a one-time browser-level
  permission, documented in the README).
