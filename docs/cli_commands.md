# CLI commands

The extension writes captures to disk; two agent CLIs (Claude Code
and Gemini CLI) read them via slash commands. This doc covers:

- what each command does,
- how the two CLIs' versions differ,
- the shell wrappers that back them, and
- the unified `SeeWhatISee.py` backend they all wrap.

## Commands at a glance

| Command                      | Claude Code | Gemini CLI | One-shot or loop |
|------------------------------|-------------|------------|------------------|
| `/see-what-i-see`            | ✓           | ✓          | one-shot         |
| `/see-what-i-see-watch`      | ✓ (async background) | ✓ (foreground loop) | loop |
| `/see-what-i-see-stop`       | ✓           | —          | one-shot         |

Both CLIs' `/see-what-i-see` and `/see-what-i-see-watch` use the
same JSON record schema, share the same canonical "process each
snapshot" block in their prompts, and honor the same `prompt`
field on the record. See
[Skill / command prompts](#skill--command-prompts) below.

## `/see-what-i-see` — describe the latest capture

- **What it does.** Reads the last record in `log.json`, reads any
  referenced files (screenshot, HTML snapshot, selection), and
  describes what it sees. If the record carries a user `prompt`,
  the agent follows that instead of freestyle describing.
- **When to use it.** On demand, after you've clicked the
  extension. Never autonomously — the agent doesn't know when you've
  taken a capture.

### Claude Code

- Backed by `skills/claude-plugin/skills/see-what-i-see/scripts/get-latest.sh`,
  a thin wrapper that `exec`s `SeeWhatISee.py --get-latest`.
- The unified script takes the last record in `log.json` and
  rewrites the `screenshot` / `contents` / `selection` filenames to
  absolute paths under `$DIR`.
- Claude reads referenced files in place from `$DIR` — no copy
  needed.

### Gemini CLI

- Backed by `skills/dot-gemini/skills/see-what-i-see/scripts/copy-last-snapshot.sh`,
  a wrapper that computes the workspace-specific tmp dir and `exec`s
  `SeeWhatISee.py --get-latest --copy-to-dir <tmp>`.
- `--copy-to-dir` triggers the unified script to copy referenced
  files from the source dir into the tmp dir before emitting, so
  the rewritten paths point into `$TARGET_DIR` (where Gemini can
  read them).
- Copy is required because Gemini's sandbox restricts file reads
  to the active workspace's tmp dir; it can't read
  `~/Downloads/SeeWhatISee/` directly.
- The `see-what-i-see-xtract` alias skill ships a one-line wrapper
  at `.../see-what-i-see-xtract/scripts/copy-last-snapshot.sh` that
  `exec`s this same wrapper via `../../see-what-i-see/scripts/...`,
  so there's only one implementation.

## `/see-what-i-see-watch` — keep describing new captures

- **What it does.** Blocks until a new capture arrives, describes
  it, then blocks again for the next. Doesn't return to the user
  until they interrupt.
- **When to use it.** You're iterating on a page and want each
  click to get a description without re-invoking the slash command.
- **`--after` catch-up (Gemini only).** The Gemini foreground
  loop avoids skipping captures that arrived while the agent was
  processing the previous one: each iteration passes the
  just-processed record's `timestamp` as `--after <ts>` on the next
  invocation, which checks `log.json` for unseen records before
  blocking. Claude's `Monitor`-backed watcher doesn't relaunch
  per-event so it doesn't need `--after` — the underlying
  `--loop` keeps streaming every new record without gaps.
- **`--after` is a cursor, not a time comparison.** It locates the
  record carrying that exact `timestamp` and emits whatever follows
  it in log order.
  - Timestamps don't identify a record: a Capture-page session pins
    one and writes a record per save, so re-cropping or editing
    highlights leaves several records sharing it (see
    [`architecture.md`](architecture.md#record-shapes-by-trigger)).
  - So the cursor lands on the *last* record carrying the timestamp.
    Resuming after the first would replay the rest of the run on
    every call and never advance.
  - A timestamp that isn't in `log.json` (typically aged out into an
    archive) warns and falls through to plain watching.

### Claude Code (Monitor + persistent loop)

- Backed by `skills/claude-plugin/skills/see-what-i-see-watch/scripts/watch.sh`,
  a thin wrapper that `exec`s `SeeWhatISee.py --watch --loop --pid-lockfile`.
- Claude Code's `Monitor` tool runs a long-lived process and
  delivers each stdout line as its own notification. The skill
  launches `watch.sh` via `Monitor` with `persistent: true`; the
  `--loop` flag keeps `SeeWhatISee.py` emitting one JSON record
  per capture without exiting, so the agent gets a notification
  per capture without relaunching the watcher.
- `--pid-lockfile` makes the watcher write `.watch.pid` so a second
  invocation auto-kills the first. `/see-what-i-see-stop` runs the
  dedicated `stop.sh` wrapper (sibling skill, which `exec`s
  `SeeWhatISee.py --stop`) to terminate; the previous `Monitor`
  observes the script exit and notifies the agent that the watcher
  stopped.

### Gemini CLI (foreground loop)

- Backed by `skills/dot-gemini/skills/see-what-i-see-watch/scripts/watch-and-copy.sh`,
  a wrapper that computes the workspace tmp dir and `exec`s
  `SeeWhatISee.py --watch --catch-up-one --copy-to-dir <tmp>`.
- Gemini CLI has no async background worker with a completion
  callback, so the loop is built agent-side: each iteration runs
  `watch-and-copy.sh` synchronously, which blocks until there's
  something to emit, copies files, prints one record, and exits.
  The agent then re-invokes with `--after <ts>`.
- `--catch-up-one` constrains `--after` catch-up to a single record
  per invocation (unlike Claude's multi-record default), because the
  agent processes one record per tool call. Multiple pending
  captures are drained by successive iterations.
- No pidfile, no `--stop` (the wrapper omits `--pid-lockfile`).
  The user interrupts Gemini (or tells the agent to stop) to end
  the loop.

## Reading the capture history (`--all` / `--limit`)

No slash command wraps these yet — they're backend actions on
`SeeWhatISee.py` for an agent (or a user) that wants more than the
latest capture.

- **What they read.** The whole history, not just `log.json`: the
  extension keeps recent captures there and flushes older batches to
  `history-<timestamp>.json` archives beside it (see
  [History page](history-page.md)).
- **Order.** Archives oldest first, then `log.json` — one JSONL record
  per line, capture order, same path rewriting (and `--copy-to-dir` /
  `--print_selection` handling) as `--get-latest`.
  - Archives sort by name because each is named for the newest record
    it holds, using the zero-padded stamp capture filenames use. The
    `.json` suffix is stripped before sorting, so a disambiguated
    `history-<stamp>-1.json` lands *after* its base name rather than
    before it (`-` sorts below `.`).
- **Reading only what's needed.** `--limit N` walks the files from the
  newest end and stops as soon as it has N matches, so it never opens
  archives it wouldn't emit from. `--all` reads everything, by
  definition.
- **Actions.**
  - `--all` — every record.
  - `--limit N` — the N most recent records, still emitted oldest
    first. `--limit 1` is `--get-latest`, except when `log.json` holds
    no records — then `--get-latest` errors while `--limit 1` falls
    back to the newest archived record.
  - The two are mutually exclusive, and neither combines with
    `--get-latest` — that would emit the newest record twice, under two
    different empty-history rules.
- **Empty history.** No output, exit 0 — where `--get-latest` errors.
  A listing that finds nothing is a legitimate answer; "describe the
  latest capture" with no captures is not.

### Filters

They apply before `--limit` counts, so `--limit N` means "N most recent
*matching*".

- `--search "words"` — every whitespace-separated word must appear in
  the record's url, title, or prompt (case-insensitive, any field, any
  order). Same rule as the History page's search box, so the two agree
  on what a query means.
- `--filter_site "str"` — substring match against the host of the
  record's url, including any `:port`. Only `http(s)` urls have a host,
  so `file://` / `chrome://` captures never match.
- `--filter_time SPAN` — the capture's `timestamp` falls inside SPAN.
  See [Time spans](#time-spans) below.
- Any of them with neither `--all` nor `--limit` means `--limit 10`. A
  bare search is an interactive "what did I capture about X" question,
  and a whole history of matches is rarely the wanted answer; `--all`
  opts out of the cap.
- An empty or whitespace-only value is an error (exit 2), not a filter
  that matches everything — an agent interpolating an empty query
  would otherwise get a clean exit that reads as "no captures".
- None of them dedupe, where the History page renders through
  `dedupeRecords()`. **Restore last capture** re-saved unchanged
  therefore appears twice, and costs `--limit N` a slot.
- They scope the listing only. Combined with `--watch`, every record
  that arrives afterwards is emitted regardless — a watcher that
  silently dropped the capture the user just took would look broken.

### Time spans

`--filter_time` takes a span, never an instant.

- **A point names a unit, and matches all of it.** `2026-04` is April;
  `2026-04-08 20` is that hour; a full `2026-04-08T20:30:12.345` is that
  millisecond. So a value pasted from a record's `timestamp` matches
  that record, and a shorter one widens the window.
- **Ranges use `..`,** inclusive of both endpoints' whole units:
  `2026-04..2026-05` is April *and* May. Either end may be omitted for
  an open range (`2026-04-08..`, `..2026-03`).
  - `-` and `:` can't serve as the separator because both occur inside
    the values. In `2026-04-08T20:30..2026-04-08T21:00` a `:` separator
    would sit between two digits exactly like the one in `20:30`, with
    nothing to distinguish them. `.` appears only before fractional
    seconds, and never doubled.
- **Accepted forms.** `YYYY`, `-MM`, `-DD`, then a time after a `t` or
  a space, cut off at any component. Leading zeros are optional, and
  `t` / `z` are case-insensitive.
  - Spacing is forgiving: a run of spaces reads as one, and spaces
    around `..` or at either end of the value are ignored.
  - The compact stamp capture filenames carry is accepted too —
    `screenshot-20260822-132959-259.png` → `20260822-132959-259`.
    - It truncates from the right like the other forms: `20260822-13`
      is that hour, `202608` that month. Shapes no filename can
      produce, like `20260822-13-259`, are rejected.
    - Its fixed-width fields run together, which is what tells it from
      the dashed forms: a leading digit run longer than four can only
      be this (`YYYYMM`, six digits, is the shortest).
    - Filenames stamp local time (see [Save directory + metadata
      sidecar](architecture.md#save-directory--metadata-sidecar)),
      which is the default anyway; a trailing `z` still overrides.
  - A time alone means today: `14:30`, or `14:` for that whole hour. The
    colon is what marks it as a time — a bare `3` is rejected rather
    than guessed at, and a bare `1430` is read as the *year* 1430.
  - `today` and `yesterday` are accepted, with an optional time
    (`yesterday 14:30`).

#### Time zones

- **Local unless the value ends in `z`,** which means UTC. Records store
  UTC (`CaptureRecord.timestamp` is ISO 8601 `Z`), but the History page
  renders local time, so a date the user names is the local one they saw
  there. `2026-04-08z` asks for the UTC day instead.
- A copied `2026-04-08T20:30:12.345Z` therefore needs no special case —
  its trailing `Z` already says UTC.
- `today` / `yesterday` and bare times resolve against "now" in whichever
  zone the value asks for, so `14:z` is the 14:00 UTC hour of today's
  UTC date.
- **Daylight saving falls out of the comparison.** Spans are matched as
  wall-clock readings in the requested zone rather than as converted
  instants, so a local date is simply every instant that reads as that
  date.
  - A transition day is 23 or 25 hours long, as the zone requires.
  - An hour that runs twice matches both times.
  - An hour that never happened (`2026-03-08 02` in New York) matches
    nothing, rather than silently resolving to a neighboring hour.
- **Mixed-zone ranges are an error.** One end marked `z` and the other
  not is far more often a forgotten suffix than a deliberate mix, and it
  would silently shift one edge of the window by the zone offset.
- Malformed spans fail at startup (exit 2), not as an empty listing.

### Reading the records

- Every line goes through `json.loads`, so fields are read from the
  parsed record rather than matched in raw text. Search terms
  containing quotes, backslashes, or escaped characters behave like any
  other text, and case-folding is Unicode-aware — the same as the
  History page's `toLowerCase()`.
- A line that isn't a JSON object is skipped, the same leniency
  `parseLogText` applies on the extension side: these files live in the
  user's Downloads folder and can be hand-edited, truncated mid-write,
  or concatenated. Losing one row beats losing the file.
- Emitted records are re-serialized compactly, so surrounding
  whitespace and stray carriage returns from a hand-edit don't ride
  along into the output.

## `/see-what-i-see-stop` (Claude only)

- Calls `skills/claude-plugin/skills/see-what-i-see-stop/scripts/stop.sh`,
  a thin wrapper that `exec`s `SeeWhatISee.py --stop`. The unified
  script resolves the watch directory the same way the watcher
  does, kills the PID stored in `$DIR/.watch.pid`, and removes the
  file. (`watch.sh --stop` reaches the same backend code path,
  since the watch wrapper forwards arbitrary flags through.)
  Gemini has no equivalent — its loop isn't a background process.

## Scripts

Every per-skill script — Claude's get-latest / watch / stop, Gemini's
copy-last-snapshot / watch-and-copy, and the generic set under
`skills/generic-skills/` — is a thin wrapper around a single unified
backend, `SeeWhatISee.py`. Each wrapper
just `exec`s the backend with the right action flag(s) and,
where needed, computes the Gemini target dir for `--copy-to-dir`.

**Runtime.** The wrappers are `bash`; the backend is Python 3 with
nothing outside the standard library, so a bundle still installs by
copying files. `python3` must be on `PATH` — near-universal on Linux,
and on macOS it comes with the Xcode Command Line Tools rather than the
base system.

```
skills/claude-plugin/                ← Claude plugin install tree (mirrored into ../SeeWhatISee-claude/plugin/)
  skills/see-what-i-see/scripts/SeeWhatISee.py            ← unified backend (verbatim copy of skills/SeeWhatISee.py)
  skills/see-what-i-see/scripts/get-latest.sh             ← /see-what-i-see          → SeeWhatISee.py --get-latest
  skills/see-what-i-see-watch/scripts/watch.sh            ← /see-what-i-see-watch    → SeeWhatISee.py --watch --loop --pid-lockfile
  skills/see-what-i-see-stop/scripts/stop.sh              ← /see-what-i-see-stop     → SeeWhatISee.py --stop
skills/dot-gemini/                   ← Gemini extension tree (mirrored into ../SeeWhatISee-gemini/)
  skills/see-what-i-see/scripts/SeeWhatISee.py            ← unified backend (verbatim copy of skills/SeeWhatISee.py)
  skills/see-what-i-see/scripts/copy-last-snapshot.sh     ← /see-what-i-see          → SeeWhatISee.py --get-latest --copy-to-dir <tmp>
  skills/see-what-i-see-watch/scripts/watch-and-copy.sh   ← /see-what-i-see-watch    → SeeWhatISee.py --watch --catch-up-one --copy-to-dir <tmp>
  skills/see-what-i-see-xtract/scripts/copy-last-snapshot.sh
                                                          ← /see-what-i-see-xtract (wrapper → see-what-i-see's copy-last-snapshot.sh)
```

Each install tree is self-contained: each tree carries its own
verbatim copy of `SeeWhatISee.py` next to its `see-what-i-see`
skill's `scripts/` dir. The plugin tree ships as part of the
Claude Code plugin (mirrored into `../SeeWhatISee-claude` by
`skills/copy-claude-plugin-release.sh`); the Gemini tree is
mirrored into `../SeeWhatISee-gemini` (Gemini extension install)
by `skills/copy-gemini-extension-release.sh`. The
`SeeWhatISee.py` copies are kept byte-identical by
`skills/generate-skills.py`, which propagates the canonical
`skills/SeeWhatISee.py`.

Wrappers in `see-what-i-see-watch` / `see-what-i-see-stop` /
`see-what-i-see-xtract` reach across to the see-what-i-see
skill's `scripts/` dir for the backend via
`../../see-what-i-see/scripts/SeeWhatISee.py` (sibling-relative).

### The wrapper scripts

| Wrapper | Forwards to `SeeWhatISee.py` flags | Source → Target | Emits |
|---------|------------------------------------|------------------|-------|
| `skills/claude-plugin/skills/see-what-i-see/scripts/get-latest.sh`        | `--get-latest`                                  | `$DIR` (in place) | last record |
| `skills/claude-plugin/skills/see-what-i-see-watch/scripts/watch.sh`       | `--watch --loop --pid-lockfile` (forwards `--after`, `--print_selection`, `--stop`, `--directory`) | `$DIR` (in place) | one JSON record per capture, streaming until killed |
| `skills/claude-plugin/skills/see-what-i-see-stop/scripts/stop.sh`         | `--stop`                                        | `$DIR` (in place) | none (just stops the watcher) |
| `skills/dot-gemini/skills/see-what-i-see/scripts/copy-last-snapshot.sh`   | `--get-latest --copy-to-dir <tmp>`              | `$SRC_DIR` → `$TARGET_DIR` (copied) | last record |
| `skills/dot-gemini/skills/see-what-i-see-watch/scripts/watch-and-copy.sh` | `--watch --catch-up-one --copy-to-dir <tmp>` (forwards `--after`) | `$SRC_DIR` → `$TARGET_DIR` (copied) | one new record per invocation |

Key differences come from the wrapper-supplied defaults:

- **In-place vs copy.** Claude wrappers omit `--copy-to-dir`, so
  the unified script just rewrites paths in place. Gemini wrappers
  pass `--copy-to-dir <tmp>`, so it also copies referenced files
  into the workspace tmp dir (required by Gemini's sandbox).
- **Loop vs single-emit.** Claude `watch.sh` passes `--loop`, so
  the script stays alive and streams every new record as a
  separate JSON line until killed. Gemini `watch-and-copy.sh`
  passes `--catch-up-one` instead (mutually exclusive with
  `--loop`): each invocation emits at most one record and exits,
  so the agent loops externally.
- **Pidfile.** Only Claude `watch.sh` passes `--pid-lockfile`,
  because only Claude Code has async background tasks with a real
  OS process lifetime the script can manage. Same applies to
  `--stop`, which auto-implies `--pid-lockfile`.
- **Directory resolution.** The unified script supports
  `--directory` and a `.SeeWhatISee` config file
  (`directory=<path>` in `$PWD/.SeeWhatISee` or
  `$HOME/.SeeWhatISee`) on both sides; the Gemini wrappers
  additionally honor a pre-set `$TARGET_DIR` env var (used by
  tests) when computing `--copy-to-dir`.

### `SNAP_REAL_HOME` handling

Snap-installed Gemini CLI mangles `$HOME`. `SeeWhatISee.py`
honors `$SNAP_REAL_HOME` (when set) only for paths it *defaults*
off of `$HOME` — namely the source download dir and the
`.SeeWhatISee` config file lookup in the user's home dir.
Explicit `--directory` and `--copy-to-dir` arguments are taken at
face value, and the Gemini wrappers compute their workspace tmp
target dir off the (Gemini-mangled) `$HOME` deliberately, since
Gemini's tmp dir lives wherever Gemini puts it.

## Skill prompts

Several files drive the prompts:

- `skills/claude-plugin/skills/see-what-i-see/SKILL.md`
- `skills/claude-plugin/skills/see-what-i-see-watch/SKILL.md`
- `skills/claude-plugin/skills/see-what-i-see-stop/SKILL.md`
- `skills/dot-gemini/skills/see-what-i-see/SKILL.md`
- `skills/dot-gemini/skills/see-what-i-see-watch/SKILL.md`
- `skills/dot-gemini/skills/see-what-i-see-xtract/SKILL.md` (alias of `see-what-i-see` — surfaces first in Gemini's autocomplete)

All skill prompts are **generated from templates** in `skills/`,
which are themselves written in SKILL.md format (YAML frontmatter
+ markdown body) for both Claude and Gemini.

Two shared blocks — the **JSON-record block** and the **"Process the
capture:" block** — live as their own files (`json-record.template.md`,
`process.template.md`) and get inlined into each top-level template via
`[[filename]]` placeholders. That keeps those blocks identical
across all generated files.

Platform-specific differences stay in the top-level templates:

- Claude `watch.md` uses the `Monitor` tool with `persistent: true` +
  `--loop` (one notification per capture) + auto-kill-via-pidfile;
  Gemini `watch.md` is a blocking single-shot loop + `--after` re-run.
- Claude `see.md` calls `get-latest.sh`; Gemini `see.md` uses
  `copy-last-snapshot.sh` via `!{...}`.

The generator `skills/generate-skills.py` runs in validate
mode by default (exit 1 on drift), is wired into `pnpm test` via
`pnpm run test:skills`, and has `--diff` / `--update` flags. See
`CLAUDE.md` → "Keep the skill files in sync" for the full
workflow.
