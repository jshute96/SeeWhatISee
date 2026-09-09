# Antigravity plugin notes

Notes on the SeeWhatISee plugin for **Google Antigravity** — Google's
agent-first IDE (a VS Code fork) and its companion `agy` CLI. Official
references:

- <https://antigravity.google/docs/ide/plugins/>
- <https://antigravity.google/docs/ide/skills/>
- <https://antigravity.google/docs/cli/plugins/>

## Why a separate bundle

- Antigravity reads plain `SKILL.md` skills, so it *can* run the
  `skills/generic-skills/` set unchanged.
- But the generic watch skill makes the agent choose between a
  streaming watcher and a polling loop. Antigravity agents were
  observed picking badly, and reading the scripts to decide.
- The Antigravity bundle removes the choice: one watch script, one
  documented loop.
- It also gets a `plugin.json`, so the whole thing installs as one unit
  instead of a set of loose skill folders.

## What Antigravity's plugin format gives us

A plugin is a directory. Only `plugin.json` is required; everything else
is optional:

```
plugin.json                 # name + description
skills/<name>/SKILL.md      # what we ship
rules/                      # unused
mcp_config.json             # unused (see below)
hooks.json                  # unused
```

- Skills inside a plugin behave like standalone skills and surface as
  `/<skill-name>` slash commands.
- `SKILL.md` frontmatter recognizes `name` (optional, defaults to the
  folder name) and `description` (required, used for relevance).
- No `${...}` skill-directory substitution is documented, unlike Claude's
  `${CLAUDE_SKILL_DIR}` — so the skills name scripts the way the generic
  set does: `./scripts/foo.sh` "(relative to this skill's directory)".
- We ship no `mcp_config.json`: the MCP server is installed separately
  and covers the same ground. See `docs/mcp-server.md`.

## Templates

The bundle's SKILL.md files are generated like every other client's,
but it only owns the templates that actually differ:

| Skill     | Template                |
|-----------|-------------------------|
| `see`     | `generic.see.md`        |
| `watch`   | `antigravity.watch.md`  |
| `stop`    | `antigravity.stop.md`   |
| `history` | `generic.history.md`    |

- Where nothing client-specific is needed, the `PAIRS` table in
  `skills/generate-skills.py` — the source-to-target map the generator
  works from — points the Antigravity target straight at the generic
  template.
- That avoids a second identical file that would have to be updated by
  hand every time the generic one changes.
- If Antigravity later needs its own wording for one of those, add an
  `antigravity.<skill>.md` and repoint that one row.

## Install locations

Antigravity discovers plugins by directory, with no marketplace or
git-URL install:

| Scope             | Path                                          |
|-------------------|-----------------------------------------------|
| Global            | `~/.gemini/config/plugins/<plugin-name>/`      |
| Single workspace  | `<workspace>/.agents/plugins/<plugin-name>/`   |
| `agy` CLI         | `agy plugin install <path-to-plugin-dir>`      |

So installing means copying or symlinking the release repo's `plugin/`
dir into one of those paths.

## Dev repo vs. release repo

Same pattern as the Claude plugin (see `docs/claude-plugin.md`):

| Dev path (this repo)         | Release path (`SeeWhatISee-antigravity`) |
|------------------------------|-------------------------------------------|
| `skills/antigravity-plugin/` | `plugin/`                                 |

- Publish with `skills/copy-antigravity-plugin-release.sh`.
- It bails unless `../SeeWhatISee-antigravity` already exists as a
  sibling clone.
- The copy is verbatim `rsync -a --delete`, so anything in the dev tree
  that references its own location must use the *release* path.

## The watch loop

Pinned to the single-shot path — `watch-once.sh` per capture — rather
than the streaming `watch.sh` the generic and Claude bundles use:

- Each run waits for the next capture, prints one JSON record, exits.
- The skill re-runs it with `--after <last timestamp>`, which returns
  immediately if a capture landed while the previous one was being
  processed.
- The published watch session keeps the waiting run visible to the
  extension's Capture page and stoppable from there or from
  `/see-what-i-see-stop`.
- Antigravity runs the script in the background, so the conversation
  stays live while a run waits — unlike the Gemini CLI bundle, which
  uses the same single-shot loop but parks the conversation on it.
- The output is still one record per run, so the agent still drives the
  loop; the streaming path would buy nothing here.

## Capture files are read in place

- Antigravity reads absolute paths outside the workspace, so the
  wrappers hand back real paths under `~/Downloads/SeeWhatISee/`.
- No `--copy-to-dir` staging, unlike the Gemini CLI bundle.
- If that ever stops being true, the fix is the Gemini one: add a
  `--copy` flag to `history.sh` and a copying variant of the watch
  wrapper.

## "Do not read the scripts"

Every Antigravity, Gemini and generic SKILL.md carries an explicit **do not read
the script** line. Without it, agents on those clients often open and study
the shell scripts and `SeeWhatISee.py` before running anything — a large,
pointless context cost on every invocation.
