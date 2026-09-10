# Antigravity plugin notes

Notes on the SeeWhatISee plugin for **Google Antigravity** and its
`agy` CLI. Official references:

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

The easy path is the `agy` CLI, which accepts a git URL — it shallow-clones
the repo into `~/.gemini/config/plugins/<plugin-name>/`:

```bash
agy plugin install https://github.com/jshute96/SeeWhatISee-antigravity
```

- This is undocumented in Antigravity's own plugin docs, which only show
  a local path, but it works.
- It requires `plugin.json` at the *repo root*, which is why the release
  repo is laid out that way (see below).
- There is no update mechanism: `agy` never re-fetches an installed
  plugin, so the only way to pick up a new version is to run the install
  again (a symlinked clone, below, updates with `git pull` instead).
- Uninstall with `agy plugin uninstall see-what-i-see`.

Otherwise Antigravity discovers plugins by directory:

| Scope             | Path                                          |
|-------------------|-----------------------------------------------|
| Global            | `~/.gemini/config/plugins/<plugin-name>/`      |
| Single workspace  | `<workspace>/.agents/plugins/<plugin-name>/`   |
| `agy` CLI         | `agy plugin install <path-to-plugin-dir>`      |

So a manual install means copying or symlinking a clone of the release
repo into one of those paths.

### Marketplaces are not usable yet

`agy plugin install` also accepts `<plugin>@<marketplace>`, but there's
no way to register a marketplace:

- A marketplace is a `marketplace.json` catalog whose entries carry a
  `url` to a plugin *archive*, fetched and unzipped into a local cache.
- No catalog is registered by default and none is baked into the `agy`
  binary, so any `foo@bar` fails with `unknown marketplace: bar`.
- The related "skill marketplace link" RPC refuses with *"only available
  in Google environments"* — this looks like plumbing for Google's own
  bundled catalog, not opened up yet.

## Dev repo vs. release repo

Same pattern as the Gemini extension (see `docs/cli_commands.md`): each
top-level entry lands as a sibling at the release-repo root.

| Dev path (this repo)                  | Release path (`SeeWhatISee-antigravity`) |
|---------------------------------------|-------------------------------------------|
| `skills/release-antigravity/plugin.json` | `plugin.json`                           |
| `skills/release-antigravity/skills/`     | `skills/`                               |

- The plugin *is* the repo root — that's what `agy plugin install
  <git-url>` needs. There is no `plugin/` subdirectory, unlike the
  Claude release repo.
- Publish with `skills/copy-antigravity-plugin-release.sh`.
- It bails unless `../SeeWhatISee-antigravity` already exists as a
  sibling clone.
- Subdirectories are mirrored with `rsync -a --delete`; top-level files
  are copied without `--delete`, since the release root also holds
  README, LICENSE and other files the dev tree doesn't manage.
- The copy is verbatim, so anything in the dev tree that references its
  own location must use the *release* path.

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
