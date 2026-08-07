# Moodle STACK Helper (ETHZ)

A Tampermonkey userscript that makes the "Question variables" textarea on
ETHZ Moodle's STACK question edit pages resizable, lets you change the text
size across all the question's text fields (Question text, General/Specific
feedback, Feedback variables, Question variables, ...) with Ctrl+scroll, and
remembers both across sessions.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser
   extension if you don't have it already.
2. Click the Tampermonkey icon → **Create a new script**.
3. Delete the placeholder content and paste in the full contents of
   [`moodle-stack-helper.user.js`](./moodle-stack-helper.user.js).
4. Save (Ctrl+S / File → Save). Tampermonkey will parse the metadata block at
   the top and register the script automatically — no build step needed.
5. Open a STACK question edit page on `moodle-app2.let.ethz.ch` (URLs under
   `/question/bank/editquestion/question.php`). The "Question variables"
   field should now be ~300px tall with ~16px text by default, and have a
   drag handle in its bottom-right corner.

## What it does

- Finds the "Question variables" textarea (`#id_questionvariables`, the
  standard field id Moodle's STACK plugin generates).
- Overrides Moodle's CSS so the field is vertically resizable
  (`resize: vertical`), since Moodle's theme sometimes locks textareas to a
  fixed size.
- Gives it a larger starting height (300px) instead of Moodle's cramped
  default.
- Lets you change just the **text size** (independent of the box size) on
  *every* text field on the question form — Question text, General feedback,
  each part's Specific feedback, Feedback variables, Question variables, and
  so on — by hovering any of them, holding **Ctrl**, and scrolling the mouse
  wheel up (bigger) or down (smaller) — the same convention as browser
  page-zoom and editors like VS Code. Clamped between 10px and 28px.
  - All fields share one remembered font size: scrolling on any one of them
    resizes all of them together, so the form stays visually consistent.
  - This works by grabbing every `<textarea>` on the page rather than one
    per field, since the feedback fields don't have a single stable id/name
    (they're generated per potential-response-tree). It relies on those
    fields being plain textareas rather than Moodle's rich-text (Atto)
    editor — true as long as you're using the **Plain Text editor** (as
    you are on `moodle-app2`). If a field ever uses the rich-text editor
    instead, the script skips its hidden textarea rather than sizing
    something you can't see.
- Remembers whatever height and font size you pick, using Tampermonkey's own
  storage (`GM_setValue`/`GM_getValue`) — so both stay as you left them across
  different questions, courses, and browser restarts.

See the comments inside `moodle-stack-helper.user.js` for a detailed,
line-by-line explanation of how Tampermonkey scripts work (the metadata
block, `@match`, `@grant`, `ResizeObserver`, the Ctrl+scroll/`preventDefault`
mechanics, etc.) — it's written to double as a learning reference.

## If the textarea isn't found

Moodle themes occasionally customize form rendering. If the script doesn't
seem to do anything:

1. Open the browser devtools console (F12) on the question edit page.
2. Look for a warning starting with `[Moodle STACK Helper]`.
3. Right-click the actual "Question variables" field → Inspect, and note its
   real `id`/`name` attributes.
4. Share that HTML so the selector in `findQuestionVariablesTextarea()` can
   be updated.

## Keyboard shortcuts (`keyboard-shortcuts.user.js`)

A separate script for the same STACK question edit page:
- **Ctrl+S** clicks "Save changes and continue editing" (not the plain "Save
  changes" button, which navigates away from the form).
- **Ctrl+P** clicks "Preview".

Both combos normally trigger the browser's own Save Page / Print dialogs;
this script intercepts them with `preventDefault()` so only the in-page
button click happens, scoped to this one page via `@match`. It finds the
buttons by matching their visible label text rather than a hardcoded
id/name, since the exact attributes ETHZ's theme/STACK plugin render weren't
known up front. If a shortcut does nothing, check the browser console for a
`[Keyboard Shortcuts]` warning naming which button couldn't be found.

## Updating the script after you push a change

Each script has `@updateURL`/`@downloadURL` metadata pointing at its raw file
on GitHub (`main` branch). Tampermonkey periodically polls that URL and
compares the `@version` field; if the remote version is higher, it offers to
auto-install the new file — no more copy-pasting into the Tampermonkey editor.

To ship a change:
1. Edit the `.user.js` file.
2. **Bump `@version`** in its metadata block — Tampermonkey only updates when
   the version number goes up, so forgetting this step means the update is
   silently ignored.
3. Commit and push to `main`.
4. Tampermonkey will pick it up on its own schedule, or immediately via the
   dashboard's **Utilities → Check for userscript updates**.

This works the same in Zen as in any other Firefox-based browser, since
Tampermonkey's Firefox build uses the same update mechanism.

## Adding more features / repo structure

This repo is meant to hold multiple independent userscripts, not grow one
script indefinitely:
- **Default to one `.user.js` file per independent feature**, each with its
  own metadata block (`@match`, `@grant`, `@updateURL`/`@downloadURL`). This
  keeps features individually enable/disable-able in Tampermonkey and keeps
  unrelated concerns from tangling together.
- Only share code between scripts via Tampermonkey's `@require <url>`
  directive (pointing at a raw GitHub URL of a shared helper file) if two
  features need real shared logic — not just because they both touch STACK
  question forms. `@require`'d files need their own versioning discipline
  since Tampermonkey caches them separately from the main script.

## Roadmap ideas

Not implemented yet, but natural follow-ups if useful:
- Preset-size buttons (small/medium/large) next to the drag handle, or a
  visible +/- font-size control for people who don't want to rely on
  discovering Ctrl+scroll.
- Applying the drag-to-resize height control (not just font size) to other
  text fields, the way Question variables already has it.
- Per-field (rather than shared) font sizes, if you ever want feedback text
  smaller than your Maxima code, for example.
- A monospace font / syntax highlighting for the Maxima code in the field.
