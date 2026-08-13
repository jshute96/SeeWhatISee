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
* Redo (to go with undo), with ctrl-Z/ctrl-Y shortcuts

### Possible big features
* Record and save video (or repeated screenshots of interactions)
* Capture full page content as markdown (find the main content pane somehow)
* HTML element picker (like in Chrome dev console) to capture an element
* Capture selection on pages with complex text canvas widgets (e.g. Google Docs). Possibly by hooking a fake Copy operation.

### Optimizations
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

### Pending docs for features not released yet (1.0.4)

* While holding a pan drag (`Ctrl+drag`, middle-click drag, or a scrollbar drag), arrow keys pan by one image pixel, snapping the view to whole pixels — for precise alignment against another image
* A pan drag snaps a crop / box edit flush against the edges of the visible pane, so the same box on two captures can be parked identically and flipped between; Shift bypasses
* **Shrink** and the new **View cropped** action moved into a **More…** menu at the bottom of the tool palette, as "Shrink last … to fit content" (the label names what it would shrink — box / redaction / crop) and "Replace with cropped image" (the README's Shrink bullet needs rewording for the new home)
* **View cropped** replaces the image with just the cropped region, as if that was the captured screenshot — drawings survive (clipped to the new frame), a further crop can be drawn inside and applied again, and Undo puts the full image back
* **Clear** is now **Reset** ("Undo all edits"): it goes all the way back to the original capture, undoing any **View cropped** re-frame as well as the drawings, and is itself undoable in one click (the README's Undo/Clear bullet needs the new name)
* **Much larger HTML pages now capture.** Page contents and selection text are stored compressed, so "Content too large for Capture page" appears far less often — the HTML limit is now 4 MB *compressed*, and HTML typically shrinks ~3×, so pages of roughly 12 MB of source go through where 2 MB used to be the ceiling. A very large selection has its own 2 MB compressed limit, and can be dropped without losing the HTML (or the other way round). Saved files and the Edit dialogs are unchanged — everything on disk is still plain text. Text sent to **Ask** — HTML plus any selection, combined — is separately capped at 2 MB, and says so up-front instead of failing after you've written a prompt.
* **Smooth zoom.** `Ctrl + mouse wheel` and trackpad pinch now zoom by a smooth amount instead of jumping between fixed levels, so the image can be set to whatever size suits it, and the point under the cursor stays put as you zoom. Pinch zoom works properly on trackpads (notably Chromebooks, where it used to skip several levels per gesture or not respond at all). Zooming out stops once the image fits the window, and `Ctrl + wheel` anywhere in the lower half of the page — the image, the tool palette, and the space around them — zooms the image instead of accidentally zooming the whole page. The 1× / 2× / 4× / 8× menu items remain as one-click presets, and `Alt +` / `Alt −` step by 2× per press.
* **Image-edit transfer** in the **More…** menu — **Copy image edits** / **Paste image edits** / **Import image edits from last capture** copy a capture's drawings *and* its crop onto another capture of the same size, for lining up before/after screenshots. Paste replaces whatever was there; Undo peels the pasted edits off one at a time and the last click restores what was there before. Items are greyed with a tooltip saying why when there's nothing to paste or the copy came from a differently-sized capture.
* **The Capture page's tool palette works from the keyboard.** `Tab` to a drawing tool and `Space` / `Enter` now selects it (it used to highlight but not stick). The *Zoom…*, *More…* and *Ask* menus are keyboard-navigable: `↓` / `↑` (or `Tab` / `Shift+Tab`) step through the items and wrap, `Home` / `End` jump to the ends, `Enter` picks, and `Esc` closes. While a menu is open `Tab` stays inside it, whichever menu it is. Opening a menu with the keyboard starts on its first item; opening it with the mouse highlights nothing until the first arrow press.

### Not documented

* Help buttons
* Polylines (not mentioned)
* Snap-to behavior (snap-to points and edges, snap lines to horizontal / vertical)

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
