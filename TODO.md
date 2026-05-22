# TODO.md

## Chrome extension

### Possible features
* Options
  - Choose which actions to show on main context menu
* Docs/help in the app
* Edit image format (PNG/JPG) and size (rescale)
* Drawing tools
  - Drag endpoints of line segments
  - Select tool so we can pick elements to delete or change.
    - Maybe drag to move.
    - Maybe convert object types if you drew the wrong one (box/redact/crop, or line/arrow).

### Possible big features
* Record and save video (or repeated screenshots of interactions)
* Capture full page content as markdown (find the main content pane somehow)
* HTML element picker (like in Chrome dev console) to capture an element
* Capture selection on pages with complex text canvas widgets (e.g. Google Docs). Possibly by hooking a fake Copy operation.

### Optimizations
* Refcount stored images and html and share them between Capture and Ask, rather than making a copy.
* Compress stored html if it's large
* Resize images if they are too large
* Make tests faster, skip unnecessary Chrome capture interactions
* Architecture change to avoid using session storage to hold data and pass between SW and capture page.
  - Instead, keep it in RAM, and pass it back and forth over a port. This avoids 10MB session quota issues.
  - Passing data to Ask page still uses session storage, so it might do the same switch.
* Store HTML (and selection) compressed, at least if they are large.

## Skills and plugins

### Claude plugin
* Is there a way to give the `-watch` skill the Read permission it needs without editing `settings.json`?

### Gemini plugin
* Background watching doesn't work because asynchronous background commands aren't supported, so we just have a foreground version of the watch command for now.
* BUG: command doesn't work if multiple gemini's run in workspaces with the same name, because one of their tmp dirs has -1, and we don't know that. See copy-last-snapshot.sh.
* Fix general unreliability and permissions issues: https://github.com/jshute96/SeeWhatISee/issues/27.

### Integrating other tools to read captures
* CLI skills that work for other tools
* MCP server version that desktop apps can call

## Ask pages (web chat integration)
* Maybe allow pinning any page, so users can inject with copy/paste widget
* Extensible Ask connectors in options, so users can hook up other pages if they figure out the selectors

## Documentation

### Pending docs for features not released yet (1.0.3)

* None yet

### Not documented

* Help buttons
* Polylines (not mentioned)
* Snap-to behavior (snap-to points and edges, snap lines to horizontal / vertical)

#### Large objects

* Screenshots that are >2MB auto-recompress to JPEG if JPEG is ≥10% smaller
* JPG images stay as JPG, event after drawing on them (previous conversion to PNG causes size blowup)
* HTML is omitted on the capture page (with an error) if >2MB
* When capturing an image directly (e.g. from a file: or http: URL ending in .jpg or .png), we just take the image, not a screenshot

#### Keyboard shortcuts

* Hold `Ctrl` when releasing a Line or Arrow — promote it to a multi-segment polyline. Release `Ctrl` to end the chain.
* `Ctrl+Enter` to submit (if `Enter` is set as newline).
