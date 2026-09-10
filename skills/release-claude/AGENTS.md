# AGENTS.md

This repository is the release mirror of the **Claude Code plugin** for the SeeWhatISee Chrome extension. Development happens in https://github.com/jshute96/SeeWhatISee — the code here is copied from there to "release" it to users. **Issues and PRs should be filed in that repository.**

See `README.md` for repo context, and [SeeWhatISee/README.md](https://github.com/jshute96/SeeWhatISee/blob/main/README.md) for the extension.

Everything here is generated or mirrored from the dev repo's `skills/release-claude/` by `skills/copy-claude-plugin-release.sh` — this file and `README.md` included. Don't edit anything here; changes will be overwritten on the next mirror.

Client specifics:

- The plugin config is `.claude-plugin/marketplace.json`. Users only get plugin updates when `plugins[0].version` is bumped.
- When `claude` runs in this directory, `.claude/settings.json` bypasses the installed plugin and points at the local skill sources in `.claude/skills/`, so a change here takes effect immediately.
