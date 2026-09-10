# CLAUDE.md

This repository is the release mirror of the Claude plugin for the SeeWhatISee Chrome extension. Development happens in https://github.com/jshute96/SeeWhatISee — plugin code is copied here to "release" it to users. **Issues and PRs should be filed in that repository.**

See `README.md` for repo context, and [SeeWhatISee/README.md](https://github.com/jshute96/SeeWhatISee/blob/main/README.md) for the extension.

The plugin config is `.claude-plugin/marketplace.json`. Users only get plugin updates when `plugins[0].version` is bumped.

Everything under `plugin/` and `.claude-plugin/` is generated in the dev repo (`skills/release-claude/`) and mirrored here by `skills/copy-claude-plugin-release.sh`, along with this file, `README.md` and the rest. Don't edit them here — changes will be overwritten on the next mirror.

When `claude` runs in this directory, `.claude/settings.json` bypasses the installed plugin and points at the local skill sources in `.claude/skills/`, so edits made here take effect immediately.
