# SeeWhatISee Privacy Policy

_Last updated: 2026-05-06_

## Summary

**SeeWhatISee does not collect, sell, or share any data.** The extension
has no backend, no analytics, and makes no network requests of its own.
The only time your data leaves your computer is when you choose to send
a capture to a web chatbot — see below.

## What the extension does

SeeWhatISee is a tool for quickly sharing what you see in your browser
with a coding agent (e.g. Claude Code) or web chatbot.

The extension can

- Capture a PNG screenshot of the currently visible tab
- Capture the HTML source of the currently visible tab
- Capture selected text on the currently visible tab
- Capture page URLs and titles
- Write the captured data to your local `Downloads/SeeWhatISee` folder, along
  with a sidecar file (`log.json`) that describes recent captures so
  a local agent can find them quickly.
- Send the capture directly to a web chatbot of your choice (Claude, ChatGPT,
Gemini, or Google Search), injecting images and text into the page's chat box.

Data is sent to web chatbots directly by pasting it into the target page in your browser.
SeeWhatISee does not itself log or proxy any data.

Apart from this user-initiated chatbot interaction, everything happens on
your machine and nothing is sent over the network by the extension.

## Local storage: the capture log

The extension writes a log (`log.json`) of recent captures so coding
agents can read multiple recent screenshots. Each log entry contains only
a timestamp, snapshot filename, and the URL of the page.

Since extensions cannot append to a file, the extension maintains the log
in Chrome's local storage (`chrome.storage.local`), and rewrites a copy
in `Downloads` after new screenshots.

The log is limited to the **100 most recent captures**; older entries are
dropped.

You can erase the log at any time via the extension's right-click menu
**More → Clear log history**, which empties both the Chrome-local-storage
log and the on-disk `log.json`. (Screenshot files already written to your
 `Downloads` folder are left in place.)

The log in Chrome local storage also gets cleared when the extension is
removed.

## Extension permissions

The extension requests only these permissions, which are required for
the capture-and-save workflow described above.

- **`activeTab`** — allows screenshots of the tab you are currently
  looking at.
- **`contextMenus`** — adds right-click menu entries on the extension's
  toolbar icon, and on images (so you can capture an image you
  right-click on any page).
- **`downloads`** — writes the captured PNG/HTML and JSON metadata files
  into your `Downloads` folder.
- **`storage`** — persists the capture log described above.
- **`scripting`** — used to read information from the current page
  during capture (HTML source, selected text, page dimensions) and to inject
  the Ask widget and chatbot-paste helper into supported chatbot sites.
- **`clipboardWrite`** — used for actions that copy filenames, prompt
  text, or screenshot images to the clipboard.
- **`offscreen`** — lets the background service worker host a single
  hidden page whose only job is to perform the clipboard write
  described above. The extension can't write to the clipboard directly
  without using that page.
- **Host permission `<all_urls>`**
  - required so the screenshot and HTML-snapshot commands work on any site you are viewing.
  - used on chatbot sites (claude.ai, chatgpt.com, gemini.google.com, google.com) to inject images and prompts into the chat box.

## Third parties

There are no third parties. The extension does not use any third-party
SDKs, analytics, advertising, or remote services.

## Source code

SeeWhatISee is open source. You can review exactly what the extension
does at [github.com/jshute96/SeeWhatISee](https://github.com/jshute96/SeeWhatISee).

## Contact

Questions or concerns can be filed as an issue on the GitHub repository
linked above.
