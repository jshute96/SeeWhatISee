# SeeWhatISee Privacy Policy

_Last updated: 2026-09-21_

## Summary

**SeeWhatISee does not collect, sell, or share any data.** The extension
has no backend, no analytics, and makes no network requests of its own.
The only time your data leaves your computer is when you choose to send
a capture to a web chatbot.

## What the extension does

SeeWhatISee is a tool for quickly sharing what you see in your browser
with a coding agent (e.g. Claude Code) or web chatbot.

The extension can

- Capture a PNG screenshot of the currently visible tab
- Capture the HTML source of the currently visible tab
- Capture selected text on the currently visible tab
- Capture page URLs and titles
- Capture an image you right-click on a page (fetching it from the same
  URL the page displays it from)
- Write the captured data to your local `Downloads/SeeWhatISee` folder,
  along with a log file (`log.json`) that describes recent captures so
  a local agent can find them quickly
- Show your past captures on a History page, read back from that folder
- Send the capture directly to a web chatbot of your choice (Claude,
  ChatGPT, Gemini, or Google Search), injecting images and text into the
  page's chat box

Data is sent to web chatbots directly by pasting it into the target page
in your browser. SeeWhatISee does not itself log or proxy any data.

Apart from this user-initiated chatbot interaction, everything happens on
your machine and nothing is sent over the network by the extension.

The companion command-line scripts and MCP server also run entirely on your
machine. They only read files in the capture folder and hand them to the
agent you are already running.

## Local files: the capture log

The extension keeps a log (`log.json`) of your captures in the capture
folder, so coding agents can find recent screenshots. Each log entry
contains a timestamp, the filenames of captured screenshots and page contents,
the URL and title of the page, and any prompt you typed on the Capture page.

- **The files on disk are the only copy.** The extension doesn't
  keep any other persistent record of the captures.
- Once `log.json` grows past its cap, the oldest entries are moved into
  `history-<timestamp>.json` files in the same folder.
- Every capture appends one line to `log.json`. The extension never
  rewrites or removes what is already there.
- You can edit or delete `log.json` and history files. You can delete
  saved screenshot files from the capture directory.
- The extension never deletes these files on its own. From the History page,
  you can delete individual history records, and their associated files.

The watch feature (when agents run scripts or the MCP server to wait for
new captures) also uses a few small status files in the same folder to
communicate status with the Capture page. They hold no captured content.

## Extension storage

Chrome's extension storage holds only settings and bookkeeping, never
captured content or log records.

Extension storage is cleared when the extension is removed. Files in your
`Downloads` folder are yours and are left in place.

## Extension permissions

The extension requests only these permissions, which are required for
the capture-and-save workflow described above.

- **`activeTab`**: allows screenshots of the tab you are currently looking at.
- **`contextMenus`**: used for right-click menu entries on the extension's
  toolbar icon, and on images (so you can capture an image you
  right-click on any page).
- **`downloads`**: allows writing the captured PNG/HTML and JSON log files into
  your `Downloads` folder.
- **`storage`**: used to store the settings and bookkeeping described above.
- **`scripting`**: used to read information from the current page
  during capture (HTML source, selected text, page dimensions) and to
  inject the Ask widget and chatbot-paste helper into supported chatbot
  sites.
- **`clipboardWrite`**: used for actions that copy filenames, prompt
  text, or screenshot images to the clipboard.
- **`offscreen`**: lets the background service worker host a single
  hidden page whose only job is to perform the clipboard write
  described above. The extension can't write to the clipboard directly
  without using that page.
- **Host permission `<all_urls>`**
  - required so the screenshot and HTML-snapshot commands work on any
    site you are viewing.
  - used on chatbot sites (claude.ai, chatgpt.com, gemini.google.com,
    google.com) to inject images and prompts into the chat box.

### File URL permission

The extension also needs the **Allow access to file URLs** option on
the extension's settings page. This is required before any capture; the
extension prompts you to enable it if necessary.

- This grants read-only access to local files. Writes still go
  through the `downloads` permission.
- The extension uses this only to read files in its own capture folder,
  under the `Downloads` directory.
  - It reads `log.json` before appending to it (by writing the file back with
    one additional line).
  - It reads old screenshot files on the History page to show thumbnails.
  - It never reads files anywhere else on your computer, and never sends
    what it reads anywhere.

## Third parties

There are no third parties. The extension does not use any third-party
SDKs, analytics, advertising, or remote services.

## Source code

SeeWhatISee is open source. You can review exactly what the extension
does at [github.com/jshute96/SeeWhatISee](https://github.com/jshute96/SeeWhatISee).

## Contact

Questions or concerns can be filed as an issue on the GitHub repository
linked above.
