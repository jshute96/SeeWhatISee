# CLI commands

The extension writes captures to disk; two agent CLIs (Claude Code
and Gemini CLI) read them via slash commands. This doc covers:

- what each command does,
- how the two CLIs' versions differ,
- the shell scripts that back them, and
- the unified `SeeWhatISee.sh` backend they all wrap.

## Commands at a glance

| Command                      | Claude Code | Gemini CLI | One-shot or loop |
|------------------------------|-------------|------------|------------------|
| `/see-what-i-see`            | ✓           | ✓          | one-shot         |
| `/see-what-i-see-watch`      | ✓ (async background) | ✓ (foreground loop) | loop |
| `/see-what-i-see-stop`       | ✓           | —          | one-shot         |
| `/see-what-i-see-help`       | ✓           | —          | one-shot         |

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
  a thin wrapper that `exec`s `SeeWhatISee.sh --get-latest`.
- The unified script `tail -1`s `log.json` and rewrites the
  `screenshot` / `contents` / `selection` filenames to absolute
  paths under `$DIR`.
- Claude reads referenced files in place from `$DIR` — no copy
  needed.

### Gemini CLI

- Backed by `skills/dot-gemini/skills/see-what-i-see/scripts/copy-last-snapshot.sh`,
  a wrapper that computes the workspace-specific tmp dir and `exec`s
  `SeeWhatISee.sh --get-latest --copy-to-dir <tmp>`.
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
- **`--after` catch-up.** Both implementations avoid skipping
  captures that arrived while the agent was processing the
  previous one: each iteration passes the just-processed record's
  `timestamp` as `--after <ts>` on the next invocation, which
  checks `log.json` for unseen records before blocking.

### Claude Code (asynchronous background)

- Backed by `skills/claude-plugin/skills/see-what-i-see-watch/scripts/watch.sh`,
  a thin wrapper that `exec`s `SeeWhatISee.sh --watch --pid-lockfile`.
- Claude Code supports real background tasks. The skill starts
  `watch.sh` with `run_in_background: true` and no timeout; the
  script blocks on `log.json`'s mtime and exits after emitting one
  record. When the task completes, the skill reads its captured
  stdout, describes the record, and launches the next iteration
  (with `--after <ts>`) — again as a background task.
- `--pid-lockfile` makes the watcher write `.watch.pid` so a second
  invocation auto-kills the first. `/see-what-i-see-stop` runs the
  dedicated `stop.sh` wrapper (sibling skill, which `exec`s
  `SeeWhatISee.sh --stop`) to terminate.
- Without `--catch-up-one`, the wrapper emits **all** records since
  `--after` in one go (multi-record emit). Claude processes each.

### Gemini CLI (foreground loop)

- Backed by `skills/dot-gemini/skills/see-what-i-see-watch/scripts/watch-and-copy.sh`,
  a wrapper that computes the workspace tmp dir and `exec`s
  `SeeWhatISee.sh --watch --catch-up-one --copy-to-dir <tmp>`.
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

## `/see-what-i-see-stop` and `/see-what-i-see-help` (Claude only)

- **`/see-what-i-see-stop`.** Calls
  `skills/claude-plugin/skills/see-what-i-see-stop/scripts/stop.sh`,
  a thin wrapper that `exec`s `SeeWhatISee.sh --stop`. The unified
  script resolves the watch directory the same way the watcher
  does, kills the PID stored in `$DIR/.watch.pid`, and removes the
  file. (`watch.sh --stop` reaches the same backend code path,
  since the watch wrapper forwards arbitrary flags through.)
  Gemini has no equivalent — its loop isn't a background process.
- **`/see-what-i-see-help`.** Prints a static text summary of the
  commands. Could be replicated on the Gemini side but is
  low-value there (Gemini's `/help` already lists commands).

## Scripts

All five per-skill scripts (Claude get-latest / watch / stop and
Gemini copy-last-snapshot / watch-and-copy) are now thin wrappers
around a single unified backend, `SeeWhatISee.sh`. Each wrapper
just `exec`s the backend with the right action flag(s) and,
where needed, computes the Gemini target dir for `--copy-to-dir`.

```
skills/claude-plugin/                ← Claude plugin install tree (mirrored into ../SeeWhatISee-claude/plugin/)
  skills/see-what-i-see/scripts/SeeWhatISee.sh            ← unified backend (verbatim copy of skills/SeeWhatISee.sh)
  skills/see-what-i-see/scripts/get-latest.sh             ← /see-what-i-see          → SeeWhatISee.sh --get-latest
  skills/see-what-i-see-watch/scripts/watch.sh            ← /see-what-i-see-watch    → SeeWhatISee.sh --watch --pid-lockfile
  skills/see-what-i-see-stop/scripts/stop.sh              ← /see-what-i-see-stop     → SeeWhatISee.sh --stop
skills/dot-gemini/                   ← Gemini extension tree (mirrored into ../SeeWhatISee-gemini/)
  skills/see-what-i-see/scripts/SeeWhatISee.sh            ← unified backend (verbatim copy of skills/SeeWhatISee.sh)
  skills/see-what-i-see/scripts/copy-last-snapshot.sh     ← /see-what-i-see          → SeeWhatISee.sh --get-latest --copy-to-dir <tmp>
  skills/see-what-i-see-watch/scripts/watch-and-copy.sh   ← /see-what-i-see-watch    → SeeWhatISee.sh --watch --catch-up-one --copy-to-dir <tmp>
  skills/see-what-i-see-xtract/scripts/copy-last-snapshot.sh
                                                          ← /see-what-i-see-xtract (wrapper → see-what-i-see's copy-last-snapshot.sh)
```

Each install tree is self-contained: each tree carries its own
verbatim copy of `SeeWhatISee.sh` next to its `see-what-i-see`
skill's `scripts/` dir. The plugin tree ships as part of the
Claude Code plugin (mirrored into `../SeeWhatISee-claude` by
`skills/copy-claude-plugin-release.sh`); the Gemini tree is
mirrored into `../SeeWhatISee-gemini` (Gemini extension install)
by `skills/copy-gemini-extension-release.sh`. The two
`SeeWhatISee.sh` copies are kept byte-identical by
`skills/generate-skills.py`, which propagates the canonical
`skills/SeeWhatISee.sh`.

Wrappers in `see-what-i-see-watch` / `see-what-i-see-stop` /
`see-what-i-see-xtract` reach across to the see-what-i-see
skill's `scripts/` dir for the backend via
`../../see-what-i-see/scripts/SeeWhatISee.sh` (sibling-relative).

### The wrapper scripts

| Wrapper | Forwards to `SeeWhatISee.sh` flags | Source → Target | Emits |
|---------|------------------------------------|------------------|-------|
| `skills/claude-plugin/skills/see-what-i-see/scripts/get-latest.sh`        | `--get-latest`                                  | `$DIR` (in place) | last record |
| `skills/claude-plugin/skills/see-what-i-see-watch/scripts/watch.sh`       | `--watch --pid-lockfile` (forwards `--loop`, `--after`, `--print_selection`, `--stop`, `--directory`) | `$DIR` (in place) | all new records since `--after`, then watches until killed |
| `skills/claude-plugin/skills/see-what-i-see-stop/scripts/stop.sh`         | `--stop`                                        | `$DIR` (in place) | none (just stops the watcher) |
| `skills/dot-gemini/skills/see-what-i-see/scripts/copy-last-snapshot.sh`   | `--get-latest --copy-to-dir <tmp>`              | `$SRC_DIR` → `$TARGET_DIR` (copied) | last record |
| `skills/dot-gemini/skills/see-what-i-see-watch/scripts/watch-and-copy.sh` | `--watch --catch-up-one --copy-to-dir <tmp>` (forwards `--after`) | `$SRC_DIR` → `$TARGET_DIR` (copied) | one new record per invocation |

Key differences come from the wrapper-supplied defaults:

- **In-place vs copy.** Claude wrappers omit `--copy-to-dir`, so
  the unified script just rewrites paths in place. Gemini wrappers
  pass `--copy-to-dir <tmp>`, so it also copies referenced files
  into the workspace tmp dir (required by Gemini's sandbox).
- **Multi-emit vs single-emit.** Claude `watch.sh` lets `--after`
  emit all newer records (default). Gemini `watch-and-copy.sh`
  passes `--catch-up-one`, capping `--after` at a single record —
  the agent loops externally.
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

Snap-installed Gemini CLI mangles `$HOME`. `SeeWhatISee.sh`
honors `$SNAP_REAL_HOME` (when set) only for paths it *defaults*
off of `$HOME` — namely the source download dir and the
`.SeeWhatISee` config file lookup in the user's home dir.
Explicit `--directory` and `--copy-to-dir` arguments are taken at
face value, and the Gemini wrappers compute their workspace tmp
target dir off the (Gemini-mangled) `$HOME` deliberately, since
Gemini's tmp dir lives wherever Gemini puts it.

## Skill / command prompts

Several files drive the prompts:

- `skills/claude-plugin/skills/see-what-i-see/SKILL.md`
- `skills/claude-plugin/skills/see-what-i-see-watch/SKILL.md`
- `skills/claude-plugin/skills/see-what-i-see-stop/SKILL.md`
- `skills/claude-plugin/skills/see-what-i-see-help/SKILL.md`
- `skills/dot-gemini/skills/see-what-i-see/SKILL.md`
- `skills/dot-gemini/skills/see-what-i-see-watch/SKILL.md`
- `skills/dot-gemini/skills/see-what-i-see-xtract/SKILL.md` (alias of `see-what-i-see` — surfaces first in Gemini's autocomplete)

All skill and command prompts are **generated from templates** in
`skills/`:

Two shared blocks — the **JSON-record block** and the **"Process the
capture:" block** — live as their own files (`json-record.template.md`,
`process.template.md`) and get inlined into each top-level template via
`[[filename]]` placeholders. That keeps those blocks identical
across all generated files.

Platform-specific differences stay in the top-level templates:

- Claude `watch.md` uses `run_in_background: true` + auto-kill-via-pidfile;
  Gemini `watch.md` is a blocking single-shot loop + `--after` re-run.
- Claude `see.md` calls `get-latest.sh`; Gemini `see.md` uses
  `copy-last-snapshot.sh` via `!{...}`.

The generator `skills/generate-skills.py` runs in validate
mode by default (exit 1 on drift), is wired into `npm test` via
`npm run test:skills`, and has `--diff` / `--update` flags. See
`CLAUDE.md` → "Keep the skill/command files in sync" for the full
workflow.
