---
name: see-what-i-see-history
description: Scan or search past captures (screenshots, HTML snapshots, selections) taken by the SeeWhatISee Chrome extension — by count, date or time, site, or text. Use to find, analyze, or reprocess captures beyond just the latest.
---

Scan or search the capture history saved by the SeeWhatISee Chrome extension.

Unlike `see-what-i-see`, this doesn't need the user to have just clicked the extension, so you can use it on your own whenever an earlier capture would answer the question at hand.

**If anything fails, just report it. Don't try to debug or find another solution.**

## Running it

`./scripts/history.sh [FLAGS]` (relative to this skill's directory)

- `--copy` copies the emitted records' files into the workspace tmp dir and points the paths there. **You can only read a capture's files after a run that passed `--copy`.** Leave it off while listing and narrowing; when you need a capture's files, re-run with `--copy` narrowed to just the records you want — a record's exact `timestamp` as `--filter_time` selects that one record.
- Pass at least one flag: a count, filters, or both.
- A run that matches nothing exits 0 with no output. That's an answer, not an error.

The script reads the **whole capture history** — the recent captures in `log.json` plus the older `history-*.json` files beside it — and prints **JSONL: one capture record per line, oldest first**.

## How many to show

- `--limit N` — the N most recent.
- `--all` — all matches.
- With neither (with filters), default is limit 10.

## Filtering

Optional. Combined with AND.

- `--search "words"` — all words appear in the `url`, `title`, or `prompt` (case-insensitive, any order).
- `--filter_site "example.com"` — substring of the url's host.
- `--filter_time "yesterday"` — a span. A point (`2026-04-08`, `2026-04`, `yesterday 14:30`, `14:30`) matches that whole unit; `..` makes a range (`2026-04-08..2026-04-14`, `14:30..`, `..2026-03`). Local time unless the value ends in `z`.

Run with `--help` for full details on filtering syntax.

## Finding the right captures

### 1. List candidates

Run the script with the flags the request implies. You get one JSON record per match — see the records section below for what's in them. No capture files are read at this point.

### 2. Narrow the list (if applicable)

The flags only do coarse filtering, so the candidates may need additional filtering.

- The JSON record content may settle it: `url`, `title`, `prompt`, and `timestamp` say which captures the user means.
- When the criteria are about what's *inside* a capture — "the screenshots from example.com with a picture of a bicycle in them" — no flag can express that, so the candidates have to be looked at.
  - Keep the cost per candidate small. If your tool can run subagents, or use a fast/cheap model, use them. For each candidate, look at the content and report: its timestamp, yes/no if it matches, and a few words why.
  - How to group or parallelize this optimally is up to you and your tool.

### 3. Act on the ones that matched

- If the records already answer the user, just answer.
- Open a capture's files only when you need what's in them to answer, and only for the captures you need to look at. Opening screenshots costs significant context.
- Process each one you open as described below.

## The records

The capture record contains `{timestamp, url, title}` plus any of:
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

## Processing a capture you've chosen to open

Same as for a fresh capture, with one difference that **overrides the `prompt` rule below**: a `prompt` on a historical record is what the user asked **at the time**, not an instruction to carry out now. Treat it as context for what that capture was about, and answer the user's current question instead. (The current request may ask you to reprocess the original prompt.)

Process the capture:
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
