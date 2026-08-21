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
    - Maybe convert object types if you drew the wrong one (box/redact/crop, or line/arrow)
* A Redo button or menu item (the ctrl-Y / ctrl-shift-Z shortcuts are done)

### Possible big features
* Record and save video (or repeated screenshots of interactions)
* Capture full page content as markdown (find the main content pane somehow)
* HTML element picker (like in Chrome dev console) to capture an element
* Capture selection on pages with complex text canvas widgets (e.g. Google Docs). Possibly by hooking a fake Copy operation.

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

* **History page** — a searchable table of recent captures: date,
  screenshot thumbnail, links to the saved HTML / selection files,
  page URL + title, and the prompt.
  * Open it from the **History** entry on the toolbar icon's
    right-click menu, or the **History** button in the header of the
    Capture and Options pages.
  * The search box filters on URL, title, or prompt text.
  * Thumbnails and file links need "Allow access to file URLs"
    enabled for the extension.

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
