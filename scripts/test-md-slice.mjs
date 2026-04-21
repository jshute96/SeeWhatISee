#!/usr/bin/env node
// Fetch a web page (or read an HTML file), pick a few balanced HTML
// slices from the main content area, run each slice through the
// SeeWhatISee HTML→markdown converter, and print a structured
// report.
//
// Every slice is a concatenation of COMPLETE top-level children of
// the detected content container — no cut tags, no unbalanced
// opens, no bleed from sibling content. This mirrors what a real
// browser `window.getSelection()` produces: the DOM's cloneContents
// is always a balanced fragment, so slices made this way test the
// converter against the same shape of input it'll see in
// production.
//
// Usage:
//   scripts/test-md-slice.mjs <url-or-path> [options]
//
// Options:
//   --selector "<spec>"   Override main-content selector. Accepted
//                         forms: "article", "article.markdown-body",
//                         "#mw-content-text", ".mw-parser-output".
//                         When omitted, auto-detect (see
//                         DEFAULT_SELECTORS below).
//   --max-slices N        Cap the number of slices emitted (default 3).
//   --out <file>          Write report to a file instead of stdout.
//
// Exit codes:
//   0   Report written successfully (may still contain flagged issues).
//   1   Unrecoverable error (bad args, fetch failed, etc.).
//   2   Bot-challenge page detected (Cloudflare / captcha). The
//       report contains the diagnostic and invites the user to
//       paste the HTML manually and rerun with a file path.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { htmlToMarkdown, htmlToText } from '../dist/markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── CLI parsing ──────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { target: '', selector: null, maxSlices: 3, out: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selector') opts.selector = argv[++i];
    else if (a === '--max-slices') opts.maxSlices = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      usageAndExit(0);
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      usageAndExit(1);
    } else {
      rest.push(a);
    }
  }
  opts.target = rest[0] ?? '';
  if (!opts.target) usageAndExit(1);
  return opts;
}

function usageAndExit(code) {
  console.error(
    `Usage: test-md-slice.mjs <url-or-path> [--selector <spec>] ` +
    `[--max-slices N] [--out <file>]`,
  );
  process.exit(code);
}

// ─── Input acquisition ───────────────────────────────────────────

function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

function loadHtml(target) {
  if (isUrl(target)) return fetchUrl(target);
  const resolved = path.isAbsolute(target)
    ? target
    : path.resolve(process.cwd(), target);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No such file: ${resolved}`);
  }
  return { html: fs.readFileSync(resolved, 'utf8'), finalUrl: 'file://' + resolved };
}

function fetchUrl(url) {
  const res = spawnSync(
    'curl',
    ['-sSL', '-A', 'Mozilla/5.0 (X11; Linux x86_64) Chrome', url],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(
      `curl failed (exit ${res.status}): ${res.stderr?.trim() || 'no stderr'}`,
    );
  }
  const html = res.stdout;
  // Cheap bot-challenge heuristics. Cloudflare's interstitial and
  // common captcha pages share distinctive strings; trip on any.
  const challengeMarkers = [
    'Just a moment',
    'cf-challenge',
    'Attention Required! | Cloudflare',
    'Enable JavaScript and cookies to continue',
    'Please verify you are human',
  ];
  for (const m of challengeMarkers) {
    if (html.includes(m)) {
      const err = new Error(
        `Fetched a bot-challenge page (matched ${JSON.stringify(m)}). ` +
        `Save the rendered HTML manually and rerun with the file path.`,
      );
      err.code = 'BOT_CHALLENGE';
      throw err;
    }
  }
  return { html, finalUrl: url };
}

// ─── Normalize: strip noise so slicing is safe ────────────────────
//
// Scripts, styles, noscript, iframes, and SVG are stripped before
// tokenizing. They don't contribute to markdown conversion anyway
// (the converter's SKIP_ELEMENTS handles them) and removing them
// first simplifies the slicer — no need to worry about `<closer>`
// strings inside `<script>` bodies and friends.

function stripNoise(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, '');
}

// ─── Tokenizer with source positions ─────────────────────────────
//
// Mirrors the `parseHtml` tokenizer in `src/markdown.ts` but keeps
// `start` / `end` offsets into the source string so we can extract
// byte-exact balanced subtrees. Attribute quoting is respected so
// `href="1 > 2"` doesn't trick the tag-end detector.

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function* tokens(html) {
  let i = 0;
  const n = html.length;
  while (i < n) {
    const ch = html[i];
    if (ch !== '<') {
      const next = html.indexOf('<', i);
      const end = next < 0 ? n : next;
      if (end > i) yield { kind: 'text', start: i, end };
      i = end;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const endIdx = html.indexOf('-->', i + 4);
      const stop = endIdx < 0 ? n : endIdx + 3;
      yield { kind: 'comment', start: i, end: stop };
      i = stop;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const endIdx = html.indexOf('>', i);
      const stop = endIdx < 0 ? n : endIdx + 1;
      yield { kind: 'doctype', start: i, end: stop };
      i = stop;
      continue;
    }
    const isClose = html[i + 1] === '/';
    let j = i + 1;
    while (j < n) {
      const c = html[j];
      if (c === '"' || c === "'") {
        const q = c;
        j++;
        while (j < n && html[j] !== q) j++;
        j++;
        continue;
      }
      if (c === '>') break;
      j++;
    }
    if (j >= n) { i = n; break; }
    const tagEnd = j + 1;
    const inside = html.slice(i + (isClose ? 2 : 1), j);
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(inside);
    const tagName = nameMatch ? nameMatch[1].toLowerCase() : '';
    const selfClosing = !isClose && inside.trimEnd().endsWith('/');
    yield {
      kind: isClose ? 'close' : selfClosing ? 'self' : 'open',
      start: i,
      end: tagEnd,
      tagName,
      attrs: inside,
    };
    i = tagEnd;
  }
}

// ─── Selector matching ───────────────────────────────────────────

function parseSelector(spec) {
  // Accept forms: "tag", "tag.class", ".class", "#id", "tag#id".
  // Class / id matched as substring where indicated (class gets
  // substring match since GitHub uses `markdown-body container-lg`
  // and we want to match `markdown-body` without worrying about the
  // others).
  const s = spec.trim();
  const out = { tag: null, classSubstr: null, id: null };
  const parts = s.match(/^([a-zA-Z][\w-]*)?(?:[.#][\w-]+)*$/);
  if (!parts) throw new Error(`Bad selector: ${JSON.stringify(spec)}`);
  const tagMatch = s.match(/^([a-zA-Z][\w-]*)/);
  if (tagMatch) out.tag = tagMatch[1].toLowerCase();
  const cls = s.match(/\.([\w-]+)/);
  if (cls) out.classSubstr = cls[1];
  const id = s.match(/#([\w-]+)/);
  if (id) out.id = id[1];
  return out;
}

function matchesSelector(tok, sel) {
  if (sel.tag && tok.tagName !== sel.tag) return false;
  if (sel.classSubstr) {
    const m = /class\s*=\s*["']([^"']*)["']/i.exec(tok.attrs);
    if (!m) return false;
    const classes = m[1].split(/\s+/).filter(Boolean);
    if (!classes.some((c) => c.includes(sel.classSubstr))) return false;
  }
  if (sel.id) {
    const m = /id\s*=\s*["']([^"']*)["']/i.exec(tok.attrs);
    if (!m || m[1] !== sel.id) return false;
  }
  return true;
}

// ─── Find container ──────────────────────────────────────────────

const DEFAULT_SELECTORS = [
  'article.markdown-body',     // GitHub rendered .md file
  '.mw-parser-output',         // Wikipedia article body
  '#mw-content-text',          // Wikipedia outer content
  'article',                   // Generic blog articles
  'main',                      // HTML5 main landmark
  '.post-content',             // Medium / blog-ish
  'body',                      // Last resort
].map(parseSelector);

function findContainer(html, selectorOverride) {
  const selectors = selectorOverride ? [parseSelector(selectorOverride)] : DEFAULT_SELECTORS;
  for (const sel of selectors) {
    for (const tok of tokens(html)) {
      if (tok.kind !== 'open') continue;
      if (VOID_ELEMENTS.has(tok.tagName)) continue;
      if (!matchesSelector(tok, sel)) continue;
      const innerStart = tok.end;
      const innerEnd = findMatchingClose(html, innerStart, tok.tagName);
      if (innerEnd >= 0) {
        return {
          selector: sel,
          tag: tok.tagName,
          containerStart: tok.start,
          innerStart,
          innerEnd,
        };
      }
    }
  }
  return null;
}

function findMatchingClose(html, from, tagName) {
  let depth = 1;
  for (const tok of tokens(html.slice(from))) {
    if (tok.kind === 'open' && tok.tagName === tagName && !VOID_ELEMENTS.has(tagName)) {
      depth++;
    } else if (tok.kind === 'close' && tok.tagName === tagName) {
      depth--;
      if (depth === 0) return from + tok.start;
    }
  }
  return -1;
}

// ─── Enumerate top-level children of the container ───────────────

function enumerateTopLevelChildren(innerHtml) {
  const out = [];
  const stack = [];
  let childStart = -1;
  let childTag = '';
  for (const tok of tokens(innerHtml)) {
    if (stack.length === 0) {
      if (tok.kind === 'open') {
        childStart = tok.start;
        childTag = tok.tagName;
        if (VOID_ELEMENTS.has(tok.tagName)) {
          out.push({ start: childStart, end: tok.end, tag: childTag });
          childStart = -1;
        } else {
          stack.push(tok.tagName);
        }
      } else if (tok.kind === 'self') {
        out.push({ start: tok.start, end: tok.end, tag: tok.tagName });
      } else if (tok.kind === 'text') {
        const text = innerHtml.slice(tok.start, tok.end);
        if (text.trim().length > 0) {
          out.push({ start: tok.start, end: tok.end, tag: '#text' });
        }
      }
      // comments / doctypes are skipped at the top level
    } else {
      if (tok.kind === 'open' && !VOID_ELEMENTS.has(tok.tagName)) {
        stack.push(tok.tagName);
      } else if (tok.kind === 'close') {
        // Tolerant pop: if the stack's top doesn't match, pop through
        // mismatches (bad markup) until we find a match or empty the
        // stack. Mirrors the forgiving behavior of the markdown
        // converter's own parser.
        while (stack.length > 0 && stack[stack.length - 1] !== tok.tagName) {
          stack.pop();
        }
        if (stack.length > 0) stack.pop();
        if (stack.length === 0) {
          out.push({ start: childStart, end: tok.end, tag: childTag });
          childStart = -1;
        }
      }
    }
  }
  return out;
}

// ─── Pick slices ─────────────────────────────────────────────────
//
// Heuristic: aim for ≤ `maxSlices` non-overlapping slices, each
// roughly `minChars ≤ len ≤ maxChars`. Prefer slices containing
// "interesting" constructs so we exercise as many converter paths
// as one run allows.

const INTERESTING_TAGS = new Set([
  'pre', 'table', 'figure', 'blockquote', 'ul', 'ol', 'h1', 'h2', 'h3',
  'img', 'dl',
]);

function pickSlices(children, innerHtml, opts) {
  const { maxSlices = 3, minChars = 500, maxChars = 2500 } = opts;
  const slices = [];
  const used = new Set();

  function len(range) {
    return range.end - range.start;
  }

  function containsInteresting(range) {
    const segment = innerHtml.slice(range.start, range.end);
    for (const t of INTERESTING_TAGS) {
      if (new RegExp(`<${t}\\b`, 'i').test(segment)) return true;
    }
    return false;
  }

  // Given a starting index, extend forward until we hit maxChars or
  // run out of unused children. Returns [startI, endI) (exclusive).
  function extendFrom(startI) {
    let endI = startI;
    let total = 0;
    while (endI < children.length && total < maxChars && !used.has(endI)) {
      total += len(children[endI]);
      endI++;
    }
    return { startI, endI, total };
  }

  function addSlice(name, startI, endI) {
    if (startI >= endI) return;
    for (let i = startI; i < endI; i++) used.add(i);
    slices.push({
      name,
      html: innerHtml.slice(children[startI].start, children[endI - 1].end),
      firstTag: children[startI].tag,
      lastTag: children[endI - 1].tag,
      itemCount: endI - startI,
    });
  }

  // Slice 1: opening run.
  {
    const r = extendFrom(0);
    if (r.total >= minChars || children.length - r.startI === r.endI - r.startI) {
      addSlice('opening', r.startI, r.endI);
    }
  }

  // Slice 2..N: pick runs anchored on the first unused interesting
  // tag not already covered. Expand backward and forward to around
  // maxChars, preferring forward.
  while (slices.length < maxSlices) {
    let anchor = -1;
    for (let i = 0; i < children.length; i++) {
      if (used.has(i)) continue;
      if (containsInteresting(children[i])) { anchor = i; break; }
    }
    if (anchor < 0) break;
    const r = extendFrom(anchor);
    if (r.startI < r.endI) {
      addSlice(`rich-${children[anchor].tag}`, r.startI, r.endI);
    } else {
      used.add(anchor); // avoid re-picking the same anchor
    }
  }

  // One more from the tail if we still have budget and content.
  if (slices.length < maxSlices) {
    const tailStart = Math.floor(children.length * 2 / 3);
    let startI = tailStart;
    while (startI < children.length && used.has(startI)) startI++;
    if (startI < children.length) {
      const r = extendFrom(startI);
      if (r.total >= minChars) addSlice('tail', r.startI, r.endI);
    }
  }

  return slices;
}

// ─── Automated sanity checks on converter output ─────────────────

function checkOutput(md) {
  const issues = [];

  // Strip fenced code blocks before running the markdown-syntax
  // checks: any `###` or `<tag>` INSIDE a code fence is a literal
  // character, not a converter error. Leaving them in confuses
  // every check below (e.g. a Markdown tutorial emitted as a code
  // block trips the "empty heading" heuristic on `### `).
  const mdStripped = md.replace(/```[\s\S]*?```/g, '');

  // Unbalanced fenced code: count triple-backtick fences that start
  // a line. An odd count means at least one is unclosed.
  const fences = md.match(/^```/gm) ?? [];
  if (fences.length % 2 !== 0) {
    issues.push({
      severity: 'blocking',
      category: 'structure',
      message: `Unbalanced code fences (${fences.length} on their own lines — should be even).`,
    });
  }

  // Headings that rendered empty (e.g. `## \n`) — our converter
  // already drops these but a future regression would surface here.
  if (/^#{1,6}\s*$/m.test(mdStripped)) {
    issues.push({
      severity: 'significant',
      category: 'structure',
      message: 'Empty heading emitted.',
    });
  }

  // Leaked raw HTML tags — we intentionally allow `<u>...</u>` for
  // underlines since markdown has no equivalent. Anything else
  // indicates the converter unwrapped instead of handling.
  const leaked = mdStripped.match(/<\/?([a-z][a-z0-9]*)[ >/]/gi) ?? [];
  const leakedTags = new Set();
  for (const l of leaked) {
    const m = /<\/?([a-z][a-z0-9]*)/i.exec(l);
    if (m) leakedTags.add(m[1].toLowerCase());
  }
  leakedTags.delete('u'); // intentional fallback: no markdown equivalent.
  if (leakedTags.size > 0) {
    issues.push({
      severity: 'significant',
      category: 'structure',
      message: `Raw HTML tag(s) leaked into output: <${[...leakedTags].join('>, <')}>.`,
    });
  }

  // Raw entities that didn't get decoded.
  const entities = mdStripped.match(/&(amp|lt|gt|quot|apos|nbsp);/g) ?? [];
  if (entities.length > 0) {
    issues.push({
      severity: 'cosmetic',
      category: 'formatting',
      message: `Undecoded entities in output: ${[...new Set(entities)].join(', ')}.`,
    });
  }

  return issues;
}

// ─── Report writer ───────────────────────────────────────────────

function formatReport({ target, finalUrl, container, slices, reportIssues }) {
  const lines = [];
  lines.push(`# test-md-slice report`);
  lines.push('');
  lines.push(`- **Target:** ${target}`);
  if (finalUrl && finalUrl !== target) lines.push(`- **Resolved URL:** ${finalUrl}`);
  if (container) {
    const sel = container.selector;
    const label = [sel.tag, sel.classSubstr && `.${sel.classSubstr}`, sel.id && `#${sel.id}`]
      .filter(Boolean)
      .join('');
    lines.push(`- **Container:** \`<${container.tag}>\` matched by \`${label}\``);
  } else {
    lines.push(`- **Container:** (none found — no slices)`);
  }
  lines.push(`- **Slices:** ${slices.length}`);
  lines.push('');

  for (const [i, s] of slices.entries()) {
    lines.push(`## Slice ${i + 1}: ${s.name} (${s.itemCount} top-level child${s.itemCount === 1 ? '' : 'ren'}, ${s.html.length} chars)`);
    lines.push('');
    lines.push(`First / last child tag: \`<${s.firstTag}>\` … \`<${s.lastTag}>\``);
    lines.push('');
    lines.push(`### Input HTML (truncated to 600 chars)`);
    lines.push('```html');
    lines.push(s.html.length > 600 ? s.html.slice(0, 600) + '\n… [truncated] …' : s.html);
    lines.push('```');
    lines.push('');
    lines.push(`### Converter output`);
    lines.push('```');
    lines.push(s.output);
    lines.push('```');
    lines.push('');
    if (s.issues.length > 0) {
      lines.push(`### Automated flags`);
      for (const issue of s.issues) {
        lines.push(`- [${issue.severity}/${issue.category}] ${issue.message}`);
      }
      lines.push('');
    } else {
      lines.push('### Automated flags');
      lines.push('_No automated flags._');
      lines.push('');
    }
  }

  if (reportIssues.length > 0) {
    lines.push(`## Overall notes`);
    for (const note of reportIssues) lines.push(`- ${note}`);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ─── Main ────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let loaded;
  try {
    loaded = loadHtml(opts.target);
  } catch (err) {
    if (err.code === 'BOT_CHALLENGE') {
      writeOrPrint(opts.out, `# test-md-slice report\n\n**Target:** ${opts.target}\n\n**Error:** ${err.message}\n`);
      process.exit(2);
    }
    console.error(err.message);
    process.exit(1);
  }
  const { html, finalUrl } = loaded;
  const stripped = stripNoise(html);

  const reportIssues = [];

  const container = findContainer(stripped, opts.selector);
  if (!container) {
    writeOrPrint(
      opts.out,
      `# test-md-slice report\n\n**Target:** ${opts.target}\n\n` +
      `**Error:** No main-content container matched. Tried: ` +
      (opts.selector ?? DEFAULT_SELECTORS.map((s) => s.tag).join(', ')) + '.\n',
    );
    process.exit(1);
  }

  const inner = stripped.slice(container.innerStart, container.innerEnd);
  const children = enumerateTopLevelChildren(inner);
  if (children.length === 0) {
    reportIssues.push('Container has no top-level children — nothing to slice.');
  }

  const slices = pickSlices(children, inner, { maxSlices: opts.maxSlices });
  for (const s of slices) {
    s.output = htmlToMarkdown(s.html, finalUrl);
    s.issues = checkOutput(s.output);
  }

  if (slices.length === 0 && children.length > 0) {
    reportIssues.push('No slice met the minimum-length threshold; content is short or fragmented.');
  }

  const report = formatReport({
    target: opts.target,
    finalUrl,
    container,
    slices,
    reportIssues,
  });
  writeOrPrint(opts.out, report);
}

function writeOrPrint(out, text) {
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
  } else {
    process.stdout.write(text);
  }
}

main();
