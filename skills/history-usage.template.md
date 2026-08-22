- Pass at least one flag: a count, filters, or both.
- A run that matches nothing exits 0 with no output. That's an answer, not an error.

The script reads the **whole capture history** — the recent captures in `log.json` plus the older `history-*.json` archives beside it — and prints **JSONL: one capture record per line, oldest first**.

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
