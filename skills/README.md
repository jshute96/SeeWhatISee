# `skills/` — agent-skill sources

Skills users install into a coding agent are mastered and copied out from here.
This includes defining plugins or extensions where possible.

This directory holds in-development code. Released versions are copied out
into peer repositories per target. e.g. `SeeWhatISee-claude`.

- **Files directly in `skills/` are templates you edit.**
- **Subdirectories are the skills packages for particular tools.**
  - Files directly in the subdirectory (README, etc) are edited directly.
  - Files in `skills/` subdirectories are generated from the templates
    using `generate-skills.py`. Do not edit them directly.

## Subdirectories

| Path | What it is | Released to |
|------|------------|-------------|
| `release-claude/` | Complete image of the Claude Code plugin marketplace repo | [SeeWhatISee-claude](https://github.com/jshute96/SeeWhatISee-claude) |
| `release-gemini/` | Complete image of the Gemini CLI extension repo | [SeeWhatISee-gemini](https://github.com/jshute96/SeeWhatISee-gemini) |
| `release-antigravity/` | Complete image of the Google Antigravity plugin repo | [SeeWhatISee-antigravity](https://github.com/jshute96/SeeWhatISee-antigravity) |
| `generic-skills/` | Client-agnostic skill set — reference only | — |
| `mcp/` | Skills that drive the MCP server; also the bodies of the prompts the server serves | — |
| `wrappers/` | Canonical wrapper scripts, copied verbatim into every bundle | — |

A release image maps entry-for-entry onto its release repo's root, so
`release-antigravity/plugin.json` becomes `plugin.json` there. Publish
with the copy scripts below; never edit a release repo directly.

## File patterns

| Pattern | What it is |
|---------|------------|
| `<client>.<skill>.md` | A skill's prompt for one client — `<client>` is `claude`, `gemini`, `generic`, `antigravity` or `mcp-server`; `<skill>` is `see`, `watch`, `stop`, `history` (plus Gemini's `xtract` alias) |
| `*.template.md` | A shared fragment pulled into prompts via a `[[filename]]` placeholder |
| `wrappers/*.sh` | The per-skill shell wrapper for one action; a `.gemini.` in the name means only Gemini uses it |
| `SeeWhatISee.py` | The one Python backend behind every wrapper, copied verbatim into each bundle |
| `copy-*-release.sh` | Publish one release image to its release repo (thin wrappers over `copy-release.sh`) |
| `diff-*.sh` | Dev helpers — open `meld` on two clients' template pairs to compare them |

Which source feeds which generated target is the `PAIRS` table at the
top of `generate-skills.py`. It is the map; this file does not repeat
it.

## Commands

| Command | What it does |
|---------|--------------|
| `./generate-skills.py --update` | Regenerate every target after editing a source |
| `./generate-skills.py` | Validate — fails if a target has drifted (runs as part of `pnpm test`) |
| `./generate-skills.py --diff` | Same, plus a unified diff per mismatch |
| `./copy-release.sh <client> [--dry-run]` | Publish `release-<client>/` to `../SeeWhatISee-<client>/` |

See [`docs/cli_commands.md`](../docs/cli_commands.md) for how the skills
themselves work, and [`docs/claude-plugin.md`](../docs/claude-plugin.md)
/ [`docs/antigravity-plugin.md`](../docs/antigravity-plugin.md) for the
per-client packaging details.
