# TODO.md

## Chrome extension

### Possible features
* Options
  - Choose which actions to show on main context menu
* Docs/help in the app
* Edit image format (PNG/JPG) and size (rescale)
* Drawing tools
  - Drag endpoints of line segments
  - Select tool so we can pick elements
    - Delete element
    - Maybe drag to move
    - Convert or shrink a selected object. (The More menu's Convert and Shrink items currently act on the last drawn or edited item, and one special case for full-image crop.)
* A Redo button or menu item (the ctrl-Y / ctrl-shift-Z shortcuts are done)

### Possible big features
* Record and save video (or repeated screenshots of interactions)
* Capture full page content as markdown (find the main content pane somehow)
* HTML element picker (like in Chrome dev console) to capture an element
* Capture selection on pages with complex text canvas widgets (e.g. Google Docs). Possibly by hooking a fake Copy operation.

### CDP capture (needs the `debugger` permission)

CDP is the Chrome DevTools Protocol — the wire protocol DevTools and
Puppeteer speak. `chrome.debugger` lets an extension attach to a tab and
send CDP commands.

What it would let us start doing:
* Full-page screenshot as a single image, rendered by the browser, without
  scroll-and-stitch (`Page.captureScreenshot` with `captureBeyondViewport`).
* Render the page off-screen at a chosen width/height/DPR
  (`Emulation.setDeviceMetricsOverride`) — e.g. a fixed-width reader shot,
  or 2x for legibility.
* Capture the console: real errors, CSP violations, failed subresource
  loads (`Log`, `Runtime.exceptionThrown`). A content script can only
  monkeypatch `console.*`, and misses everything browser-generated.
* Capture the network log, including response bodies (`Network`).
  `webRequest` can't give us bodies.
* See into closed shadow roots and cross-origin iframes in one pierced
  tree (`DOM.getDocument` with `pierce`) — content scripts can't.
* Snapshot DOM + computed styles + layout boxes in one call
  (`DOMSnapshot.captureSnapshot`).
* Accessibility tree (`Accessibility.getFullAXTree`) — compact semantic
  structure, a plausibly better snapshot format for an LLM than HTML.
* Map a drawn region back to the DOM nodes under it
  (`DOM.getNodeForLocation`), so a circled area can extract just that
  subtree. Pairs with the element-picker idea above.
* Self-contained MHTML archive of the page (`Page.captureSnapshot`).
* Emulate dark mode, reduced motion, locale, timezone (`Emulation`).

What it costs:
* `debugger` **cannot be an optional permission** — it must be declared
  up front, and adding it to a published extension disables it for
  existing users until they re-accept the new warning.
* A "SeeWhatISee started debugging this browser" infobar shows for the
  whole time we're attached. Keep attach/capture/detach short.
* Heightened Chrome Web Store review.
* Does **not** unlock restricted pages — `chrome://`, other extensions,
  the Web Store all reject the attach, same as content scripts.

### Optimizations
* Redo currently snapshots the whole drawing state on every Undo, instead of storing per-op inverses.
  - Cost is O(edits) per keypress, so undoing a run of N edits is O(N²) in small edit records. A few hundred KB in a realistic session, and it's dropped on the next commit, so this is cleanup rather than a fix.
  - Bigger effect: Undo of a **View cropped** op no longer releases the image it swapped away, because the redo entry still points at it. Undoing a whole drill-down series holds every intermediate image at once.
  - Better shape: `editHistory` is already the forward list of ops, so make Undo move an "active endpoint" pointer instead of popping, and keep `edits` + the base image as the cached effective state that ops mutate in both directions. Redo becomes a pointer step; a new edit truncates the tail.
  - What blocks that today: the ops aren't self-describing. An add op holds only an id (the `Edit` lives in `edits`), an in-place op holds `prev` but not `next`, and the whole-state markers hold nothing at all — their pre-state sits in parallel stacks (`viewCropStack`, `wholeStateStack`) indexed by popping in lockstep with the history. Each op needs to carry, or key into, its own before/after state.
  - Watch out: `editHistory` is serialized to the SW for the last-capture snapshot, which is why the markers are tiny today. Any per-op state holding a data URL has to live in an in-memory side table and be stripped from the snapshot, or it lands in storage.
  - Replaying from the original instead of caching isn't an option — re-running a View cropped op means a canvas re-crop and re-encode, which is slow and generationally lossy on a JPG capture.
* Refcount stored images and html and share them between Capture and Ask, rather than making a copy.
* Resize images if they are too large
* Make tests faster, skip unnecessary Chrome capture interactions
* Architecture change to avoid using session storage to hold data and pass between SW and capture page.
  - Instead, keep it in RAM, and pass it back and forth over a port. This avoids 10MB session quota issues.
  - Passing data to Ask page still uses session storage, so it might do the same switch.

## Skills and plugins

### History access from the CLI
* Shipped for the shell skills: `see-what-i-see-history` (Claude plugin,
  Gemini extension, generic bundle) wraps the `SeeWhatISee.py` history
  actions.
* The MCP server still doesn't expose them. It needs its own
  `list_captures` tool taking limit / search / site / time, plus an
  MCP-driven `see-what-i-see-history` skill + prompt. The shared
  `skills/history-usage.template.md` block is reusable as-is.
* Try the skill on real requests and see whether the guidance holds
  up — especially the "narrow, then judge candidates by their
  contents" path, where the right subagent shape varies by tool.
  * A Claude subagent doesn't inherit the skill's
    `Read(~/Downloads/SeeWhatISee/**)` pre-approval, so delegating the
    look-at-the-image step prompts for permission. Check whether that
    is worth pre-approving somewhere.
* The Gemini workspace-tmp-dir computation is now copied in three
  wrappers (`copy-last-snapshot.sh`, `watch-and-copy.sh`,
  `history.sh`). Factor it into a sourced helper in that bundle.

### Claude plugin
* Is there a way to give the `-watch` skill the Read permission it needs without editing `settings.json`?

### Gemini plugin
* Background watching doesn't work because asynchronous background commands aren't supported, so we just have a foreground version of the watch command for now.
* BUG: command doesn't work if multiple gemini's run in workspaces with the same name, because one of their tmp dirs has -1, and we don't know that. See copy-last-snapshot.sh.
* Fix general unreliability and permissions issues: https://github.com/jshute96/SeeWhatISee/issues/27.

### MCP server
* MCP server is experimental. Test it more fully.
* Add more instructions on how to install and use it in various tools.
* Find somewhere to test using the streaming resource for `watch`.

### Integrating other tools to read captures
* CLI skills that work for other tools

## Ask pages (web chat integration)
* Maybe allow pinning any page, so users can inject with copy/paste widget
* Extensible Ask connectors in options, so users can hook up other pages if they figure out the selectors

## Known issues

* **ChromeOS won't let the extension list the capture directory**
  (`docs/chrome-extension.md` → Directory listings can be denied).
  Files in it read fine. The history index (`history-files.json`)
  fixed the gap that was actually seen, history files going missing
  ([#35](https://github.com/jshute96/SeeWhatISee/issues/35)). These
  speculative gaps remain, not seen in practice:
  * A capture file that exists but can't be read looks deleted, so a
    delete leaves the file and removes its record.
  * A failed read of `log.json` always looks like the user deleted
    it, so the next capture starts a new log over the old one. Only
    the listing can tell those apart.

## Documentation

### Pending docs for features not released yet

* **Older captures stay findable on ChromeOS after clearing download
  history** — the extension now keeps a `history-files.json` index of
  its history files in the capture folder.

* **Saved HTML snapshots keep the page's doctype and say where they
  came from** — saved HTML files now start like a Chrome-saved page:
  the page's `<!DOCTYPE>` plus a `<!-- saved from url=... -->` line
  (visible in Edit HTML, removable there). Selection HTML files get the
  page's doctype too.

### Not documented

* Help buttons
* Polylines (not mentioned)
* Snap-to behavior (snap-to points and edges, snap lines to horizontal / vertical)
* A pan drag snaps a crop / box edit flush against the edges of the visible pane
* `Ctrl+Z` with the cursor parked outside both the image area and the prompt does nothing; there is no Redo button, so redo is keyboard-only

#### Large objects

* Screenshots that are >2MB auto-recompress to JPEG if JPEG is ≥10% smaller
* JPG images stay as JPG, event after drawing on them (previous conversion to PNG causes size blowup)
* HTML and selection text are stored compressed (gzip, ~3× on typical pages), so a capture holds far more of them than the stored size suggests
* HTML is omitted on the capture page (with an error) only if it's still >4MB compressed, or >24MB before compression; the selection (all three formats together) has its own 2MB compressed cap, so either can drop without the other
* Text sent to Ask (HTML plus any selection, combined) is capped at 2MB (Ask stages its own uncompressed copy), and refuses up-front rather than failing mid-send
* When capturing an image directly (e.g. from a file: or http: URL ending in .jpg or .png), we just take the image, not a screenshot

#### Keyboard shortcuts

* Hold `Ctrl` when releasing a Line or Arrow — promote it to a multi-segment polyline. Release `Ctrl` to end the chain.
* `Ctrl+Enter` to submit (if `Enter` is set as newline).
