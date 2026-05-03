// In-page status / recovery widget injected into the destination AI
// tab whenever the user runs Ask. Anchored top-right with two states:
//
//   - Collapsed: thin vertical strip carrying the same children as
//     the expanded title bar (icon, "SeeWhatISee", status icon, ×).
//     Click the strip (anywhere except ×) to expand.
//   - Expanded: title bar (icon, name, status icon, _, ×) plus
//     stacked sections — Status, Content (per-attachment copy
//     rows with their own status icons), Source (title + URL,
//     each with its own Copy button).
//
// Status icon is a CSS spinner while injecting, ✓ on success,
// ✕ on error. Auto-collapses on success; stays expanded on error.
// Clicking the title bar (in either state) toggles to the other.
// `_` collapses; `×` removes the widget AND clears that tab's
// storage record (full dismiss).
//
// Runs in ISOLATED world (loaded by `chrome.scripting.executeScript`)
// so it can talk to `chrome.storage.session` and `chrome.runtime`.
// The MAIN-world inject runtime in `ask-inject.ts` does the React
// event work — the widget never touches the page's prompt composer.
//
// Idempotent: re-injecting the file simply refreshes the existing
// widget rather than mounting a duplicate. The Ask flow re-runs this
// script before every send so an X'd widget reappears on the next
// Ask without a special re-mount path.
//
// Must be a non-module classic script (no top-level imports/exports)
// because executeScript loads files as content scripts. The IIFE
// wrapper preserves that.

(() => {
  // ─── Types ───────────────────────────────────────────────────────
  // Mirror the writer-side `AskWidgetRecord` in
  // `src/background/ask/widget-store.ts`. We don't import the type
  // because that would force module emission (see file header).

  interface AskWidgetAttachment {
    kind: 'image' | 'text';
    mimeType: string;
    filename: string;
    data: string;
  }

  type AskWidgetStatus = 'injecting' | 'success' | 'error';

  interface AskWidgetRecord {
    status: AskWidgetStatus;
    error?: string;
    destinationLabel: string;
    sourceUrl: string;
    sourceTitle: string;
    attachments: AskWidgetAttachment[];
    promptText: string;
    updatedAt: number;
  }

  interface WidgetHandle {
    tabId: number;
    host: HTMLDivElement;
    root: ShadowRoot;
    refresh(record: AskWidgetRecord | null): void;
  }

  // ─── Idempotent mount ────────────────────────────────────────────
  //
  // Wrapped in `init()` and called at the BOTTOM of the IIFE so the
  // template constants (`WIDGET_HTML` / `WIDGET_CSS`) are out of
  // their TDZ before `mountWidget` accesses them. Function
  // declarations are hoisted, but `const` bindings are not — calling
  // mountWidget at top-level here would throw a ReferenceError.

  function init(): void {
    const tabId = (window as unknown as {
      __seeWhatISeeWidgetTabId?: number;
    }).__seeWhatISeeWidgetTabId;
    if (typeof tabId !== 'number') {
      // The SW always sets this global before injecting the file. If
      // it's missing we can't key into storage — bail rather than
      // mount a widget that can never load any data.
      // Log only — `console.warn` surfaces as a warning on
      // chrome://extensions, and this is a wiring bug not a user-
      // actionable problem. Match the `ask-inject.ts` convention.
      console.log(
        '[SeeWhatISee Widget] [warn] tabId global not set; refusing to mount',
      );
      return;
    }

    // Per-tab storage key, captured by the closures below. Kept as a
    // const inside `init()` (rather than a module-scoped `let`) so
    // the listener / readRecord lifetime is visibly tied to this
    // mount and a future refactor can't accidentally read a stale
    // key from another tab.
    const storageKey = `askWidget:${tabId}`;

    async function readRecord(): Promise<AskWidgetRecord | null> {
      try {
        const got = await chrome.storage.session.get(storageKey);
        const v = got[storageKey] as AskWidgetRecord | undefined;
        return v ?? null;
      } catch {
        return null;
      }
    }

    const existing = (window as unknown as {
      __seeWhatISeeWidget?: WidgetHandle;
    }).__seeWhatISeeWidget;

    if (existing && existing.host.isConnected) {
      // Re-inject after a previous mount (same tab, second Ask) —
      // re-pull the record and let the existing handle update its UI.
      // Critical: must return BEFORE the
      // `chrome.storage.onChanged.addListener` call below, or every
      // re-Ask in the same content-script lifetime would attach a
      // duplicate listener and refresh() would fire repeatedly per
      // storage event. The mount is single-shot in practice (a
      // navigation tears down the content-script context), but
      // hoisting the early-return defense-in-depth keeps this safe
      // if mountWidget ever grows side effects.
      void readRecord().then((rec) => existing.refresh(rec));
      return;
    }

    const handle = mountWidget(tabId);
    (window as unknown as {
      __seeWhatISeeWidget?: WidgetHandle;
    }).__seeWhatISeeWidget = handle;

    // Initial paint + live updates.
    void readRecord().then((rec) => handle.refresh(rec));

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session') return;
      if (!(storageKey in changes)) return;
      const newValue = changes[storageKey].newValue as
        | AskWidgetRecord
        | undefined;
      handle.refresh(newValue ?? null);
    });
  }

  // ─── Mount + DOM construction ────────────────────────────────────

  function mountWidget(tabIdLocal: number): WidgetHandle {
    const host = document.createElement('div');
    host.id = 'see-what-i-see-widget-host';
    // Anchor by the TOP edge so the widget's top-right corner sits
    // at the same spot regardless of state — collapsed and expanded
    // share their top edge, even though expanded is taller.
    // ~25% from the top puts the widget in the upper quarter of the
    // viewport, out of the way of the AI tab's main composer.
    // `z-index: 2147483647` is the 32-bit int max — guarantees we're
    // above any provider chrome (Claude / Gemini / ChatGPT all use
    // values well below).
    host.setAttribute(
      'style',
      [
        'all: initial',
        'position: fixed',
        'top: 25%',
        'right: 0',
        'z-index: 2147483647',
      ].join('; '),
    );
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = WIDGET_HTML;
    injectStyles(root);

    // State: 'expanded' | 'collapsed'. Lives only in the widget DOM
    // (not storage) — minimize is per-mount UI, not cross-tab.
    let state: 'expanded' | 'collapsed' = 'expanded';

    const collapsed = root.getElementById('collapsed') as HTMLDivElement;
    const expanded = root.getElementById('expanded') as HTMLDivElement;

    function setState(next: 'expanded' | 'collapsed'): void {
      state = next;
      collapsed.style.display = state === 'collapsed' ? 'flex' : 'none';
      expanded.style.display = state === 'expanded' ? 'flex' : 'none';
    }

    // Title-bar interaction model: clicking the bar itself toggles
    // collapsed↔expanded; the dedicated `_` and `×` buttons are
    // exempted so they keep their specific behavior. The shared
    // toggle-on-titlebar matches the user's expectation that the
    // collapsed strip is "just the title bar rotated" — both
    // states have a clickable title bar that flips to the other.
    function bindTitlebarToggle(
      el: HTMLElement,
      next: 'expanded' | 'collapsed',
    ): void {
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-action]')) return;
        setState(next);
      });
    }
    bindTitlebarToggle(collapsed, 'expanded');
    const expandedTitlebar = root.querySelector(
      '#expanded .swis-titlebar',
    ) as HTMLElement;
    bindTitlebarToggle(expandedTitlebar, 'collapsed');

    root.querySelectorAll<HTMLButtonElement>('[data-action="minimize"]').forEach((b) => {
      b.addEventListener('click', () => setState('collapsed'));
    });
    root.querySelectorAll<HTMLButtonElement>('[data-action="close"]').forEach((b) => {
      b.addEventListener('click', () => {
        host.remove();
        // Recompute the storage key from `tabIdLocal` rather than
        // closing over a `storageKey` from `init()` — keeps
        // `mountWidget` self-contained, and the cost is one string
        // template per click.
        void chrome.storage.session
          .remove(`askWidget:${tabIdLocal}`)
          .catch(() => {});
        (window as unknown as {
          __seeWhatISeeWidget?: WidgetHandle;
        }).__seeWhatISeeWidget = undefined;
      });
    });

    // Set the icon srcs once at mount. Using `chrome.runtime.getURL`
    // requires the icon path to be in `web_accessible_resources`.
    const iconUrl = chrome.runtime.getURL('icons/icon-48.png');
    root.querySelectorAll<HTMLImageElement>('img.swis-icon').forEach((img) => {
      img.src = iconUrl;
    });

    function refresh(record: AskWidgetRecord | null): void {
      if (!record) {
        // No record means the SW never wrote one (or X just cleared
        // it). Hide the widget — but leave the host in place so the
        // next storage event can re-show it without a re-mount.
        host.style.display = 'none';
        // Clear `lastStatus` so the next non-null record's transition
        // logic treats it as a fresh start (otherwise a sequence
        // success → null → success would skip the auto-collapse).
        delete host.dataset.lastStatus;
        return;
      }
      host.style.display = '';

      paintTitle(root, record);
      paintStatusSection(root, record);
      paintContentSection(root, record);
      paintPageSection(root, record);

      // State transitions:
      //   - injecting (after a non-injecting prev) → re-expand so a
      //     fresh send while the user has the widget collapsed pops
      //     it back open.
      //   - success (after a non-success prev) → auto-collapse once;
      //     the user can manually re-expand without it snapping shut.
      //   - error → expand and stay expanded.
      // `prevStatus` is read off the host, so the FIRST refresh of a
      // record (prevStatus === undefined) treats every state as a
      // transition.
      const prevStatus = host.dataset.lastStatus as AskWidgetStatus | undefined;
      host.dataset.lastStatus = record.status;
      if (record.status === 'injecting' && prevStatus !== 'injecting') {
        setState('expanded');
      } else if (record.status === 'success' && prevStatus !== 'success') {
        setState('collapsed');
      } else if (record.status === 'error') {
        setState('expanded');
      }
    }

    return { tabId: tabIdLocal, host, root, refresh };
  }

  // ─── Painters ────────────────────────────────────────────────────

  function paintTitle(root: ShadowRoot, record: AskWidgetRecord): void {
    // Status icon: success → ✓, error → ✕, injecting → empty
    // (CSS draws a spinning ring on the empty element). Updating
    // textContent + data-status keeps DOM and styling in lockstep
    // even when the element exists in both the collapsed strip and
    // the expanded title bar.
    const glyph =
      record.status === 'success' ? '✓'
      : record.status === 'error' ? '✕'
      : '';
    root.querySelectorAll<HTMLElement>('.swis-status-icon').forEach((el) => {
      el.textContent = glyph;
      el.dataset.status = record.status;
      el.title = statusLabel(record);
    });
  }

  function paintStatusSection(root: ShadowRoot, record: AskWidgetRecord): void {
    const text = root.getElementById('status-text') as HTMLDivElement;
    text.textContent = statusLabel(record);
    text.dataset.status = record.status;
  }

  function statusLabel(record: AskWidgetRecord): string {
    if (record.status === 'injecting') {
      const what = describeAttachments(record.attachments, record.promptText);
      return `Injecting ${what} into ${record.destinationLabel}…`;
    }
    if (record.status === 'success') return 'Injected successfully.';
    return record.error ?? 'Unknown error.';
  }

  function describeAttachments(
    attachments: AskWidgetAttachment[],
    promptText: string,
  ): string {
    // Filename suffixes are the same ones produced by
    // `buildAskAttachments` in `src/capture-page.ts` — see
    // `SELECTION_FILE_META` and the hard-coded `'contents.html'` /
    // `'screenshot.png'` there. If the naming scheme ever changes
    // both sides need to move together.
    const parts: string[] = [];
    if (attachments.some((a) => a.kind === 'image')) parts.push('screenshot');
    if (attachments.some((a) => a.filename.endsWith('.html'))) parts.push('HTML');
    if (
      attachments.some(
        (a) => a.kind === 'text' && !a.filename.endsWith('.html'),
      )
    ) {
      parts.push('selection');
    }
    if (promptText.trim().length > 0) parts.push('prompt');
    if (parts.length === 0) return 'content';
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts.join(' + ');
    return parts.slice(0, -1).join(', ') + ' + ' + parts[parts.length - 1];
  }

  function paintContentSection(root: ShadowRoot, record: AskWidgetRecord): void {
    const container = root.getElementById('content-buttons') as HTMLDivElement;
    container.replaceChildren();

    // Each row: [per-item status icon] [copy button]. Per-item
    // status currently mirrors the overall record status, since the
    // inject runtime batches all files into a single change event
    // and we only know batch-level success/failure. The layout is
    // ready for real per-file tracking — when we add it, the only
    // change is which status the row gets.
    for (const att of record.attachments) {
      const label = labelForAttachment(att);
      container.appendChild(
        makeContentRow(label, record.status, () => copyAttachment(att)),
      );
    }
    if (record.promptText.trim().length > 0) {
      container.appendChild(
        makeContentRow('Prompt', record.status, () =>
          navigator.clipboard.writeText(record.promptText),
        ),
      );
    }

    // Hide whole section if nothing to copy.
    const section = root.getElementById('content-section') as HTMLDivElement;
    section.style.display = container.children.length === 0 ? 'none' : '';
  }

  /**
   * Build one row in the Content section: a small status icon on
   * the left (sharing the same `.swis-status-icon` styles as the
   * title-bar dot, so spinner / ✓ / ✕ render identically), then the
   * Copy button. Empty status means "not tried" — render a hollow
   * placeholder so the row's left margin matches the others.
   */
  function makeContentRow(
    label: string,
    status: AskWidgetStatus,
    doCopy: () => Promise<unknown> | unknown,
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'swis-content-row';
    const icon = document.createElement('span');
    icon.className = 'swis-status-icon swis-status-icon-row';
    icon.dataset.status = status;
    icon.textContent =
      status === 'success' ? '✓' : status === 'error' ? '✕' : '';
    row.appendChild(icon);
    row.appendChild(makeCopyButton(label, doCopy));
    return row;
  }

  function labelForAttachment(att: AskWidgetAttachment): string {
    if (att.kind === 'image') return 'Screenshot';
    if (att.filename.endsWith('.html')) return 'HTML';
    if (att.filename.endsWith('.md') || att.mimeType.includes('markdown')) {
      return 'Selection (markdown)';
    }
    if (att.mimeType.includes('html')) return 'Selection (HTML)';
    return 'Selection (text)';
  }

  function makeCopyButton(
    label: string,
    doCopy: () => Promise<unknown> | unknown,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swis-copy-btn';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      const original = btn.textContent ?? '';
      try {
        await doCopy();
        btn.textContent = 'Copied!';
        btn.classList.add('swis-copied');
      } catch (err) {
        btn.textContent = 'Copy failed';
        btn.classList.add('swis-copy-failed');
        // Same console-log rationale as the init() warning.
        console.log('[SeeWhatISee Widget] [warn] copy failed', err);
      }
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('swis-copied', 'swis-copy-failed');
      }, 1200);
    });
    return btn;
  }

  async function copyAttachment(att: AskWidgetAttachment): Promise<void> {
    if (att.kind === 'image') {
      // dataUrl → Blob via hand-decode (avoids relying on `fetch` of
      // a data: URL, which some sites' CSPs interfere with).
      const blob = dataUrlToBlob(att.data, att.mimeType);
      // Browsers only accept image/png in ClipboardItem reliably; if
      // we ever produce JPEG we'd need a re-encode here.
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      return;
    }
    // Text payloads: write the format-specific MIME plus text/plain
    // so paste targets that don't recognize html/markdown still get
    // something meaningful.
    const items: Record<string, Blob> = {
      'text/plain': new Blob([att.data], { type: 'text/plain' }),
    };
    if (att.mimeType.includes('html')) {
      items['text/html'] = new Blob([att.data], { type: 'text/html' });
    } else if (
      att.mimeType.includes('markdown')
      || att.filename.endsWith('.md')
    ) {
      // text/markdown isn't a universally honored clipboard type but
      // markdown-aware paste targets (some IDEs) read it; the
      // text/plain fallback covers everything else.
      items['text/markdown'] = new Blob([att.data], { type: 'text/markdown' });
    }
    try {
      await navigator.clipboard.write([new ClipboardItem(items)]);
    } catch {
      // Some browsers reject ClipboardItem with unknown types — fall
      // back to plain text so the user at least gets the body.
      await navigator.clipboard.writeText(att.data);
    }
  }

  function dataUrlToBlob(dataUrl: string, fallbackMime: string): Blob {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return new Blob([], { type: fallbackMime });
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    const mimeMatch = meta.match(/^data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : fallbackMime;
    if (/;base64$/i.test(meta)) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes as BlobPart], { type: mime });
    }
    // Non-base64 branch: callers today always pass base64 image data
    // URLs, so this path doesn't run for any current attachment kind.
    // Kept for completeness; would lose information for non-UTF-8
    // bytes in a URL-encoded payload.
    const bytes = new TextEncoder().encode(decodeURIComponent(body));
    return new Blob([bytes as BlobPart], { type: mime });
  }

  function paintPageSection(root: ShadowRoot, record: AskWidgetRecord): void {
    const titleLink = root.getElementById('page-title') as HTMLAnchorElement;
    const urlLink = root.getElementById('page-url') as HTMLAnchorElement;
    const urlText = root.getElementById('page-url-text') as HTMLSpanElement;
    const copyUrlBtn = root.getElementById('page-copy-url') as HTMLButtonElement;
    const copyTitleBtn = root.getElementById('page-copy-title') as HTMLButtonElement;

    const url = record.sourceUrl || '';
    const title = record.sourceTitle || url || '(no URL)';

    titleLink.textContent = title;
    titleLink.title = title;
    urlText.textContent = url;
    urlLink.title = url;

    // Mirror the Capture page: only http(s) URLs get a live href; the
    // rest render as inert text via the `:not([href])` rule below.
    const linkable = !!url && /^https?:/i.test(url);
    if (linkable) {
      titleLink.href = url;
      urlLink.href = url;
    } else {
      titleLink.removeAttribute('href');
      urlLink.removeAttribute('href');
    }

    bindCopyGlyph(copyUrlBtn, url);
    bindCopyGlyph(copyTitleBtn, title === '(no URL)' ? '' : title);
  }

  /**
   * Wire a per-row Copy button (URL or title) to write `text` on
   * click and flash a transient glyph for feedback. Reassigns
   * `onclick` rather than `addEventListener` so a refresh-driven
   * re-bind doesn't leak listeners — see the rationale on
   * `paintPageSection` above.
   */
  function bindCopyGlyph(btn: HTMLButtonElement, text: string): void {
    btn.disabled = !text;
    btn.textContent = '⧉';
    btn.onclick = async (): Promise<void> => {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '✓';
      } catch {
        btn.textContent = '✗';
      }
      setTimeout(() => {
        btn.textContent = '⧉';
      }, 1000);
    };
  }

  // ─── HTML + CSS templates ────────────────────────────────────────

  // Two stacked containers — one shown at a time. Layout choices:
  //   • Collapsed strip: vertical orientation of the same children
  //     as the expanded title bar (icon / "SeeWhatISee" / status /
  //     `_` / `×`), so collapsed reads as the title bar rotated 90°
  //     left. Same per-element actions; clicking the strip body
  //     also expands. Width sized to fit the 13px title font.
  //   • Expanded: ~220 px wide title bar + sections separated by 1px
  //     borders.
  //   • Both anchored at right: 0; the host's
  //     `transform: translateY(-50%)` centers vertically.
  const WIDGET_HTML = `
    <div id="collapsed" class="swis-collapsed" style="display: none">
      <img class="swis-icon swis-icon-rotated" alt="" />
      <div class="swis-title swis-title-vertical">SeeWhatISee</div>
      <span class="swis-status-icon swis-status-icon-rotated" data-status="injecting" title=""></span>
      <button type="button" class="swis-titlebar-btn" data-action="close" title="Close">
        <svg class="swis-btn-glyph" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3 L9 9 M9 3 L3 9" />
        </svg>
      </button>
    </div>
    <div id="expanded" class="swis-expanded">
      <div class="swis-titlebar">
        <img class="swis-icon" alt="" />
        <div class="swis-title">SeeWhatISee</div>
        <span class="swis-status-icon" data-status="injecting" title=""></span>
        <button type="button" class="swis-titlebar-btn" data-action="minimize" title="Minimize">
          <svg class="swis-btn-glyph" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 10 L9 10" />
          </svg>
        </button>
        <button type="button" class="swis-titlebar-btn" data-action="close" title="Close">
          <svg class="swis-btn-glyph" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      </div>
      <div class="swis-section">
        <div class="swis-section-label">Status</div>
        <div id="status-text" class="swis-status-text" data-status="injecting"></div>
      </div>
      <div id="content-section" class="swis-section">
        <div class="swis-section-label">Content</div>
        <div id="content-buttons" class="swis-content-buttons"></div>
        <div class="swis-hint">Click to copy</div>
      </div>
      <div class="swis-section">
        <div class="swis-section-label">Source</div>
        <div class="swis-page-title-row">
          <a id="page-title" class="swis-page-title"
             target="_blank" rel="noreferrer noopener"></a>
          <button type="button" id="page-copy-title" class="swis-page-copy-btn"
                  title="Copy title">⧉</button>
        </div>
        <div class="swis-page-url-row">
          <a id="page-url" class="swis-page-url"
             target="_blank" rel="noreferrer noopener">
            <span id="page-url-text" class="swis-page-url-text"></span>
          </a>
          <button type="button" id="page-copy-url" class="swis-page-copy-btn"
                  title="Copy URL">⧉</button>
        </div>
      </div>
    </div>
  `;

  function injectStyles(root: ShadowRoot): void {
    const style = document.createElement('style');
    style.textContent = WIDGET_CSS;
    root.appendChild(style);
  }

  // Style isolation: shadow-DOM means the host page's CSS doesn't
  // touch us, but we still scope every selector under the widget
  // classes for clarity. All units explicit (no inherited em/rem),
  // and all colors are the Capture-page palette so the widget feels
  // like a peer of the source page rather than a generic toast.
  const WIDGET_CSS = `
    :host, * { box-sizing: border-box; }
    .swis-collapsed, .swis-expanded {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #222;
      /* Light-purple body so the widget offsets against mostly-white
       * provider pages (Claude / Gemini / ChatGPT). Slightly paler
       * than the title bar's #ede7f6 (deep-purple-50) so the title
       * bar still reads as a distinct band on top. Border picks up
       * the same deep-purple-200 used by the Capture / Options page
       * header chrome so the widget feels like part of the same
       * product family. */
      background: #f5f0fa;
      border: 1px solid #b39ddb;
      border-right: none;
      border-radius: 8px 0 0 8px;
      box-shadow: -2px 2px 8px rgba(0, 0, 0, 0.12);
    }
    .swis-collapsed {
      /* Vertical orientation of the title bar's children. Padding +
       * gap mirror the title bar so visual rhythm matches between
       * states. column-reverse flips the visual layout so the
       * reading direction (bottom-to-top, matching the rotated
       * "SeeWhatISee" label) presents elements in the same order
       * as the expanded title bar reads left-to-right:
       *   icon → name → status → ×
       * That puts the icon at the BOTTOM and × at the TOP of the
       * strip. Source order in the HTML stays the same as the
       * expanded title bar so the two read identically as code. */
      display: flex;
      flex-direction: column-reverse;
      align-items: center;
      gap: 6px;
      width: 32px;
      padding: 6px 4px;
      /* Same purple as the expanded title bar — the collapsed strip
       * is the title bar in vertical form. A touch darker than the
       * Capture-page header (#ede7f6) so it still reads as a band
       * against the widget body's own pale-purple #f5f0fa. */
      background: #e0d4f0;
      cursor: pointer;
    }
    /* Title text in the collapsed strip: vertical writing mode +
     * 180° rotation reads bottom-up like a tab label. Same font as
     * the expanded title bar (13px) for consistency. */
    .swis-title-vertical {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
    }
    /* Icons inside the collapsed strip get rotated 90° left so
     * they read consistently with the rest of the rotated layout —
     * the main icon plus the success/error glyphs in the status
     * icon. The injecting state is intentionally excluded from this
     * selector list so a fixed 90 deg transform doesn't override
     * the swis-spin keyframe rotation; the spinner keeps spinning
     * in the collapsed strip the same way it does in the title
     * bar. */
    .swis-icon-rotated,
    .swis-status-icon-rotated[data-status="success"],
    .swis-status-icon-rotated[data-status="error"] {
      transform: rotate(-90deg);
    }
    .swis-expanded {
      display: flex;
      flex-direction: column;
      width: 220px;
      max-height: 80vh;
      overflow-y: auto;
    }
    .swis-titlebar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      /* A touch darker than the Capture / Options page header's
       * #ede7f6 — the widget needs the extra contrast against its
       * own pale-purple body so the title bar reads as a distinct
       * band. Border-bottom stays deep-purple-200 for theme
       * consistency. */
      background: #e0d4f0;
      border-bottom: 1px solid #b39ddb;
      border-radius: 8px 0 0 0;
      cursor: pointer;
    }
    .swis-title {
      flex: 1;
      font-size: 13px;
      font-weight: 600;
    }
    .swis-icon {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
    }
    /* Status indicator. Three states share the same 14×14 box;
     *   • injecting → CSS spinner (border ring + rotation
     *     animation), no glyph.
     *   • success   → green ✓ glyph.
     *   • error     → red ✕ glyph. */
    .swis-status-icon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 700;
      line-height: 1;
    }
    .swis-status-icon[data-status="injecting"] {
      border: 2px solid #e5e5e5;
      border-top-color: #f59e0b;
      border-radius: 50%;
      animation: swis-spin 0.8s linear infinite;
    }
    .swis-status-icon[data-status="success"] { color: #16a34a; }
    .swis-status-icon[data-status="error"]   { color: #dc2626; }
    @keyframes swis-spin {
      to { transform: rotate(360deg); }
    }
    .swis-titlebar-btn {
      flex: 0 0 auto;
      width: 20px;
      height: 20px;
      padding: 0;
      /* inline-flex centres the inline SVG glyph geometrically —
       * better than relying on font metrics, which left the old "×"
       * character sitting a few pixels above optical centre. */
      display: inline-flex;
      align-items: center;
      justify-content: center;
      /* Deep-purple-700 — matches the brand text and section labels
       * so the close / minimize glyphs read as part of the same theme
       * rather than as neutral grey UI chrome. Flows into the SVG
       * stroke via stroke: currentColor on .swis-btn-glyph. */
      color: #512da8;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
    }
    /* Close (X) and minimize (—) glyphs are inline SVG instead of
     * unicode text. Reasons: (1) geometric centring vs. font-baseline
     * drift; (2) rotation-invariant — the X looks the same in the
     * collapsed strip's vertical layout without needing
     * swis-icon-rotated; (3) sizing is independent of font-family
     * the host page might otherwise leak in (shadow DOM helps but
     * isn't bulletproof against UA defaults). */
    .swis-btn-glyph {
      width: 12px;
      height: 12px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.5;
      stroke-linecap: round;
    }
    .swis-titlebar-btn:hover {
      /* Tinted hover so it harmonizes with the purple title bar
       * instead of reading as a cool-grey chip on a warm bar.
       * Visibly darker than the bar so the hover state reads, but
       * not all the way to the deep-purple-200 outer border. */
      background: #c8b8e2;
      border-color: #b39ddb;
    }
    .swis-section {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      /* Section divider tinted to stay visible against the purple
       * widget body — plain #eee washes out on #f5f0fa. */
      border-bottom: 1px solid #e0d8ec;
    }
    .swis-section:last-child { border-bottom: none; }
    .swis-section-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      /* Deep-purple-700 (matches the brand text in the page header)
       * so STATUS / CONTENT / SOURCE pop against the pale-purple
       * body instead of fading into the grey #888 they used to use. */
      color: #512da8;
    }
    .swis-status-text {
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
    }
    .swis-status-text[data-status="error"]   { color: #b91c1c; }
    .swis-status-text[data-status="success"] { color: #15803d; }
    .swis-content-buttons {
      /* One row per attachment / prompt — vertical stack. */
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .swis-content-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    /* Per-item status icon shares the title-bar status styles so
     * the spinner / check / cross render identically. The
     * placeholder (empty textContent) reserves a 14px slot so all
     * rows align even when a row hasn't had a status assigned. */
    .swis-status-icon-row {
      width: 14px;
      height: 14px;
    }
    .swis-copy-btn {
      padding: 4px 10px;
      font-size: 12px;
      color: #222;
      background: #fff;
      border: 1px solid #ccc;
      border-radius: 4px;
      cursor: pointer;
    }
    .swis-copy-btn:hover { background: #f5f5f5; }
    .swis-copy-btn.swis-copied {
      background: #dcfce7;
      border-color: #86efac;
    }
    .swis-copy-btn.swis-copy-failed {
      background: #fee2e2;
      border-color: #fca5a5;
    }
    .swis-hint {
      font-size: 11px;
      color: #888;
    }
    /* Title row + URL row — anchor on the left, Copy button pinned
     * to the right edge of the widget. The anchor uses
     * flex: 1 1 auto so it stretches to fill the available width
     * and the Copy button always lands flush against the right
     * edge, regardless of how short the title or URL is. */
    .swis-page-title-row,
    .swis-page-url-row {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .swis-page-title {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 13px;
      font-weight: 600;
      color: #222;
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .swis-page-title:hover { text-decoration: underline; }
    .swis-page-url {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      color: #0645ad;
      text-decoration: none;
      overflow: hidden;
    }
    .swis-page-url:hover .swis-page-url-text { text-decoration: underline; }
    .swis-page-url-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Same demote-when-not-linkable rule as the Capture-page card. */
    .swis-page-title:not([href]),
    .swis-page-url:not([href]) {
      color: #222;
      cursor: default;
      pointer-events: none;
    }
    .swis-page-copy-btn {
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      padding: 0;
      font-size: 12px;
      line-height: 1;
      color: #555;
      background: #fff;
      border: 1px solid #ccc;
      border-radius: 4px;
      cursor: pointer;
    }
    .swis-page-copy-btn:hover { background: #f5f5f5; }
    .swis-page-copy-btn:disabled {
      color: #aaa;
      cursor: not-allowed;
    }
  `;

  // Now that all const-bound templates are initialized, kick off the
  // mount. See the `init()` comment near the top of the IIFE.
  init();
})();
