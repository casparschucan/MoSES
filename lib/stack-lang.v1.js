// ---------------------------------------------------------------------------
// MoSES shared library: the STACK question languages
// ---------------------------------------------------------------------------
//
// This file is NOT a userscript - it has no ==UserScript== metadata block and
// Tampermonkey will not run it on its own. It is pulled into the scripts that
// need it with:
//
//   // @require https://raw.githubusercontent.com/casparschucan/MoSES/main/lib/stack-lang.v1.js
//
// Tampermonkey concatenates a @require'd file into the *same* scope as the
// script that requires it, so the top-level `var` below is simply visible to
// that script. Nothing is added to the page's globals, and each userscript
// sandbox gets its own copy, so two scripts requiring this cannot interfere.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// The repo's rule is one standalone .user.js per feature, sharing code only
// via @require and only when the logic is genuinely shared. This qualifies:
// syntax-highlight.user.js and stack-lint.user.js must agree *exactly* on how
// a field is tokenised. If they drifted apart, the lint would report an error
// at a position the highlighting says is the middle of a string - which is
// worse than either of them being wrong on its own.
//
// VERSIONING - PLEASE READ BEFORE EDITING
// ---------------------------------------------------------------------------
// Tampermonkey caches @require'd URLs aggressively, so the version lives in
// the FILENAME rather than in a metadata field. Two rules follow:
//
//   * Any change here must also bump the @version of every script that
//     requires it, in the same commit, or Tampermonkey has no reason to
//     re-fetch anything and the change silently does nothing.
//   * A change that breaks an existing caller needs a NEW FILENAME
//     (stack-lang.v2.js) and updated @require lines, so an installed script
//     keeps working against the library it was tested with.
//
// This fails silently when forgotten, exactly like a missed @version bump.
// ---------------------------------------------------------------------------

var MosesStackLang = (function () {
  'use strict';
  const KEYWORDS = new Set([
    'if', 'then', 'else', 'elseif', 'and', 'or', 'not', 'block', 'for', 'do',
    'while', 'thru', 'step', 'unless', 'next', 'return', 'true', 'false', 'done',
    'in', 'from',
  ]);

  // Deliberately modest and STACK-flavoured. Anything starting with "stack_"
  // is treated as a builtin too, without having to list them all.
  const BUILTINS = new Set([
    'sqrt', 'exp', 'log', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'abs',
    'float', 'ratsimp', 'radcan', 'factor', 'expand', 'simp', 'ev', 'subst',
    'matrix', 'transpose', 'determinant', 'invert', 'sum', 'product', 'diff',
    'integrate', 'limit', 'solve', 'rand', 'random', 'makelist', 'append',
    'length', 'first', 'last', 'rest', 'reverse', 'sort', 'map', 'apply',
    'lambda', 'sublist', 'setify', 'cons', 'part', 'num', 'denom', 'sconcat',
    'string', 'print', 'error',
  ]);

  const PAIR = { '(': ')', '[': ']', '{': '}' };

  // Longest first, so ":=" is never mistaken for ":" followed by "=".
  const OPERATORS = [
    '::=', ':=', '::', '<=', '>=', '^^', '#',
    '+', '-', '*', '/', '^', '=', '<', '>', ':', '!', ',', '.', "'", '@',
  ];

  // Sticky (/y) regexes match only at lastIndex, so they can be used as
  // "does a number/identifier start exactly here?" without slicing the string.
  const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eEbdf][+-]?\d+)?/y;
  const IDENT_RE = /[A-Za-z_%][A-Za-z0-9_%]*/y;

  // ---------------------------------------------------------------------
  // Field classification
  // ---------------------------------------------------------------------

  /**
   * Which textareas are Maxima code? The repo already has exactly one way to
   * tell a "Maxima code field" from an "HTML content field", in
   * auto-close-html-tags.user.js: whether the id/name contains "variables".
   * That covers Question variables (id_questionvariables) and every PRT's
   * Feedback variables. We use the same test, inverted, so the two scripts
   * cannot disagree about which field is which.
   */
  function isMaximaField(textarea) {
    const key = (textarea.id + ' ' + textarea.name).toLowerCase();
    return key.includes('variables');
  }

  /**
   * 'maxima'  - Question variables, each PRT's Feedback variables
   * 'castext' - Question text, General feedback, each PRT node's feedback:
   *             HTML with STACK [[...]] tags, inline CAS {@ ... @} and LaTeX
   *             mixed into it
   */
  function fieldMode(textarea) {
    return isMaximaField(textarea) ? 'maxima' : 'castext';
  }

  /**
   * Is a rich-text editor actually *running* on this field?
   *
   * The obvious test - `textarea.closest('[data-fieldtype="editor"]')` - is
   * wrong, and was a shipped bug in v0.2.0. Moodle tags each form item with
   * the element type declared in PHP, and Question text, General feedback
   * and every PRT node's feedback are all declared as `editor` elements.
   * That attribute is therefore present no matter which editor *plugin*
   * renders them - including the "Plain text area" one, which produces an
   * ordinary <textarea> that we very much do want to highlight. Using it as
   * the test silently excluded every CASText field on the form, i.e. exactly
   * the set of fields the CASText tokenizer exists for.
   *
   * So look for the WYSIWYG UI itself instead. If one is present, the real
   * textarea is hidden behind it and highlighting it would be invisible
   * work; if it isn't, this is a plain textarea and we should proceed. This
   * deliberately fails open - attaching to a visible textarea is always
   * safe, and the alignment check is the real backstop.
   */
  const RICH_EDITOR_UI_SELECTOR =
    '.editor_atto_content, .editor_atto_toolbar, .tox-tinymce, .tox-edit-area, .cke_contents';

  function hasRichEditorUi(textarea) {
    const field =
      textarea.closest('[data-fieldtype], .fitem, .form-group') || textarea.parentElement;
    return Boolean(field && field.querySelector(RICH_EDITOR_UI_SELECTOR));
  }

  // ---------------------------------------------------------------------
  // Maxima tokenizer
  // ---------------------------------------------------------------------

  function nextNonSpaceChar(src, from) {
    let j = from;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t')) {
      j++;
    }
    return src[j];
  }

  function matchOperator(src, i) {
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) {
        return op;
      }
    }
    return null;
  }

  /**
   * When we hit an assignment operator (`:` or `:=`), the thing being
   * assigned to is whatever significant token came immediately before it.
   * Usually that's a bare identifier (`x : 1`), but it can also be the
   * closing bracket of `a[1] : 1` or of `f(x) := ...` - and because the
   * tokenizer already recorded which open bracket each closer matches, we
   * can jump straight to the token before that opener instead of rescanning.
   */
  function markAssignmentTarget(tokens, lastIdx, assigned, assignments) {
    if (lastIdx < 0) {
      return;
    }
    const token = tokens[lastIdx];
    let nameIdx = -1;

    if (token.cls === 'ident' || token.cls === 'call' || token.cls === 'builtin') {
      nameIdx = lastIdx;
    } else if (token.cls === 'close' && token.match !== undefined) {
      const before = token.match - 1;
      if (before >= 0) {
        const candidate = tokens[before];
        if (
          candidate.cls === 'ident' ||
          candidate.cls === 'call' ||
          candidate.cls === 'builtin'
        ) {
          nameIdx = before;
        }
      }
    }

    if (nameIdx < 0) {
      return;
    }
    const target = tokens[nameIdx];
    target.cls = target.cls === 'call' ? 'funcdef' : 'assign';
    assigned.add(target.word);
    assignments.push({ word: target.word, start: target.start, end: target.end });
  }

  /**
   * Single-pass scanner producing a flat array of { start, end, cls } records.
   *
   * Why a token array rather than emitting HTML as we go: rainbow brackets
   * need retroactive classification. You don't know whether a "(" is matched
   * until you reach its ")" - or until the end of the field, at which point
   * it becomes an error - and by then a string-emitting scanner would have
   * already flushed it. With an array we just write tokens[i].cls later.
   *
   * Tokens don't have to be contiguous: whatever falls between them is
   * emitted as plain text, so whitespace costs nothing.
   */
  function tokenizeMaxima(src) {
    const tokens = [];
    const openStack = [];
    const assigned = new Set();
    const assignments = [];
    const len = src.length;
    let i = 0;
    let last = -1; // index of the last *significant* token (comments don't count)

    while (i < len) {
      const c = src[i];

      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++;
        continue;
      }

      // Block comments. Maxima's /* */ comments NEST, so we count depth
      // rather than stopping at the first */.
      if (c === '/' && src[i + 1] === '*') {
        const start = i;
        let depth = 0;
        while (i < len) {
          if (src[i] === '/' && src[i + 1] === '*') {
            depth++;
            i += 2;
          } else if (src[i] === '*' && src[i + 1] === '/') {
            depth--;
            i += 2;
            if (depth === 0) {
              break;
            }
          } else {
            i++;
          }
        }
        tokens.push(
          depth === 0
            ? { start, end: i, cls: 'comment' }
            : { start, end: i, cls: 'error', problem: 'unterminated-comment' }
        );
        continue; // deliberately does NOT update `last`
      }

      if (c === '"') {
        const start = i;
        let closed = false;
        i++;
        while (i < len) {
          if (src[i] === '\\') {
            i += 2;
            continue;
          }
          if (src[i] === '"') {
            i++;
            closed = true;
            break;
          }
          i++;
        }
        last =
          tokens.push(
            closed
              ? { start, end: i, cls: 'string' }
              : { start, end: i, cls: 'error', problem: 'unterminated-string' }
          ) - 1;
        continue;
      }

      if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        NUMBER_RE.lastIndex = i;
        const match = NUMBER_RE.exec(src);
        if (match) {
          const start = i;
          i += match[0].length;
          last = tokens.push({ start, end: i, cls: 'number' }) - 1;
          continue;
        }
      }

      if (c === ';' || c === '$') {
        const start = i;
        i++;
        last = tokens.push({ start, end: i, cls: 'terminator', op: c }) - 1;
        continue;
      }

      if (c === '(' || c === '[' || c === '{') {
        const start = i;
        i++;
        const idx =
          tokens.push({ start, end: i, cls: 'open', ch: c, depth: openStack.length }) - 1;
        openStack.push(idx);
        last = idx;
        continue;
      }

      if (c === ')' || c === ']' || c === '}') {
        const start = i;
        i++;
        const idx = tokens.push({ start, end: i, cls: 'close', ch: c }) - 1;
        const openIdx = openStack.pop();
        if (openIdx === undefined) {
          tokens[idx].cls = 'error'; // a closer with nothing to close
          tokens[idx].problem = 'unmatched-close';
        } else if (PAIR[tokens[openIdx].ch] !== c) {
          tokens[idx].cls = 'error'; // ( closed by ], etc
          tokens[idx].problem = 'mismatched-bracket';
          tokens[openIdx].cls = 'error';
          tokens[openIdx].problem = 'mismatched-bracket';
        } else {
          tokens[idx].depth = tokens[openIdx].depth;
          tokens[idx].match = openIdx;
          tokens[openIdx].match = idx;
        }
        last = idx;
        continue;
      }

      IDENT_RE.lastIndex = i;
      const identMatch = IDENT_RE.exec(src);
      if (identMatch) {
        const word = identMatch[0];
        const start = i;
        i += word.length;
        let cls;
        if (KEYWORDS.has(word)) {
          cls = 'keyword';
        } else if (BUILTINS.has(word) || word.startsWith('stack_') || word.startsWith('%')) {
          cls = 'builtin';
        } else if (nextNonSpaceChar(src, i) === '(') {
          cls = 'call';
        } else {
          cls = 'ident';
        }
        last = tokens.push({ start, end: i, cls, word }) - 1;
        continue;
      }

      const op = matchOperator(src, i);
      if (op) {
        const start = i;
        i += op.length;
        const idx = tokens.push({ start, end: i, cls: 'operator', op }) - 1;
        if (op === ':' || op === ':=' || op === '::' || op === '::=') {
          markAssignmentTarget(tokens, last, assigned, assignments);
        }
        last = idx;
        continue;
      }

      i++; // unrecognised character - render it as plain text
    }

    // Anything still open at the end was never closed.
    while (openStack.length) {
      const unclosed = tokens[openStack.pop()];
      unclosed.cls = 'error';
      unclosed.problem = 'unclosed-bracket';
    }

    // Relabel pass. This is what makes a variable you defined stand out
    // *everywhere it appears*, not just where it was assigned - which is the
    // whole point of colouring variables distinctly from the language.
    for (const token of tokens) {
      if (!token.word || !assigned.has(token.word)) {
        continue;
      }
      if (token.cls === 'ident' || token.cls === 'builtin') {
        token.cls = 'var';
      } else if (token.cls === 'call') {
        token.cls = 'userfunc';
      }
    }

    return { tokens, assigned, assignments };
  }

  // ---------------------------------------------------------------------
  // CASText tokenizer (Question text, feedback)
  // ---------------------------------------------------------------------

  /**
   * The [[...]] verbs STACK actually recognises, per its documentation.
   * Anything else gets a "this looks like a typo" colour rather than being
   * silently accepted - which is the cheapest possible spell-checker for the
   * one part of the syntax you can't get wrong quietly.
   */
  const STACK_VERBS = new Set([
    'input', 'validation', 'feedback', 'comment', 'if', 'else', 'elif',
    'foreach', 'define', 'reveal', 'hint', 'adapt', 'todo', 'debug', 'lang',
    'format', 'textdownload', 'include', 'quid', 'template', 'jsxgraph',
    'jsstring', 'geogebra', 'parsons', 'javascript', 'ascii', 'iframe',
    'style', 'script', 'facts', 'score',
  ]);

  // Verbs that must be closed with a matching [[/verb]]. input/validation/
  // feedback/define/debug stand alone and must NOT be flagged as unclosed.
  const STACK_BLOCK_VERBS = new Set([
    'comment', 'if', 'foreach', 'reveal', 'hint', 'adapt', 'todo', 'lang',
    'format', 'textdownload', 'include', 'quid', 'template', 'jsxgraph',
    'jsstring', 'geogebra', 'parsons', 'javascript', 'ascii', 'iframe',
    'style', 'script', 'facts',
  ]);

  const STACK_HEAD_RE = /^(\s*)(\/?)\s*([A-Za-z_][A-Za-z0-9_-]*)/;
  const STACK_NAME_RE = /^:\s*([A-Za-z0-9_]+)/;
  const STACK_ATTR_RE = /^[A-Za-z_][A-Za-z0-9_-]*/;
  const HTML_HEAD_RE = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;
  const HTML_ATTR_RE = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*/;
  const ENTITY_RE = /^&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;

  /**
   * `{@ ... @}` renders a CAS expression as LaTeX, `{# ... #}` as raw Maxima.
   * Either way the contents are Maxima, so we hand them to the Maxima
   * tokenizer and shift the resulting positions back into place. Slicing the
   * substring rather than teaching that tokenizer about bounds keeps it free
   * of off-by-one edge cases at the seam.
   */
  function emitInlineCas(tokens, src, start) {
    const closer = src[start + 1] + '}';
    const innerStart = start + 2;
    const closeAt = src.indexOf(closer, innerStart);
    if (closeAt === -1) {
      tokens.push({ start, end: src.length, cls: 'error', problem: 'unterminated-cas' });
      return src.length;
    }
    tokens.push({ start, end: innerStart, cls: 'cas-delim' });
    for (const token of tokenizeMaxima(src.slice(innerStart, closeAt)).tokens) {
      token.start += innerStart;
      token.end += innerStart;
      tokens.push(token);
    }
    tokens.push({ start: closeAt, end: closeAt + 2, cls: 'cas-delim' });
    return closeAt + 2;
  }

  /**
   * Whatever follows the verb inside a [[...]] tag: the `:ansN` / `:prtN`
   * name, and any key="value" attributes.
   */
  function emitTagRemainder(tokens, src, from, to) {
    let i = from;
    while (i < to) {
      const c = src[i];
      const rest = src.slice(i, to);

      if (c === ':') {
        const match = STACK_NAME_RE.exec(rest);
        if (match) {
          const nameStart = i + match[0].length - match[1].length;
          tokens.push({ start: i, end: nameStart, cls: 'stack-delim' });
          tokens.push({ start: nameStart, end: nameStart + match[1].length, cls: 'stack-name' });
          i += match[0].length;
          continue;
        }
      }

      if (c === '"' || c === "'") {
        const quote = src.indexOf(c, i + 1);
        const end = quote === -1 || quote >= to ? to : quote + 1;
        tokens.push({ start: i, end, cls: 'string' });
        i = end;
        continue;
      }

      const attr = STACK_ATTR_RE.exec(rest);
      if (attr) {
        tokens.push({ start: i, end: i + attr[0].length, cls: 'stack-attr' });
        i += attr[0].length;
        continue;
      }

      i++;
    }
  }

  function emitStackTag(tokens, src, start, blockStack, tags) {
    const closeAt = src.indexOf(']]', start + 2);
    if (closeAt === -1) {
      tokens.push({ start, end: src.length, cls: 'error', problem: 'unterminated-tag' });
      return src.length;
    }
    const end = closeAt + 2;
    const inner = src.slice(start + 2, closeAt);
    const head = STACK_HEAD_RE.exec(inner);
    if (!head) {
      tokens.push({ start, end, cls: 'error', problem: 'empty-tag' }); // [[ ]] with no verb
      return end;
    }

    const verb = head[3];
    const isCloser = head[2] === '/';
    const verbStart = start + 2 + head[0].length - verb.length;
    const verbEnd = verbStart + verb.length;

    tokens.push({ start, end: verbStart, cls: 'stack-delim' });
    const known = STACK_VERBS.has(verb);
    const verbToken = {
      start: verbStart,
      end: verbEnd,
      cls: known ? 'stack-keyword' : 'stack-unknown',
      verb,
    };
    const verbIdx = tokens.push(verbToken) - 1;

    // Track [[if]]...[[/if]] style pairing so an unclosed or stray block
    // shows up immediately. `[[ define x=1 /]]` closes itself, and
    // input/validation/feedback never take a closer at all.
    if (known && STACK_BLOCK_VERBS.has(verb) && !/\/\s*$/.test(inner)) {
      if (isCloser) {
        const openIdx = blockStack.pop();
        if (openIdx === undefined || tokens[openIdx].verb !== verb) {
          verbToken.cls = 'error';
          verbToken.problem = 'stray-close';
          if (openIdx !== undefined) {
            blockStack.push(openIdx); // a mismatch doesn't close the opener
          }
        }
      } else {
        blockStack.push(verbIdx);
      }
    }

    const nameMatch = /^\s*:\s*([A-Za-z0-9_]*)/.exec(src.slice(verbEnd, closeAt));
    const tag = {
      verb,
      known,
      isCloser,
      selfClosing: /\/\s*$/.test(inner),
      name: nameMatch ? nameMatch[1] : null,
      nameStart: nameMatch ? verbEnd + nameMatch[0].length - nameMatch[1].length : -1,
      start,
      end,
      verbStart,
    };
    tags.push(tag);

    emitTagRemainder(tokens, src, verbEnd, closeAt);
    tokens.push({ start: closeAt, end, cls: 'stack-delim' });
    return end;
  }

  function emitHtmlTag(tokens, src, start) {
    const gt = src.indexOf('>', start);
    if (gt === -1) {
      return start + 1; // a bare '<' in prose - leave it as plain text
    }
    const head = HTML_HEAD_RE.exec(src.slice(start, gt + 1));
    if (!head) {
      return start + 1;
    }

    const nameEnd = start + head[0].length;
    tokens.push({ start, end: nameEnd, cls: 'tag' });

    let i = nameEnd;
    while (i < gt) {
      const c = src[i];
      if (c === '"' || c === "'") {
        const quote = src.indexOf(c, i + 1);
        const end = quote === -1 || quote > gt ? gt : quote + 1;
        tokens.push({ start: i, end, cls: 'string' });
        i = end;
        continue;
      }
      const attr = HTML_ATTR_RE.exec(src.slice(i, gt));
      if (attr) {
        tokens.push({ start: i, end: i + attr[0].length, cls: 'attr' });
        i += attr[0].length;
        continue;
      }
      i++;
    }

    tokens.push({ start: gt, end: gt + 1, cls: 'tag' });
    return gt + 1;
  }

  /**
   * CASText is HTML with three other languages embedded in it, so this is a
   * dispatcher rather than a grammar: at each position, work out which of
   * them we're looking at and hand off.
   *
   * The one piece of real state is `mathCloser`. Inside \( ... \) or
   * \[ ... \] everything is maths and gets one colour - except embedded
   * {@ ... @}, which STACK routinely puts inside LaTeX and which should keep
   * its CAS colours. So the loop stays in "maths mode" until it sees the
   * closing delimiter, flushing runs of plain maths text as it goes.
   *
   * Note that $...$ is deliberately NOT treated as maths: STACK's docs say
   * dollar delimiters are unsupported, and guessing would misfire on any
   * question that mentions a price.
   */
  function tokenizeCastext(src) {
    const tokens = [];
    const blockStack = [];
    const tags = [];
    const mathRanges = [];
    const len = src.length;
    let i = 0;
    let mathCloser = null;
    let mathDelimIdx = -1;
    let mathStart = -1;
    let mathTextStart = -1;

    function flushMathText(end) {
      if (mathTextStart >= 0 && end > mathTextStart) {
        tokens.push({ start: mathTextStart, end, cls: 'math' });
      }
      mathTextStart = -1;
    }

    while (i < len) {
      const c = src[i];

      if (mathCloser && src.startsWith(mathCloser, i)) {
        flushMathText(i);
        tokens.push({ start: i, end: i + mathCloser.length, cls: 'math-delim' });
        i += mathCloser.length;
        mathRanges.push({ start: mathStart, end: i });
        mathCloser = null;
        mathDelimIdx = -1;
        continue;
      }

      if (c === '{' && (src[i + 1] === '@' || src[i + 1] === '#')) {
        flushMathText(i);
        i = emitInlineCas(tokens, src, i);
        if (mathCloser) {
          mathTextStart = i;
        }
        continue;
      }

      if (mathCloser) {
        // STACK tags are still recognised inside a LaTeX region. They must
        // not be used there - the documentation is explicit - but they are
        // parsed, so treating them as ordinary maths text would both lose
        // the colouring and make the linter think an [[input:ansN]] written
        // inside \( \) simply doesn't exist, which would then produce a
        // bogus "this validation tag has no input" on the matching tag.
        if (c === '[' && src[i + 1] === '[') {
          flushMathText(i);
          i = emitStackTag(tokens, src, i, blockStack, tags);
          mathTextStart = i;
          continue;
        }
        if (mathTextStart < 0) {
          mathTextStart = i;
        }
        i++;
        continue;
      }

      if (c === '\\' && (src[i + 1] === '(' || src[i + 1] === '[')) {
        mathCloser = src[i + 1] === '(' ? '\\)' : '\\]';
        mathDelimIdx = tokens.push({ start: i, end: i + 2, cls: 'math-delim' }) - 1;
        mathStart = i;
        i += 2;
        mathTextStart = i;
        continue;
      }

      if (c === '[' && src[i + 1] === '[') {
        i = emitStackTag(tokens, src, i, blockStack, tags);
        continue;
      }

      if (c === '<' && src.startsWith('<!--', i)) {
        const close = src.indexOf('-->', i + 4);
        const end = close === -1 ? len : close + 3;
        tokens.push(
          close === -1
            ? { start: i, end, cls: 'error', problem: 'unterminated-html-comment' }
            : { start: i, end, cls: 'comment' }
        );
        i = end;
        continue;
      }

      if (c === '<') {
        const next = emitHtmlTag(tokens, src, i);
        i = next > i ? next : i + 1;
        continue;
      }

      if (c === '&') {
        const entity = ENTITY_RE.exec(src.slice(i, i + 12));
        if (entity) {
          tokens.push({ start: i, end: i + entity[0].length, cls: 'entity' });
          i += entity[0].length;
          continue;
        }
      }

      i++;
    }

    flushMathText(len);
    if (mathDelimIdx >= 0) {
      tokens[mathDelimIdx].cls = 'error'; // a \( that was never closed
      tokens[mathDelimIdx].problem = 'unterminated-math';
      mathRanges.push({ start: mathStart, end: len });
    }
    for (const openIdx of blockStack) {
      tokens[openIdx].cls = 'error'; // a [[block]] that was never closed
      tokens[openIdx].problem = 'unclosed-block';
    }

    return { tokens, tags, mathRanges };
  }


  /**
   * What this question's inputs, potential response trees and CAS variables
   * are called, scraped from the form itself.
   *
   * Shared rather than duplicated because the scripts must agree: if the
   * linter says [[feedback:prt9]] refers to a PRT that doesn't exist while
   * the autocomplete happily offers prt9, neither can be trusted.
   *
   * Three sources, in descending order of how much they assume about ETHZ's
   * HTML - which is deliberately very little, since the live page can't be
   * inspected from the repo:
   *
   *   inputNames     - from the [[input:...]] tags actually written in the
   *                    CASText fields. Assumes nothing about Moodle at all.
   *   variableNames  - whatever the Maxima fields assign to, via the same
   *                    tokenizer that colours them.
   *   prtNames       - from textarea names ending "feedbackvariables", the
   *                    one naming convention this repo already relies on.
   *                    Works even while a PRT section is collapsed, because
   *                    the element is in the DOM whether or not it's shown.
   *
   * Any of the three can legitimately come back empty on an unfamiliar form.
   * Callers must therefore SKIP rules that depend on an empty set rather
   * than concluding anything from it - reporting "no such PRT" because we
   * failed to find the PRTs would be worse than staying quiet.
   */
  function harvestNames() {
    const inputNames = new Set();
    const prtNames = new Set();
    const variableNames = new Set();
    const inputTag = /\[\[\s*input\s*:\s*([A-Za-z0-9_]+)/g;

    for (const textarea of document.querySelectorAll('textarea')) {
      const key = (textarea.id + ' ' + textarea.name).toLowerCase();
      const prtMatch = /([a-z0-9]+)feedbackvariables/.exec(key);
      if (prtMatch) {
        prtNames.add(prtMatch[1]);
      }

      if (isMaximaField(textarea)) {
        if (textarea.value.length <= 100000) {
          for (const word of tokenizeMaxima(textarea.value).assigned) {
            variableNames.add(word);
          }
        }
        continue;
      }

      inputTag.lastIndex = 0;
      let match;
      while ((match = inputTag.exec(textarea.value)) !== null) {
        inputNames.add(match[1]);
      }
    }

    return { inputNames, prtNames, variableNames };
  }

  return {
    VERSION: 'stack-lang.v1',
    KEYWORDS,
    BUILTINS,
    STACK_VERBS,
    STACK_BLOCK_VERBS,
    isMaximaField,
    fieldMode,
    hasRichEditorUi,
    harvestNames,
    tokenizeMaxima,
    tokenizeCastext,
  };
})();
