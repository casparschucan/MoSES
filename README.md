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
- **Ctrl+Enter** does both, in order — saves, then opens the refreshed
  Preview — for the "tweak the question, check the preview" loop.

All three combos normally trigger the browser's own Save Page / Print /
form-submit behavior; this script intercepts them with `preventDefault()` so
only the in-page button click happens, scoped to this one page via `@match`.
It finds the buttons by matching their visible label text rather than a
hardcoded id/name, since the exact attributes ETHZ's theme/STACK plugin
render weren't known up front. If a shortcut does nothing, check the browser
console for a `[Keyboard Shortcuts]` warning naming which button couldn't be
found.

Ctrl+Enter needs one extra trick: "Save changes and continue editing"
reloads the page, which wipes out the script's in-memory state before it can
open Preview. So it leaves a small breadcrumb in `sessionStorage` before
clicking save, and every page load checks for that breadcrumb — if present,
it's cleared and Preview is opened automatically. This only affects the
current browser tab and clears itself immediately, so it doesn't linger.

**Note on pop-ups:** after the reload, there's no direct user click for the
browser to attach to, so if you click Moodle's Preview link the normal way
it detects the blocked pop-up and falls back to navigating your current
window instead — not what you want. To avoid that, this step calls
`window.open()` on the preview URL directly, but browsers still require you
to have allowed pop-ups for this site (a one-time thing) or that call gets
silently blocked. If Ctrl+Enter saves but no preview window appears, allow
pop-ups for `moodle-app2.let.ethz.ch` (in Chrome/Firefox: click the
pop-up-blocked icon in the address bar the first time, or add the site under
Settings → Privacy → Pop-ups and redirects → Allowed) — after that it keeps
working every time.

## Auto-brackets (`auto-brackets.user.js`)

A separate script that auto-closes brackets and quotes in **every** text
field on the form:
- Typing `(`, `[`, `{`, `"`, or `'` inserts the matching closing character
  right after the caret, with the caret left in between — the same behavior
  as VS Code and most code editors.
- Typing a closing character that's already the next character in the field
  "types over" it instead of inserting a duplicate.
- Selecting some text and typing an opening bracket/quote wraps the
  selection instead of replacing it.
- Pressing Backspace with the caret inside an empty auto-inserted pair (e.g.
  between `(` and `)`) deletes both characters in one step.
- Holding Ctrl/Alt/Meta disables all of the above, so it never interferes
  with `keyboard-shortcuts.user.js`'s Ctrl+S/P/Enter or any other shortcut.

It edits the field via `document.execCommand('insertText'/'delete')` rather
than setting `.value` directly, so the browser's native undo (Ctrl+Z) and
Moodle's own form-dirty tracking both keep working correctly.

## Auto-close HTML tags (`auto-close-html-tags.user.js`)

A separate script that finishes HTML tags for you in **Question text and
feedback fields only** (deliberately excluding Question variables/Feedback
variables, since `<`/`>` are comparison operators in Maxima code, not
markup — see the field heuristic below):
- Typing the closing `>` of an opening tag like `<div>` auto-inserts
  `</div>` right after the caret, with the caret left between the two tags.
- Void elements (`<br>`, `<img>`, ...) and already self-closing tags
  (`<br/>`) are left alone, since they have no closing tag.
- **Known limitation**: if you then type your own closing tag afterwards,
  you'll end up with a duplicate — this isn't detected/merged, to keep the
  script simple.
- **Field detection is a heuristic**, since there's no existing way in this
  codebase to distinguish "HTML content field" from "Maxima code field": any
  textarea whose `id`/`name` doesn't contain `variables` is treated as an
  HTML field. If auto-close ever fires inside a Maxima field, check that
  field's actual `id`/`name` in devtools and report it so the heuristic can
  be tightened.

## Syntax highlighting (`syntax-highlight.user.js`)

A separate script that syntax-highlights **every** text field on the question
form, in one of two modes depending on what's in it (using the same "id/name
contains `variables`" test the auto-close-HTML script uses):

### Maxima fields (Question variables, each PRT's Feedback variables)
- **Rainbow brackets.** `(`, `[` and `{` are coloured by nesting depth, so a
  matching pair always shares a colour and you can see the structure of a long
  `block(...)` at a glance.
- **Unmatched brackets in red, with a wavy underline** — including a `(` that's
  never closed, a stray `)`, and a `(` closed by `]`. Same treatment for an
  unterminated string or `/* comment`, which otherwise silently swallow the
  rest of the field.
- **Your own variables in a distinct colour.** Anything you assign with `:` or
  `:=` is picked out *everywhere it appears*, not just where it was assigned,
  so it's obvious which names are yours and which belong to Maxima.
- Strings, nested `/* */` comments, numbers, keywords, and STACK/Maxima
  builtins each get their own colour, and `;` / `$` statement terminators are
  drawn in bold so a missing one stands out.
- These fields are switched to a **monospace font** (required for the
  highlighting to line up — see below).

### CASText fields (Question text, General feedback, PRT node feedback)

These are HTML with three other languages mixed into them, and each gets its
own colour:

- **STACK tags** — `[[input:ans1]]`, `[[validation:ans1]]`, `[[feedback:prt1]]`
  and the rest, with the verb, the `ansN`/`prtN` name and any `key="value"`
  attributes coloured separately.
  - A verb STACK doesn't recognise (`[[inpt:ans1]]`) gets a dotted red
    underline, so typos in the one bit of syntax you can't get wrong quietly
    are visible immediately.
  - Block tags are **pairing-checked**: an unclosed `[[if ...]]`, a stray
    `[[/if]]`, or a `[[comment]]` closed by `[[/if]]` all turn red.
    `[[input:...]]` and friends never take a closer and are never flagged.
- **Inline CAS** — `{@ ... @}` and `{# ... #}`. The contents are Maxima, so
  they're handed to the Maxima tokenizer and get the *same* colours as your
  Question variables, brackets and all.
- **LaTeX** — `\( ... \)` and `\[ ... \]` are tinted as one unit, except that
  any `{@ ... @}` embedded inside keeps its CAS colours. An unclosed `\(`
  turns red. Note that `$...$` is deliberately **not** treated as maths:
  STACK's docs say dollar delimiters are unsupported, and guessing would
  misfire on any question that mentions a price.
- **HTML** — tags, attributes, quoted values, `<!-- comments -->` and
  `&entities;`.

Prose fields keep Moodle's own font (only the code fields are switched to
monospace) and keep their spellcheck — the squiggles are drawn by the real
textarea underneath and show through the overlay, landing under the right
words.

**On the exam Moodle (`moodle-app6`)** the Question text field uses the
rich-text editor, which hides the real textarea; the script skips those, so
CASText highlighting will mostly show up on `moodle-app2`.

### How it works, and how it can fail

A `<textarea>` can only render plain text — you can't put a coloured `<span>`
inside one. So the script lays a "mirror" element on top of the field showing
the same text with colours, makes it click-through (`pointer-events: none`),
and makes the real textarea's own text transparent. **Everything you actually
interact with is still the real textarea**: typing, the caret, selection,
Ctrl+Z undo, form submission and the other MoSES scripts are all untouched.

Because the mirror is a separate element, it has to line up with the textarea
to the pixel. Two consequences worth knowing:

- **Monospace is forced on the code fields, deliberately.** In the textarea a
  line is one continuous run of text, so the browser kerns across it; in the
  mirror the line is chopped into spans, and kerning doesn't apply across a
  span boundary. With a proportional font the two would drift apart *within* a
  line. With monospace every glyph has the same width, so it can't. (Ligatures
  are switched off on both sides for the same reason.)
  - Prose fields keep Moodle's font and get `font-kerning: none` instead,
    which removes the drift at its source — with kerning off, nothing depends
    on the neighbouring glyph any more, so span boundaries stop mattering. The
    only cost is that a few letter pairs sit a hair looser than usual.
  - There's also a runtime check on total height: if the mirror ever wraps
    even one line differently from the textarea, it says so in the console
    with both measurements.
- **If it can't line up, it turns itself off.** At attach time the script
  measures the mirror against the textarea, and if they're more than a pixel
  apart it removes the overlay, restores the field to plain text and logs a
  `[MoSES Highlight]` warning with the measured offset. A field with no
  highlighting is fine; a field whose text ghosts a few pixels off is not.
  Any error while re-rendering does the same thing, and the real text is only
  made transparent *after* a first render has succeeded — so there is no
  failure path that leaves you unable to see what you're typing.

Fields inside a collapsed *Potential response tree* section aren't laid out
yet, so they're highlighted the moment you click into them rather than at page
load. Same for any field added later by an "Add another PRT" button.

To turn it off, use the Tampermonkey icon → **Toggle STACK syntax
highlighting**. It takes effect immediately, without a page reload (so you
don't lose unsaved edits), and is remembered.

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
- Colouring variables from Question variables when they appear inside
  `{@ ... @}` in the question text — cross-field awareness.
- A lint/diagnostics strip under each field: statements not ending in `;`
  (which STACK's docs recommend but don't require), unbalanced brackets, an
  `[[input:ansN]]` with no matching `[[validation:ansN]]`, and so on.
- Autocomplete inside `[[ ]]` offering the `ansN`/`prtN` names actually used by
  the question, plus the STACK block names (`if`, `comment`, `foreach`, ...).
