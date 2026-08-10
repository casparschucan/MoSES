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
- `syntax-highlight.user.js` — syntax-highlights every field via a mirror
  overlay (see below), in Maxima or CASText mode. Owns `textarea.style.color`
  / `caretColor` / `fontFamily` / `fontKerning` on the fields it attaches to.
- `stack-lint.user.js` — checks each field and lists problems in a strip
  inserted after it. Pure additions to the DOM; never touches the textarea.
- `lib/stack-lang.v1.js` — **not a userscript**; the `@require`d library
  holding both tokenizers and the field classification (see below).

### Release/update mechanism

Every script's `@updateURL`/`@downloadURL` points at its own raw file on
`main` (`https://raw.githubusercontent.com/casparschucan/MoSES/main/<file>`).
Tampermonkey polls that URL and compares `@version`; a higher version
triggers an auto-update offer. **Bumping `@version` is mandatory for every
shipped change** — forgetting it means Tampermonkey silently ignores the
update. There is no other release step: edit, bump version, commit, push to
`main`.

### The `@require`d library, and its versioning trap

`lib/stack-lang.v1.js` is a plain script assigning to a top-level
`var MosesStackLang`; Tampermonkey concatenates it into the requiring script's
scope, so each userscript sandbox gets its own copy and nothing lands on the
page's globals. It holds `tokenizeMaxima`, `tokenizeCastext`,
`isMaximaField`/`fieldMode` and `hasRichEditorUi`.

It exists because `syntax-highlight.user.js` and `stack-lint.user.js` must
agree **exactly** on tokenisation — a divergence would have the lint reporting
an error at a position the highlighting shows as the middle of a string, with
no way to tell which is wrong. That is the "real shared logic" bar from the
rule above; `insertTextPreservingUndo` remains duplicated and should stay so.

**Tampermonkey caches `@require` URLs aggressively, so the version is in the
filename.** Two rules, and both fail *silently* when forgotten, exactly like a
missed `@version` bump:

- Any library change must also bump the `@version` of **every** requiring
  script, in the same commit.
- A change that breaks an existing caller needs a **new filename**
  (`stack-lang.v2.js`) plus updated `@require` lines, so an installed script
  keeps working against the library it was tested against.

Both consumers guard with `if (typeof MosesStackLang === 'undefined')` and
`console.error` rather than throwing, so a failed require degrades to "feature
off" instead of a broken page.

### Defensive DOM-selector pattern (used throughout)

ETHZ's exact Moodle/STACK theme HTML (ids, names, element types) isn't known
up front and can't be inspected directly (no live authenticated access), and
some fields (e.g. per-PRT feedback textareas) have no single stable
id/name. Both scripts therefore favor grabbing broadly and filtering/matching
safely over hardcoding brittle selectors:
- `moodle-stack-helper.user.js`'s `scanForTextareas()`/`registerTextarea()`
  grab every `<textarea>` on the page and filter to visible ones
  (`offsetParent !== null`), rather than listing selectors per field. Because
  PRT sections render collapsed, that filter has to be re-applied over time
  rather than once — hence the live `WeakSet` registry plus a debounced
  `MutationObserver` on `document.body`.
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

### `syntax-highlight.user.js` overlay design

A `<textarea>` renders plain text only, so highlighting means putting a
"mirror" element behind the field with the same text marked up in coloured
spans, and making the textarea's own text and background `transparent` so the
mirror shows through. The textarea is never replaced, re-parented, or written
to — which is what keeps native undo, Moodle's form-dirty tracking, and the
other three scripts (all of which require `event.target.tagName ===
'TEXTAREA'`) working. Replacing the textarea with a contenteditable, or
`@require`-ing CodeMirror/Monaco, would break all of that; both were
considered and rejected.

Non-obvious constraints, all of which are load-bearing:

- **The mirror goes *behind*, not in front — this was a shipped bug in
  v0.2.0, fixed in v0.2.1.** In front looks better on paper: the selection
  band shows through the mirror's transparent background, so selected text
  keeps its colours. But both engines paint selected text in the selection's
  own foreground colour, which overrides `color: transparent`, and **Firefox
  ignores `::selection` inside form controls**, so it cannot be suppressed
  there. The real text therefore reappeared behind the mirror's coloured text
  on any selection — two overlapping copies of the same glyphs. Behind, the
  textarea owns selection rendering entirely and it works everywhere with no
  `::selection` rule at all. The cost is that selected text loses its syntax
  colours while selected; that is the correct trade. Do not "improve" this
  back to a front overlay.
- **Going behind means the textarea's background must be transparent**, or it
  hides the mirror; the mirror paints the original `backgroundColor` instead.
  Border, focus ring and invalid-field styling still come from the textarea.
  It also means both elements must be positioned (`host` z-index 0, textarea
  `position: relative` + z-index 1) — a positioned element always paints above
  a static one regardless of DOM order, so z-index is the only way to put our
  host underneath.
- **The mirror lives in a shadow root.** Two reasons: Moodle ships Bootstrap,
  and a single page-level rule on `div`/`span` would shift the mirror by
  fractions of a pixel per line; and mutation records don't cross a shadow
  boundary, so rebuilding the mirror's `innerHTML` on every keystroke is
  invisible to `moodle-stack-helper.user.js`'s body-wide `MutationObserver`.
- **Colours come from the CSS Custom Highlight API, not `<span>`s.** Spans
  were the original approach and caused the third shipped bug: chopping a
  line into inline boxes stops kerning applying across the boundaries and
  snaps glyph advances to whole pixels per box, so the mirror lays out
  differently from the textarea's continuous run and the caret (drawn by the
  textarea) stops matching the glyphs (drawn by the mirror). Monospace hides
  it; a proportional font can't. `CSS.highlights` styles ranges and may only
  set properties that cannot affect layout, so the mirror holds a **single
  text node** and the problem is structurally impossible. Cost: no bold or
  italic, and errors use a background tint (Firefox doesn't support
  `text-decoration` on highlights). `renderTokens` (spans) is kept as a
  fallback and behind a menu command; `groupTokenSpans` is shared, and the
  offline suite asserts both renderers colour identical characters.
- **Monospace and no ligatures, on both sides** — only relevant to the
  `<span>` fallback now. Kerning and ligatures apply
  across a continuous text run in the textarea, but not across a span boundary
  in the mirror, so a proportional font drifts *within* a line by an amount
  that depends on where tokens happen to split. Prose fields keep Moodle's
  font and set `font-kerning: none` instead, which removes the dependency on
  the neighbouring glyph rather than the variable widths.
- **Do not use `[data-fieldtype="editor"]` to detect a rich-text field.**
  This was a shipped bug in v0.2.0. Moodle tags each form item with the
  element type declared in PHP, and Question text, General feedback and every
  PRT node's feedback are declared as `editor` elements — so that attribute is
  present regardless of which editor *plugin* renders them, including the
  "Plain text area" one that produces an ordinary `<textarea>`. Testing on it
  silently excluded every CASText field, i.e. exactly the fields the CASText
  tokenizer exists for. `hasRichEditorUi()` looks for the WYSIWYG UI itself
  (`.editor_atto_content`, `.tox-tinymce`, …) and fails **open**: attaching to
  a visible textarea is always safe, and the alignment check is the backstop.
- **The host is an absolutely positioned sibling**, with the parent made
  `position: relative` only if it was `static` (and restored on detach).
  Wrapping the textarea would re-parent it, which blurs it and can drop its
  native undo stack.
- **Size the host from `clientWidth`/`clientHeight`**, not `offsetWidth` —
  those exclude the scrollbar, which is what makes wrapping identical once the
  field is tall enough to scroll.
- **Render into a `<div>`, not a `<pre>`** — the HTML parser strips a newline
  immediately after a `<pre>` start tag, so a field beginning with a blank
  line would be permanently off by one line.
- **Every write to the textarea's own style happens once, at attach, before
  the style `MutationObserver` is installed.** That observer exists to catch
  `moodle-stack-helper.user.js` changing `fontSize`/`height` (there's no
  callback to hook); a later write of our own would make it loop forever.
- **`color: transparent` is only set after a first successful render and a
  passing alignment check**, and any later exception detaches and restores
  plain text. The failure mode to design against is "the user can't see what
  they're typing", and it must be unreachable.

There are two tokenizers. `tokenizeMaxima` handles `*variables*` fields.
`tokenizeCastext` handles the rest, and is a *dispatcher* rather than a
grammar — CASText is HTML with STACK `[[...]]` tags, inline CAS `{@ ... @}`
and LaTeX embedded in it, so at each position it works out which language it
is looking at and hands off. `{@ ... @}` contents go to `tokenizeMaxima` on a
sliced substring, with the returned positions shifted back into place; slicing
rather than teaching that tokenizer about bounds keeps it free of off-by-one
edge cases at the seam. `$...$` is deliberately not treated as maths (STACK's
docs say dollar delimiters are unsupported, and guessing misfires on prices).

Both tokenizers must emit tokens **in order and non-overlapping**, because the
renderer walks them linearly and fills the gaps with plain text. `renderTokens`
skips any token starting before the current position rather than trusting
them: a duplicated or dropped character in the mirror would show the user
something other than what they typed, which is the one genuinely dangerous
bug in this design.

The tokenizers emit a flat token array rather than an HTML string, because
rainbow brackets need retroactive classification: whether a `(` is matched
isn't known until its `)` (or EOF). A second linear pass relabels every
occurrence of a name that was ever an assignment target, which is what makes
user variables stand out everywhere rather than only where assigned. Tokens
whose colour equals the base text colour (plain identifiers, operators) are
emitted without a span at all — that roughly halves the generated markup.

There is no test tooling in this repo, but the tokenizers and renderer are
pure functions of a string and can be exercised offline by slicing them out
of the file and `new Function`-ing them; do that when changing them, rather
than relying on the user to notice a regression on a live page.

What that offline testing *cannot* reach is everything to do with layout,
painting and which fields get picked up — and both bugs shipped so far
(front-vs-behind overlay, and the `data-fieldtype` over-rejection) were in
exactly that blind spot, with a green test suite. Hence `reportFields()`,
exposed as a `GM_registerMenuCommand`: it prints every textarea with its
classification and the exact reason it was or wasn't attached. When a user
reports "it doesn't work", ask for that table first. The script also warns
by itself when a whole category of field (all Maxima, or all CASText) ends
up with no highlighting, which is the shape both bugs took.

### `stack-lint.user.js` rule design

Two severities, and the split is load-bearing rather than cosmetic. Errors are
definitely wrong; suggestions are things STACK accepts but advises against.
**The missing-semicolon check is a suggestion**, because STACK's docs say
plainly that semicolons are optional there ("Items are separated by either a
newline or `;`" / "Adding `;` … is optional … Please add these"). Errors sort
first so a wall of semicolon advice can't bury one unbalanced bracket, and
suggestions can be hidden from the menu.

The semicolon rule works over the token stream, never over raw lines, and
fires only when a line break separates two tokens where neither side is
continuing the expression (`CONTINUES_AFTER` / `CONTINUES_BEFORE`) and bracket
depth is 0. That is what keeps it quiet on blank and comment-only lines,
multi-line statements, `if`/`then` splits, and `block(...)` bodies where
commas do the separating. Any change here must keep the "SHOULD be silent"
half of the offline suite passing — false positives are far worse than misses,
since a linter that cries wolf gets turned off.

Two performance traps, both hit once already:
- Never call a `lineOf(src, pos)`-style helper per token; that is quadratic
  (35ms per keystroke on a 300-line field). Tokens are walked in order and
  their gaps don't overlap, so `hasLineBreakBetween(prev.end, token.start)`
  costs one pass in total. Line *numbers* are attached in a single later pass
  by `addLineNumbers`.
- Rules that need input/PRT names harvest them from the page and **skip
  themselves when the harvest is empty**, rather than guessing.

Structural problems (unbalanced brackets, unterminated strings, unclosed
blocks) are not re-derived here — the tokenizer already had to work them out
to colour the text, so it tags those tokens with a `problem` field and the
lint just translates them into messages. Re-deriving would only create a
chance to disagree with what the user can see.

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
