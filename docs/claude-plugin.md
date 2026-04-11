# Claude plugin notes

This doc captures what we learned building the SeeWhatISee Claude Code
plugin. Most of it isn't about Claude Code plugins in general — the
official docs cover that — it's about the specific choices this repo
made, the gotchas we hit, and how everything fits together. Official
references:

- <https://code.claude.com/docs/en/plugin-marketplaces>
- <https://code.claude.com/docs/en/plugins-reference>
- <https://code.claude.com/docs/en/skills>
- [*The Complete Guide to Building Skills for Claude*](https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf) (Anthropic PDF)

## What's in this repo

Three things are wired together:

1. **A marketplace** at `.claude-plugin/marketplace.json` (repo root).
2. **A plugin** at `plugin/`, which the marketplace points at via a
   relative `source`.
3. **A local-dev shim** at `.claude/` so the same plugin works when
   running Claude Code directly from this checkout, without having to
   install it from the marketplace.

```
SeeWhatISee/
├── .claude-plugin/
│   └── marketplace.json          # catalog: "here is one plugin, find it at ./plugin"
├── plugin/
│   ├── .claude-plugin/
│   │   └── plugin.json           # plugin manifest (name, version, ...)
│   ├── settings.json             # plugin-level default settings
│   ├── scripts/
│   │   └── watch.sh              # bundled helper script used by skills
│   └── skills/
│       ├── see-what-i-see/SKILL.md
│       ├── see-what-i-see-watch/SKILL.md
│       ├── see-what-i-see-stop/SKILL.md
│       └── see-what-i-see-help/SKILL.md
└── .claude/
    ├── settings.json             # local-dev: sets CLAUDE_PLUGIN_ROOT and permissions
    └── skills/                   # local-dev: symlinks into plugin/skills/
        ├── see-what-i-see       -> ../../plugin/skills/see-what-i-see
        ├── see-what-i-see-watch -> ../../plugin/skills/see-what-i-see-watch
        ├── see-what-i-see-stop  -> ../../plugin/skills/see-what-i-see-stop
        └── see-what-i-see-help  -> ../../plugin/skills/see-what-i-see-help
```

## `marketplace.json`

The marketplace is the catalog a user adds with
`/plugin marketplace add jshute96/SeeWhatISee`. It declares the
marketplace identity (`name`, `owner`) and lists one or more plugins.

Things that were not obvious:

- **`name` and `owner` are required top-level fields.** Early versions
  omitted them and `/plugin marketplace add` failed the schema check
  with separate errors for each missing field (`name: Invalid input:
  expected string, received undefined` and `owner: Invalid input`).
  `name` is a string; `owner` is an object with at least `name`
  (and optional `email`).
- **Plugin entries use `source`, not `path`.** `"source": "./plugin"`
  is a relative path resolved against the marketplace *root* (the
  directory containing `.claude-plugin/`), not against
  `.claude-plugin/` itself.
- **Relative-path sources only work when the marketplace is added via
  git.** If a user adds the marketplace by URL directly to the JSON
  file, relative paths don't resolve and you need a `github`/`url`
  source instead. We use git, so the relative path is fine.
- **Kebab-case names are required.** `see-what-i-see-marketplace` and
  `see-what-i-see` — no spaces, no capitals.

## `plugin/.claude-plugin/plugin.json`

The plugin manifest. Only `name` is strictly required. Everything else
(`description`, `author`, `license`, `repository`, `homepage`,
`keywords`) is optional metadata.

### Where `version` lives (important)

There are up to three places a version field can appear. Only one of
them actually drives update behavior for this plugin:

| Field                                    | What it does |
|------------------------------------------|--------------|
| `marketplace.json` → `plugins[0].version` | **Authoritative** for relative-path plugins. This is what Claude Code uses to decide whether the cached copy is stale. |
| `plugin/.claude-plugin/plugin.json` → `version` | Silently wins over the marketplace entry if both are set. The official guidance is to **omit this** for relative-path plugins; set it only when the plugin ships from git/GitHub/npm/etc. |
| `marketplace.json` → `metadata.version`  | Effectively cosmetic — describes the marketplace itself, not any plugin. Anthropic never increments theirs. Easiest to just leave it out. |

So for this repo (relative-path source `./plugin`), bumping
`plugins[0].version` in `marketplace.json` is the whole story for
triggering updates. `plugin.json` has no `version` field at all, and
`metadata.version` is absent. If the version string doesn't change,
users don't pick up new code even after a `git pull` — the cached
plugin directory is keyed on version, so same version = same cache.

### Duplicated description fields

`description` can appear in three places:

- `metadata.description` — the marketplace.
- `plugins[0].description` — the plugin entry; **this is the load-bearing copy** (what users see in `/plugin` discovery).
- `plugin.json` → `description` — optional metadata.

The other two are optional and can be dropped or left to rot. We keep
`metadata.description` for the marketplace-level blurb but omit the
`description` from `plugin.json` to avoid drift between copies.

## `plugin/settings.json`

Plugin-level default settings, applied when the plugin is enabled.
Per the plugins-reference docs, **only `agent` settings are officially
supported here** — so the `permissions` block we currently ship is at
best unofficial and may be ignored. In practice the skill-level
`allowed-tools` frontmatter is what actually gates tool use; see
below.

## SKILL.md frontmatter

Each skill is a directory under `plugin/skills/<name>/` containing a
`SKILL.md` with YAML frontmatter at the top:

```markdown
---
name: see-what-i-see-watch
description: Start a background loop that watches for new captures ... Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
allowed-tools: "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh:*),Read"
---
```

Things we learned:

- **`description` is how Claude decides whether to auto-invoke the
  skill.** The Anthropic skills guide says it should include both
  *what the skill does* and *when to use it* (trigger conditions), in
  under 1024 characters. Vague descriptions undertrigger; overly broad
  ones overtrigger.
- **`allowed-tools` uses permission patterns, not bare tool names.**
  The format matches the regular permissions system:
  `Bash(path:*)` allows running `path` with any arguments, `Read`
  allows the Read tool unconditionally, `Read(~/Downloads/**)` scopes
  it.
- **Multiple tools are comma-separated inside a single quoted string**
  in the frontmatter: `"Bash(...),Read"`. An earlier version used
  space-separated values and that silently dropped the second entry.
- **`${CLAUDE_PLUGIN_ROOT}` works inside `allowed-tools`.** It's
  substituted at skill-load time to the cached plugin install path, so
  the permission pattern matches the actual script location on disk.
- **The skill `name` field is what gets the `/name` slash-command
  treatment.** Our skill directories and `name:` fields match
  (`see-what-i-see`, `see-what-i-see-watch`, etc.) to keep things
  predictable.

## Install and update flow

When a user runs:

```
/plugin marketplace add jshute96/SeeWhatISee
/plugin install see-what-i-see@see-what-i-see-marketplace
```

roughly this happens:

1. Claude Code clones the marketplace repo into
   `~/.claude/plugins/marketplaces/<marketplace-name>/`. Yes, this
   pulls the *whole* repo (we have a TODO about whether that can be
   avoided — see `TODO.md`).
2. It reads `.claude-plugin/marketplace.json` and finds the
   `see-what-i-see` plugin entry.
3. Because `source` is a relative path, it copies `./plugin` from the
   marketplace clone into the plugin cache at
   `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. Each
   version lives in its own directory; orphaned versions get cleaned
   up about 7 days after they stop being the current version.
4. Skills, hooks, MCP servers, etc. are registered from the cached
   copy. `${CLAUDE_PLUGIN_ROOT}` resolves to that cache directory.

Updates go through `/plugin marketplace update` followed by `/plugin` → update.

- An update is *only* triggered if the plugin's effective version has changed (see the version section above).
- If you push new plugin code with the same version, nothing happens on the user's machine.

**No auto-update for third-party marketplaces.**

- Claude Code auto-refreshes the official Anthropic marketplace on startup but does *not* auto-refresh third-party marketplaces.
- Users have to run `/plugin marketplace update` manually (or `git pull` inside `~/.claude/plugins/marketplaces/<name>/`) before `/plugin` will see new versions.
- There's an open feature request for an auto-update flag, but it's not implemented yet.

**The full marketplace repo gets cloned, even though we only need `./plugin`.**

- This is a git limitation, not a Claude Code one: git can't clone a subdirectory.
- `source: "./plugin"` controls what gets copied into the plugin *cache* at install time, but the marketplace clone in `~/.claude/plugins/marketplaces/` always contains the whole repo.
- The workaround would be splitting the plugin into its own repo (cleaner, but more overhead); for now we live with the full clone since this repo is small.

## `${CLAUDE_PLUGIN_ROOT}`

The absolute path to the plugin's installation directory at runtime.
Usable in:

- Hook and MCP server configs (JSON).
- SKILL.md frontmatter `allowed-tools` patterns.
- Skill body text (it gets substituted inline).
- Any subprocess spawned by the plugin (it's exported as an env var).

We use it so that `plugin/skills/see-what-i-see-watch/SKILL.md` can refer to
`${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh` and have that resolve to wherever the
plugin is installed — the cache directory in the installed case, or the repo
checkout in local development.

- This lets both skills share a single copy of `watch.sh` without the stop
  skill needing a `../see-what-i-see-watch/watch.sh`-style relative path.

There's a companion `${CLAUDE_PLUGIN_DATA}` for persistent state that should
survive plugin updates; we don't use it.

## Local development

When you run Claude Code from this repo without installing the plugin
from the marketplace, the plugin cache isn't involved at all — and
that's where the awkwardness lives.

Two pieces of glue make it work:

### `.claude/settings.json`

```json
{
  "env": {
    "CLAUDE_PLUGIN_ROOT": "plugin"
  },
  "permissions": {
    "allow": [
      "Bash(plugin/scripts/watch.sh:*)"
    ]
  }
}
```

- `CLAUDE_PLUGIN_ROOT=plugin` manually sets the env var that would otherwise
  point into the plugin cache. `plugin` is a working-directory-relative path
  to the in-repo plugin root.
- The `Bash(plugin/scripts/watch.sh:*)` permission is a string match, not a
  resolved-path match.
  - The skill frontmatter pattern `Bash(${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh:*)`
    expands to literally `Bash(plugin/scripts/watch.sh:*)`, which matches.
  - It's a little fragile — the two strings have to line up exactly — but it
    avoids every invocation triggering a permission prompt.

### `.claude/skills/` symlinks

Claude Code auto-discovers user-scope skills from `.claude/skills/<name>/`.
We add symlinks into `plugin/skills/` so that running `/see-what-i-see` in a
local checkout picks up the same SKILL.md files the installed plugin would use:

```
.claude/skills/see-what-i-see       -> ../../plugin/skills/see-what-i-see
.claude/skills/see-what-i-see-watch -> ../../plugin/skills/see-what-i-see-watch
.claude/skills/see-what-i-see-stop  -> ../../plugin/skills/see-what-i-see-stop
.claude/skills/see-what-i-see-help  -> ../../plugin/skills/see-what-i-see-help
```

This is equivalent to `claude --plugin-dir ~/dev/SeeWhatISee/plugin` for
this project, but automatic — you don't have to remember the flag.

### Iterating on skills

After editing a SKILL.md or any plugin file, run `/reload-plugins`
inside the active Claude Code session to pick up changes without
restarting. This reloads skills, hooks, MCP servers, and LSP servers.

## Validating the manifests

The official way to check `marketplace.json` and `plugin.json` against
their schemas is:

```
claude plugin validate .
```

or, inside a session:

```
/plugin validate .
```

Given a directory, this picks up `.claude-plugin/marketplace.json` or
`.claude-plugin/plugin.json` automatically (preferring the marketplace
file if both exist). It also validates SKILL.md frontmatter and
`hooks/hooks.json`.

There's no publicly hosted JSON Schema file you can wire into an IDE
for inline validation. The docs reference a schema URL at
`anthropic.com/claude-code/marketplace.schema.json`, but it's a dead
link at time of writing. For now, `claude plugin validate` is the only
check — run it before committing any manifest changes.

## Gotchas we hit

- **Space vs comma in `allowed-tools`.** Space-separated values look
  like they work but silently register only the first tool. Use
  commas.
- **The "contains expansion" permission prompt on `${VAR}/script` commands with arguments.**
  - Running `${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh` on its own is allowed silently.
  - Running the same script with arguments like `--stop` or `--after FILE` triggers a
    one-time "Contains expansion — do you want to proceed?" prompt.
  - Claude Code is being cautious about variable expansion combined with additional tokens.
  - It's per-pattern and remembered for the session — an annoyance rather than a blocker —
    but it's why `watch.sh --after ...` still prompts even though the plain `watch.sh`
    invocation doesn't.
- **Version bumping only works if the plugin's version changes.**
  Bumping *just* `metadata.version` in `marketplace.json` doesn't
  update installed plugins. You have to bump the plugin entry version
  (for relative-path sources) or `plugin.json`'s `version` (for git
  sources).
- **`..` in skill script paths.** Plugins cached from a marketplace
  can't traverse outside the plugin root via `../`. Keep shared scripts
  inside the plugin dir and reference them via `${CLAUDE_PLUGIN_ROOT}`.
- **Relative-path sources only work over git.** If we ever distribute
  the marketplace as a direct URL to `marketplace.json`, we'd need to
  switch the plugin entry to a `github`/`url` source.
- **Chrome extension's downloads directory is not covered by plugin
  permissions by default.** Reading from `~/Downloads/SeeWhatISee/`
  currently triggers a per-session permission prompt on first use;
  see `TODO.md`. Shipping a `Read(...)` pattern in `plugin/settings.json`
  is our best guess but plugin-level `settings.json` only officially
  supports `agent` settings, so this may not be doing anything.
