# SeeWhatISee Privacy Policy

_Last updated: 2026-04-10_

## Summary

**SeeWhatISee does not collect, transmit, sell, or share any data.** The
extension has no backend, no analytics, and no network requests to any
server. All data stays on your own computer.

## What the extension does

SeeWhatISee is a tool for quickly sharing screenshots of what you see in
your browser with a local coding agent (e.g. Claude Code). When you click
the toolbar icon, or choose an option from its right-click menu, the
extension:

- Captures a PNG screenshot of the currently visible tab, or
- Captures the HTML source of the currently visible tab, and
- Writes the capture to your local `Downloads/SeeWhatISee` folder, along
  with two sidecar files (`latest.json` and `log.json`) that describe
  recent captures so a local agent can find them quickly.

Everything happens on your machine. Nothing is ever sent over the network.

## Local storage: the capture log

The extension writes a log (`log.json`) of recent captures so coding
agents can read multiple recent screenshots. Each log entry contains only
a timestamp, snapshot filename, and the URL of the page.

Since extensions cannot append to a file, the extension maintains the log
in Chrome's local storage (`chrome.storage.local`), and rewrites a copy
in `Downloads` after new screenshots.

The log is limited to the **100 most recent captures**; older entries are
dropped.

The log in Chrome local storage can be cleared by removing the extension,
or choosing _Clear Chrome history_ from the extension's context menu.

## Extension permissions

The extension requests only these permissions, which are required for
the capture-and-save workflow described above.

- **`activeTab`** — allows screenshots of the tab you are currently
  looking at.
- **`contextMenus`** — adds right-click menu entries on the extension's
  toolbar icon.
- **`downloads`** — writes the captured PNG/HTML and JSON metadata files
  into your `Downloads` folder.
- **`storage`** — persists the capture log described above.
- **`scripting`** — used solely to read the HTML of the current page,
  only when you ask to save an HTML snapshot. No other code is injected
  or run.
- **Host permission `<all_urls>`** — required so the screenshot and
  HTML-snapshot commands work on any site you are viewing.

## Third parties

There are no third parties. The extension does not use any third-party
SDKs, analytics, advertising, or remote services.

## Source code

SeeWhatISee is open source. You can review exactly what the extension
does at [github.com/jshute96/SeeWhatISee](https://github.com/jshute96/SeeWhatISee).

## Contact

Questions or concerns can be filed as an issue on the GitHub repository
linked above.
