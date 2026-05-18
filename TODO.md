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

### Pending docs for features not released yet (1.0.1)
* Help buttons
* Zoom changes, plus keyboard zoom controls.
  - Ctrl-mousewheel to zoom, or Alt-plus/minus.
  - Ctrl-drag to scroll the image.
* Resizable boxes/redactions by dragging edges
  - Shift to draw without activating drag
* Arrow keys to move box selections (and line endpoints) during drag.
  - Moves by one pixel in the output, regardless of the zoom level.
* Draw polylines or polyarrows via dedicated tool buttons (N-Line, N-Arrow).
  - Finish with Esc, click on the chain head, double-click, or switch tools.
  - Holding Ctrl at mouseup of a plain Line/Arrow draw also promotes to a chain (legacy shortcut; releasing Ctrl ends it).
* Snap-to endpoints/corners/lines.
  - Shift to draw without snap and without grabbing existing edges
  - Ctrl+Shift to draw without grabbing existing edges, snap stays on
  - Ctrl+drag still pans the image
* Upload image from file (on context menu)

### Pending docs for features not released yet (1.0.2)
* Better error handling when Ask script injection is blocked by site policy
* Screenshots that are >2MB auto-recompress to JPEG if JPEG is ≥10% smaller
* JPG images stay as JPG, event after drawing on them (previous conversion to PNG causes size blowup)
* HTML is omitted on the capture page (with an error) if >2MB
* When capturing an image directly (e.g. from a file: or http: URL ending in .jpg or .png), we just take the image, not a screenshot
* Restore last capture - More-menu entry that re-opens the most recently closed Capture page.

### Draft: user-facing explanation of the new drawing behavior

Stitched together from the bullets above. The goal here is to write
this in user-facing language so it can drop into README / a help
popover / a tutorial — concise, no internal jargon, no implementation
details. Refine before shipping.

**Drawing tools (palette)**

* **Box** — drag to draw a red rectangle.
* **Line** — drag to draw a red line.
* **Arrow** — drag to draw a red arrow (head at the release point).
* **N-Line / N-Arrow (polyline)** — multi-segment line / arrow. Each
  click or drag adds another segment from where the previous one
  ended. Finish the chain by pressing **Esc**, **double-clicking**,
  clicking back on the **last point**, clicking back on the
  **starting point** (closes the polygon), or switching tools.
* **Redact** — drag to paint a solid black rectangle over content
  you want to hide.
* **Crop** — drag to crop the image to a region. Drag the edges of
  an existing crop to adjust it; drag past the image edge to remove
  the crop.

**Tip: quick polyline from a regular Line / Arrow draw** — if
mid-draw you decide you want to keep going, hold **Ctrl** (or **⌘**
on Mac) when you release the mouse. That promotes the line to a
multi-segment chain. Releasing Ctrl ends the chain.

**Snap-to** — while drawing or resizing, the cursor pulls onto
nearby:

* line / arrow endpoints (highest priority),
* box corners and the image's corners,
* box edges and existing diagonal lines (closest point along them).

Snap distance is a few pixels. Hold **Shift** to draw without
snapping (and without grabbing edges of existing shapes).

**Lines snap to horizontal / vertical** — while drawing a line or
arrow, if the segment is nearly horizontal or vertical (within a
few pixels), it snaps to exactly horizontal / vertical. Hold
**Shift** to keep the literal angle.

**Modifier cheat sheet**

| You want to… | Press |
|---|---|
| Pan the image | **Ctrl + drag** (or middle-click drag) |
| Zoom the image | **Ctrl + mouse-wheel**, or **Alt + +/−** |
| Draw a new shape over an existing edge, ignoring snap | **Shift + drag** |
| Draw a new shape over an existing edge, with snap on | **Ctrl + Shift + drag** |
| Nudge a drag by one pixel | **Arrow keys** while dragging |
| End a polyline chain | **Esc**, double-click, click the chain start / head, or close the polygon |
| Make a regular Line into a polyline | Hold **Ctrl** when you release the mouse |
