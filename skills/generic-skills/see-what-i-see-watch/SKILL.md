---
name: see-what-i-see-watch
description: Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
---

Watch for new captures from the SeeWhatISee Chrome extension. Each time a capture arrives, process it as described below, then watch for the next one. Keep looping until the user tells you to stop, or until a failure.

**If anything fails, do not try to debug or fix anything. Just report the failure.**

## Getting captures in a loop

Pick the approach that fits your tool. It comes down to two independent questions:

- Can your tool **stream** a long-running command's output, reading each line as it's printed?
- Can your tool run a command in the **background** and wake you when it produces output or exits?

### If your tool can stream output — streaming watcher

1. **Start the watcher.** Run `./scripts/watch.sh` (relative to this skill's directory) and leave it running. It prints one capture record per line as each capture arrives, and runs until stopped. It writes a pidfile, so `/see-what-i-see-stop` (or a later watcher) can replace it.
   - Run it in the **background** if your tool supports that, so you stay responsive to the user while it waits.
2. **Process each line as it arrives** — each line of stdout is one JSON record (see below).
3. **When the watcher exits:** tell the user it stopped and do NOT restart. It was likely stopped on purpose (via `/see-what-i-see-stop` or by another watcher replacing it).

### Otherwise — single-shot watcher, run in a loop

Each run of `./scripts/watch-once.sh` (no timeout) blocks until the next capture, prints one JSON record, then exits — so you re-run it once per capture:

1. Run `./scripts/watch-once.sh` and wait for it to finish. It prints one JSON record.
2. Process that record (see below).
3. Run `./scripts/watch-once.sh --after <timestamp of that record>` and repeat from step 2.

**Foreground or background:** if your tool can run a command in the background and wake you when it finishes, launch each run in the background — you stay responsive to the user between captures and pick up step 2 when it completes. Otherwise run it in the foreground, which blocks the conversation until each capture arrives.

Always pass `--after <timestamp of the last record you processed>` on the follow-up runs. That makes each run emit the single next capture after that timestamp — returning immediately if one was already waiting.

**On a non-zero exit** (the watcher was killed or errored): tell the user it stopped and do NOT restart.

## Process each snapshot

1. The capture record contains `{timestamp, url, title}` plus any of:
  - `screenshot` — object describing a captured PNG, with:
    - `hasHighlights: true` means the user drew red markup (boxes and/or lines) on top of the screenshot to call attention to specific regions.
    - `hasRedactions: true` means the user blacked out at least one region. Those are deliberately hidden as irrelevant or private — don't comment about them unless asked.
    - `isCropped: true` means the PNG covers only a region the user selected.
  - `contents` — object describing a captured whole-page HTML snapshot, with:
    - `isEdited: true` means the user edited the captured HTML before saving, so it didn't come exactly from the website.
  - `selection` — object describing the user's selected text in the page, with:
    - `format` — one of `"html"`, `"text"`, `"markdown"`.
    - `isEdited: true` — same as `contents.isEdited`.
  - `prompt` — the user's instruction for this capture.
  - `imageUrl` — URL of a specific image the user captured, inside the page.

  A record may have any subset of `screenshot` / `contents` / `selection`, or none of them (meaning the URL and optional `prompt` are the whole payload).

  Each present artifact also has a `filename` field with an absolute path to the file.

  **Look at referenced files only. Don't go fishing for others unless asked to.**

2. Process the capture:
  - If `screenshot` is present, read the screenshot.
    - **If `screenshot.hasHighlights` is `true`, the user has drawn red markup to call attention to specific regions. Focus your description on those marked areas. If a `prompt` is present, it is likely referring to those regions specifically — interpret it in that context.**
  - If `contents` is present, don't read the file up front (HTML can be large); wait until you know what to look for.
  - If `selection` is present, don't read the file until you know what to look for.
  - **If `prompt` is present, treat it as the user's instruction for this capture and act on it directly.** Use the screenshot, HTML, selection, and/or `url` as the subject of that instruction. If no files were saved, the `url` is what the prompt is about.
  - If `prompt` is absent:
    - For screenshots, briefly describe what you see and mention the source `url`. When `screenshot.hasHighlights` is `true`, lead with what's highlighted.
    - For HTML-only captures, report that you have an HTML snapshot from the source `url` and ask the user what they want to know.
    - For selection-only captures, quote or summarize the selected fragment and mention the source `url`.
    - For URL-only captures (no files), report the `url` and ask the user what they want to know about it.
