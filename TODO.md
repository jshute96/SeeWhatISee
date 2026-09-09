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

## Documentation

### Pending docs for features not released yet

* **See what a watch script is running, and stop it, from the Capture page** — when
  `/see-what-i-see-watch` is running, the Capture page's button row
  shows it with a Stop button; both sides need the updated script
  (`.watch-status.json` / `watch-stop.json`), and the extension needs
  "Allow access to file URLs" to see it at all.
  * README's Capture-page section needs the indicator, and the
    file-access note should mention this as another thing the toggle
    buys.

* **Single-shot watch loops are stoppable too** — the Gemini and
  generic polling wrappers now take part in the stop protocol, so the
  iteration they're blocked in shows on the Capture page and answers
  Stop / `--stop`; Gemini gained a `/see-what-i-see-stop` command for it.
  * README's Gemini section needs the new command, and its
    `settings.json` allow-list needs
    `.../skills/see-what-i-see-stop/scripts/stop.sh`.
  * The watch now stays visible and stoppable *between* captures too,
    while the agent works through the one it was just handed — so the
    README wording shouldn't tie the indicator to "a script is
    blocked right now".
  * Taking part is now the default for any `--watch` run, with
    `--no-lockfiles` as the opt-out for parallel watchers — worth a
    line wherever README describes running the script by hand.

* **Google Antigravity plugin** — a fourth client bundle at
  `skills/antigravity-plugin/` (`plugin.json` plus the skills),
  generated from the `antigravity.*.md` templates and mirrored to
  `../SeeWhatISee-antigravity/plugin/`. See `docs/antigravity-plugin.md`.
  * Blocked on creating the `SeeWhatISee-antigravity` release repo —
    the mirror script bails without it.
  * README needs an "Antigravity commands" section (the same
    commands as the other clients; the watch loop runs one
    backgrounded script per capture, so the conversation stays
    live) and an install section: clone the release repo, then copy or symlink its
    `plugin/` to `~/.gemini/config/plugins/see-what-i-see/`, or a
    workspace `.agents/plugins/`, or `agy plugin install <clone>/plugin`.

* **Convert last drawn box** — a More-menu item that retargets the
  last drawn box / redaction / crop to another of those kinds, for
  when it was drawn with the wrong tool selected.
  * README's More… menu list needs the item, under "Replace with
    cropped image".

* **Shrink follows the last box acted on** — Shrink no longer picks
  its target from the selected tool; it acts on the same box Convert
  does (the last one drawn or edited), with the Crop tool still
  meaning "the crop region, or the whole image".
  * README's Shrink bullet still describes the per-tool rule and the
    old "Shrink last … to fit content" label.

* **`see-what-i-see-history` skill** — scan or search past captures
  by count, date/time, site, or text, instead of only the latest one.
  * README's command lists (Claude plugin, Gemini extension, generic
    skills) each need the new skill.
  * Gemini's `run_shell_command` allowlist in README needs
    `skills/see-what-i-see-history/scripts/history.sh`.

* **Capture log on disk is authoritative** — `log.json` decides what
  the log is, and Chrome extension storage is only a cache.
  * README's `log.json` section still says the opposite ("the
    authoritative log lives in Chrome extension storage… if deleted,
    it's restored from extension storage on the next capture") and
    needs rewriting on release.
  * `privacy_policy.md` needs the same rewrite: it describes storage as
    the authoritative log, points at the removed **More ▸ Clear log
    history** entry, and says the log is capped at 100 captures with
    older entries dropped (they go to `history-*.json` files instead —
    already stale before this change).
  * Deleting `log.json` starts a new log instead of having the old
    records restored; deleting individual rows sticks.
  * The **More ▸ Clear log history** menu entry is gone. Deleting the
    file is the way to clear the log until a delete-the-files feature
    exists.
  * If the extension can't tell what's on disk, `log.json` isn't
    rewritten: the capture's files are saved, and a prompt (on the
    Capture page, or on an error page for context-menu / hotkey
    captures) offers Retry / Overwrite / Cancel for that capture.
  * With file reads on, the History page opens from `log.json`
    itself, so a deleted, emptied, or hand-edited file shows as it is
    on disk without waiting for the next capture.

* **History page** — a searchable table of recent captures: date,
  screenshot thumbnail, links to the saved HTML / selection files,
  page URL + title, and the prompt.
  * Open it from the **History** entry on the toolbar icon's
    right-click menu, or the **History** button in the header of the
    Capture and Options pages.
  * The search box filters on URL, title, or prompt text.
  * Thumbnails and file links need "Allow access to file URLs"
    enabled for the extension; the page says so, with a link to the
    settings page carrying the toggle.
  * **Load older captures**, next to the capture count, pulls in
    captures older than the most recent 100, which move into
    `history-<timestamp>.json` files next to `log.json` instead of
    being discarded. Needs the same file-access permission. It only
    appears while there are unread history files, and its tooltip says
    how many.
    * Deleting `log.json` doesn't delete those history files, so the
      History page can still load them afterwards.
  * A **Snapshots directory** button at the right end of the search
    row opens the on-disk capture folder in a new tab. It replaces the
    *More ▸ Snapshots directory* menu entry, which is gone.
  * The cursor keys, Page Up/Down and Home/End scroll the table
    without clicking into it first. Click a long URL or prompt and
    they scroll just that cell's box instead.
  * A **Restore** button appears in the Date cell of the one row that
    *Restore last capture* would re-open, so the capture you're
    looking at can be re-opened from where you found it.
    * Only ever on one row, and only for a capture that was saved —
      one closed without saving is still on the toolbar menu, but has
      no row here to sit on.
  * A **Reopen** button sits in the same place on every other row, and
    starts a new capture from what that one saved — its screenshot,
    page, prompt and selection.
    * Any drawings are already part of the saved image, so they can't
      be undone; Reset returns to it rather than to a blank image.
    * Saving adds a new capture and leaves the original alone. An
      artifact you didn't edit keeps pointing at the file it came
      from, so reopening just to add a prompt doesn't duplicate it.
    * Needs "Allow access to file URLs", since it reads the saved
      files back — with the toggle off the button points at the
      file-access banner instead. Anything it can't read is left out,
      and the rest still opens.

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
