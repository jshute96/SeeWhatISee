# TODO.md

## Chrome extension

### Possible features
* Options
  - Choose which actions to show on main context menu
* Docs/help in the app
* Edit image format (PNG/JPG) and size (rescale)

### Possible big features
* Record and save video (or repeated screenshots of interactions)
* Capture full page content as markdown (find the main content pane somehow)
* HTML element picker (like in Chrome dev console) to capture an element

### Optimizations
* Refcount stored images and html and share them between Capture and Ask, rather than making a copy.
* Compress stored html if it's large
* Resize images if they are too large
* Make tests faster, skip unnecessary Chrome capture interactions

## Skills and plugins

### Claude plugin
* Permissions prompts on the re-run of watch skill - can we avoid them?
  - This is https://github.com/jshute96/SeeWhatISee/issues/2.

### Gemini plugin
* Background watching doesn't work because asynchronous background commands aren't supported, so we just have a foreground version of the watch command for now.
* BUG: command doesn't work if multiple gemini's run in workspaces with the same name, because one of their tmp dirs has -1, and we don't know that. See copy-last-snapshot.sh.
* Can we do permissions in the extension automatically?
  - If I don't add them manually, I see Gemini decide it can't run the script, but can read it and will then act as its own interpreter. Crazy.

### Integrating other tools to read captures
* CLI skills that work for other tools
* MCP server version that desktop apps can call

## Ask pages (web chat integration)
* Maybe allow pinning any page, so users can inject with copy/paste widget
* Extensible Ask connectors in options, so users can hook up other pages if they figure out the selectors
