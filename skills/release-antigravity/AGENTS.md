# AGENTS.md

This repository is the release mirror of the Google Antigravity plugin for the SeeWhatISee Chrome extension. Development happens in https://github.com/jshute96/SeeWhatISee — plugin code is copied here to "release" it to users. **Issues and PRs should be filed in that repository.**

See `README.md` for repo context, and [SeeWhatISee/README.md](https://github.com/jshute96/SeeWhatISee/blob/main/README.md) for the extension.

`plugin.json` and everything under `skills/` are generated in the dev repo (`skills/release-antigravity/`) and mirrored here by `skills/copy-antigravity-plugin-release.sh`. Don't edit them here — changes will be overwritten on the next mirror.

The plugin is the repo root (no `plugin/` subdirectory), so `agy plugin install <git-url>` can install it directly from GitHub.
