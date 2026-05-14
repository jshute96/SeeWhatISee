// Pre-flight quota checks for `chrome.storage.session`.
//
// MV3 service workers get a 10 MiB session-storage budget by default
// (`chrome.storage.session.QUOTA_BYTES`). We park two large blobs in
// there:
//
//   - the per-tab Capture-page session (raw screenshot data URL +
//     scraped HTML), keyed by Capture-page tab id, and
//   - the per-tab Ask widget record (a copy of the same screenshot,
//     plus selection text), keyed by destination AI tab id.
//
// Either alone can be a few MB; together for one Ask they brush up
// against the cap. When `set()` fails for quota, Chrome rejects with
// a generic "Session storage quota bytes exceeded. Values were not
// stored." — and on some code paths that rejection was getting
// swallowed and surfacing as a misleading "Cancelled" later. This
// module estimates whether a write will fit *before* we attempt it
// (and before we open destination tabs), so we can refuse with a
// targeted message like "the screenshot is too large".
//
// The estimate is intentionally conservative: it uses
// `JSON.stringify(value).length + key.length` as the byte cost, which
// matches Chrome's own accounting for plain JSON values. It does not
// try to model concurrent writes from other paths — quota races are
// still possible, so callers should still handle a `set()` rejection
// at the actual write site.

const DEFAULT_SESSION_QUOTA_BYTES = 10 * 1024 * 1024;

function quotaBytes(): number {
  // `QUOTA_BYTES` is exposed on the area object at runtime. Older
  // Chrome / non-Chrome runtimes (some Playwright setups during
  // tests) may not expose it; fall back to the documented default.
  const declared = (chrome.storage.session as { QUOTA_BYTES?: number })
    .QUOTA_BYTES;
  return typeof declared === 'number' && declared > 0
    ? declared
    : DEFAULT_SESSION_QUOTA_BYTES;
}

/** Bytes a `set({ [key]: value })` would consume. Mirrors Chrome's
 *  own JSON-based accounting. */
export function estimateRecordBytes(key: string, value: unknown): number {
  return key.length + JSON.stringify(value).length;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  // Drop a trailing `.0` so an exact 10 MiB cap reads "10 MB" rather
  // than "10.0 MB" — the decimal is only useful when the value isn't
  // a round MB.
  const mb = (n / (1024 * 1024)).toFixed(1);
  return `${mb.endsWith('.0') ? mb.slice(0, -2) : mb} MB`;
}

export interface QuotaCheckOk {
  ok: true;
  /** Bytes the proposed write would add (after replacing any existing
   *  value at `key`). */
  needBytes: number;
  /** Bytes still available under the quota *after* the proposed write
   *  lands. Useful for logging and tests. */
  freeBytes: number;
  /** Hard ceiling — `chrome.storage.session.QUOTA_BYTES` (or the
   *  documented 10 MiB default when the runtime doesn't expose it). */
  quotaBytes: number;
}

export interface QuotaCheckFail {
  ok: false;
  /** Bytes the proposed write would need. */
  needBytes: number;
  /** Bytes available right now (after accounting for the existing
   *  value at `key` being replaced). */
  freeBytes: number;
  /** Hard ceiling — `chrome.storage.session.QUOTA_BYTES` (or the
   *  documented 10 MiB default when the runtime doesn't expose it).
   *  Surfaced in the user-facing message so "only 4.8 MB free" reads
   *  as "of 10 MB" rather than as an unbounded fraction. */
  quotaBytes: number;
}

export type QuotaCheckResult = QuotaCheckOk | QuotaCheckFail;

/**
 * Check whether `chrome.storage.session.set({ [key]: value })` would
 * fit under the session-storage quota. Accounts for any existing
 * value at `key` (a `set` replaces it, so its bytes free up).
 *
 * On a `getBytesInUse` failure we conservatively return `ok: false`
 * with `freeBytes: 0` — better to surface a "not enough room" message
 * than to forge ahead and let a low-level rejection trickle out as
 * something less actionable.
 */
export async function checkSessionStorageRoom(
  key: string,
  value: unknown,
): Promise<QuotaCheckResult> {
  const needBytes = estimateRecordBytes(key, value);
  const cap = quotaBytes();
  let inUse: number;
  let existing: number;
  try {
    inUse = await chrome.storage.session.getBytesInUse(null);
    existing = await chrome.storage.session.getBytesInUse(key);
  } catch {
    return { ok: false, needBytes, freeBytes: 0, quotaBytes: cap };
  }
  const freeBytes = cap - (inUse - existing);
  if (needBytes > freeBytes) {
    return { ok: false, needBytes, freeBytes, quotaBytes: cap };
  }
  return { ok: true, needBytes, freeBytes: freeBytes - needBytes, quotaBytes: cap };
}

/** One named contributor to a quota-busting payload. The capture
 *  flow passes `{ image, HTML, selection }` so the error message can
 *  tell the user which artifact is the long pole — knowing "the HTML
 *  is 12 MB" suggests a different fix than "the image is 12 MB". */
export interface QuotaBreakdownPart {
  label: string;
  bytes: number;
}

/**
 * Format a `QuotaCheckFail` as a single user-facing line. Quotes the
 * proposed and free sizes so the user knows whether they're a little
 * over or hugely over — the action they need to take ("crop the
 * screenshot" vs "trim the page" vs "use a different image") differs.
 *
 * `kind` lets the caller put the message in the right voice without
 * each site re-implementing the formatting:
 *   - 'capture' → "Capture is too large…"
 *   - 'ask'     → "Not enough extension storage to send this Ask…"
 *
 * `breakdown` is an optional per-artifact size split, rendered as
 * `A label1 + B label2 + ... = needBytes` when ≥2 parts are
 * non-zero, or just `bytes label` when only one is. Zero / missing
 * parts drop out so a screenshot-only capture reads "5 MB image"
 * rather than "5 MB image + 0 B HTML + 0 B selection". Sums of
 * rounded byte counts may visually disagree with the total (5 + 6 =
 * 12 if each was 5.6); `needBytes` is the authoritative figure and
 * always wins.
 */
export function formatQuotaError(
  kind: 'capture' | 'ask',
  result: QuotaCheckFail,
  breakdown: QuotaBreakdownPart[] = [],
): string {
  const free = formatBytes(Math.max(0, result.freeBytes));
  const cap = formatBytes(result.quotaBytes);
  const need = formatNeedClause(result.needBytes, breakdown);
  if (kind === 'capture') {
    return `Capture is too large (${need}; only ${free} of ${cap} extension storage free).`;
  }
  return `Not enough extension storage to send this Ask (${need}; only ${free} of ${cap} free).`;
}

function formatNeedClause(
  needBytes: number,
  breakdown: QuotaBreakdownPart[],
): string {
  const parts = breakdown.filter((p) => p.bytes > 0);
  if (parts.length === 0) return `needs ${formatBytes(needBytes)}`;
  if (parts.length === 1) {
    const only = parts[0]!;
    return `${formatBytes(only.bytes)} ${only.label}`;
  }
  const sum = parts.map((p) => `${formatBytes(p.bytes)} ${p.label}`).join(' + ');
  return `${sum} = ${formatBytes(needBytes)}`;
}
