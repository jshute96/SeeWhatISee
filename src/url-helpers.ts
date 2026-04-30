// Pure URL helpers, importable from anywhere. Kept free of DOM
// globals so they can be unit-tested directly via `node --test`.
// Add new helpers here as more URL-massaging utilities show up
// across the extension.

/**
 * Maximum length (counting the leading slash) for the path segment
 * surfaced by `firstUrlSegment`. Past this we truncate and append
 * `...` so a freakishly long slug doesn't widen menus or tooltips.
 */
const MAX_SEGMENT_LENGTH = 20;

/**
 * Extract the first path segment of `url` with its leading slash:
 *   `https://claude.ai/settings/profile` → `/settings`
 *   `https://claude.ai/recents` → `/recents`
 *   `https://example.com/` → `''` (no segment)
 *
 * Returns `''` for URLs whose pathname is `/` or empty, and for
 * unparseable inputs — the caller decides what to do with the
 * empty case.
 */
export function firstUrlSegment(url: string): string {
  try {
    const m = new URL(url).pathname.match(/^\/[^/]+/);
    if (!m) return '';
    const seg = m[0];
    if (seg.length <= MAX_SEGMENT_LENGTH) return seg;
    return seg.slice(0, MAX_SEGMENT_LENGTH) + '...';
  } catch {
    return '';
  }
}

/**
 * Build the italic suffix the Ask menu shows next to an excluded
 * tab. When we can derive a first path segment (most cases) we
 * include it so the user sees *which* sub-page the tab is on at a
 * glance; otherwise we fall back to the bare label.
 */
export function excludedSuffix(url: string): string {
  const seg = firstUrlSegment(url);
  return seg ? `(Wrong page: ${seg})` : '(Wrong page)';
}
