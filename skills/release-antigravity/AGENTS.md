# AGENTS.md

This repository is the release mirror of the **Google Antigravity plugin** for the SeeWhatISee Chrome extension. Development happens in https://github.com/jshute96/SeeWhatISee — the code here is copied from there to "release" it to users. **Issues and PRs should be filed in that repository.**

See `README.md` for repo context, and [SeeWhatISee/README.md](https://github.com/jshute96/SeeWhatISee/blob/main/README.md) for the extension.

Everything here is generated or mirrored from the dev repo's `skills/release-antigravity/` by `skills/copy-antigravity-plugin-release.sh` — this file and `README.md` included. Don't edit anything here; changes will be overwritten on the next mirror.

Client specifics:

- The plugin is the repo root (`plugin.json` sits there, with no `plugin/` subdirectory), so `agy plugin install <git-url>` can install it straight from GitHub.
- `agy` has no plugin update mechanism — updating means running the install again.
