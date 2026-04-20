# CLI commands

The extension writes captures to disk; two agent CLIs (Claude Code
and Gemini CLI) read them via slash commands. This doc covers:

- what each command does,
- how the two CLIs' versions differ,
- the shell scripts that back them, and
- the per-CLI `_common.sh` helpers they share within each tree.

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

- Backed by `plugin/scripts/get-latest.sh`.
- The script `tail -1`s `log.json`, passes the line through
  `absolutize_paths` (sed rewrite of `screenshot` / `contents` /
  `selection` fields to absolute paths under `$DIR`), and prints to
  stdout.
- The skill prompt tells Claude to run the script, parse the JSON,
  and process the record. Claude reads referenced files in place
  from `$DIR` — no copy needed.

### Gemini CLI

- Backed by `.gemini/scripts/copy-last-snapshot.sh`.
- Same `tail -1` + path rewrite, **plus** it copies referenced
  files from `$SRC_DIR` into `$TARGET_DIR` (a
  Gemini-workspace-specific tmp dir). The rewritten paths point
  into `$TARGET_DIR`.
- Copy is required because Gemini's sandbox restricts file reads
  to the active workspace's tmp dir; it can't read
  `~/Downloads/SeeWhatISee/` directly.

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

- Backed by `plugin/scripts/watch.sh`.
- Claude Code supports real background tasks. The skill starts
  `watch.sh` with `run_in_background: true` and no timeout; the
  script blocks on `log.json`'s mtime and exits after emitting one
  record. When the task completes, the skill reads its captured
  stdout, describes the record, and launches the next iteration
  (with `--after <ts>`) — again as a background task.
- `watch.sh` manages a `.watch.pid` file so a second invocation
  auto-kills the first. `/see-what-i-see-stop` calls
  `watch.sh --stop` to terminate.
- `watch.sh` in one-shot mode (default) can emit **multiple**
  records at once when `--after` points at a timestamp with many
  unseen records after it. Claude processes each.

### Gemini CLI (foreground loop)

- Backed by `.gemini/scripts/watch-and-copy.sh`.
- Gemini CLI has no async background worker with a completion
  callback, so the loop is built agent-side: each iteration runs
  `watch-and-copy.sh` synchronously, which blocks until there's
  something to emit, copies files, prints one record, and exits.
  The agent then re-invokes with `--after <ts>`.
- Always emits **exactly one** record per invocation (unlike
  plugin's multi-record emit), because the agent processes one
  record per tool call. Multiple pending captures are drained by
  successive iterations.
- No pidfile, no `--stop`. The user interrupts Gemini (or tells
  the agent to stop) to end the loop.

## `/see-what-i-see-stop` and `/see-what-i-see-help` (Claude only)

- **`/see-what-i-see-stop`.** Calls `watch.sh --stop`, which kills
  the PID stored in `.watch.pid` and removes the file. Gemini has
  no equivalent — its loop isn't a background process.
- **`/see-what-i-see-help`.** Prints a static text summary of the
  commands. Could be replicated on the Gemini side but is
  low-value there (Gemini's `/help` already lists commands).

## Scripts

```
plugin/scripts/                      ← Claude plugin install tree
  _common.sh                         (shared by the two plugin scripts)
  get-latest.sh                      ← /see-what-i-see
  watch.sh                           ← /see-what-i-see-watch
.gemini/scripts/                     ← Gemini install tree
  _common.sh                         (shared by the two Gemini scripts)
  copy-last-snapshot.sh              ← /see-what-i-see
  watch-and-copy.sh                  ← /see-what-i-see-watch
scripts/                             ← convenience symlinks at repo root
  get-latest.sh, watch.sh            → plugin/scripts/...
  copy-last-snapshot.sh, watch-and-copy.sh
                                     → .gemini/scripts/...
```

Each install tree is self-contained. The plugin tree ships as
part of the Claude Code plugin; the Gemini tree is copied into
`~/.gemini/` by `scripts/gemini-install.sh`.

### The four outer scripts

| Script | Source | Target | Emits | Flags |
|--------|--------|--------|-------|-------|
| `plugin/scripts/get-latest.sh`          | `$DIR` | `$DIR` (in place) | last record | `--directory`, `--help` |
| `plugin/scripts/watch.sh`               | `$DIR` | `$DIR` (in place) | all new records until killed | `--directory`, `--after`, `--loop`, `--stop`, `--help` |
| `.gemini/scripts/copy-last-snapshot.sh` | `$SRC_DIR` → `$TARGET_DIR` | `$TARGET_DIR` (copied) | last record | (none) |
| `.gemini/scripts/watch-and-copy.sh`     | `$SRC_DIR` → `$TARGET_DIR` | `$TARGET_DIR` (copied) | one new record per invocation | `--after`, `--help` |

Key differences:

- **In-place vs copy.** Plugin scripts only rewrite paths; Gemini
  scripts also copy referenced files into the workspace tmp dir
  (required by Gemini's sandbox).
- **Multi-emit vs single-emit.** Plugin `watch.sh` emits every
  record since `--after`, plus keeps watching. Gemini
  `watch-and-copy.sh` emits exactly one per invocation — the agent
  loops externally.
- **Pidfile.** Only `watch.sh` has one, because only Claude Code
  has async background tasks with a real OS process lifetime the
  script can manage.
- **Directory resolution.** Plugin scripts support `--directory`
  and a `.SeeWhatISee` config file (`directory=<path>` in
  `$PWD/.SeeWhatISee` or `$HOME/.SeeWhatISee`); Gemini scripts
  use a fixed `$SRC_DIR` (with `$SNAP_REAL_HOME` fallback for
  snap-installed Gemini) and honor a pre-set `$TARGET_DIR` for
  tests.

### Per-tree `_common.sh` helpers

The two `_common.sh` files have overlapping concerns but distinct
function sets — they're kept separate because each side's helper
is tuned to its environment. More sharing between these is likely
possible.

## Skill / command prompts

Four files drive the prompts:

- `plugin/skills/see-what-i-see/SKILL.md`
- `plugin/skills/see-what-i-see-watch/SKILL.md`
- `.gemini/commands/see-what-i-see.toml`
- `.gemini/commands/see-what-i-see-watch.toml`

All skill and command prompts are **generated from templates** in
`src/skills_templates/`:

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

The generator `src/skills_templates/generate-skills.py` runs in validate
mode by default (exit 1 on drift), is wired into `npm test` via
`npm run test:skills`, and has `--diff` / `--update` flags. See
`CLAUDE.md` → "Keep the skill/command files in sync" for the full
workflow.
