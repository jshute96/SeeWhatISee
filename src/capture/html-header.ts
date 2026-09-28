// Header lines for captured HTML bodies, so the saved files open and
// read like Chrome's own "Save page as" output.
//
// Page HTML gets a "Mark of the Web" comment after its doctype:
//
//   <!-- saved from url=(0023)https://www.google.com/ -->
//
// The `(NNNN)` is the URL's length, zero-padded to four digits. The
// comment was an Internet Explorer convention (IE ran the local file
// under the security zone of that URL); modern Chrome ignores it when
// opening files. We add it purely for provenance: anyone opening a
// bare `contents-*.html` can see where it came from.
//
// Selection HTML is a fragment, so it gets just the page's doctype
// (none if the page has none). Without one, a browser opens the file
// in quirks mode (legacy layout rules), which may not match the page.
//
// Both are added when the capture is built, so they're part of the
// body the Edit dialogs show: what you see there is what gets saved,
// and deleting the line there keeps it out of the file.

// Leading `<!DOCTYPE ...>` (plus one trailing newline, if present).
const DOCTYPE_RE = /^\s*<!doctype[^>]*>\r?\n?/i;
// The comment line itself, as we (and Chrome) write it.
const COMMENT_RE = /^<!--\s*saved from url=[^\n]*?-->/i;

/**
 * Insert the `saved from url=` comment after the doctype (or at the
 * top when there is none). No-op for an empty body or URL, or when
 * the body already carries the comment at that spot.
 */
export function addSavedFromComment(html: string, url: string): string {
  if (!html || !url) return html;
  const at = DOCTYPE_RE.exec(html)?.[0].length ?? 0;
  if (COMMENT_RE.test(html.slice(at))) return html;
  // `--` would end the comment early. Percent-encoding the dashes
  // keeps the URL equivalent.
  const safeUrl = url.replace(/--/g, '%2D%2D');
  const len = String(safeUrl.length).padStart(4, '0');
  const comment = `<!-- saved from url=(${len})${safeUrl} -->\n`;
  const doctype = html.slice(0, at);
  const sep = doctype && !doctype.endsWith('\n') ? '\n' : '';
  return doctype + sep + comment + html.slice(at);
}

/**
 * Prefix an HTML fragment with the page's serialized `doctype` ('' for
 * none). A blank body stays as-is: the Capture page reads that as "no
 * saveable HTML for this selection", and a doctype would hide it.
 */
export function addHtmlDoctype(fragment: string, doctype: string): string {
  if (!doctype || !fragment.trim() || DOCTYPE_RE.test(fragment)) return fragment;
  return `${doctype}\n${fragment}`;
}
