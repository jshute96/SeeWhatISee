# AGENTS.md

This repository is the release mirror of the **Gemini CLI extension** for the SeeWhatISee Chrome extension. Development happens in https://github.com/jshute96/SeeWhatISee — the code here is copied from there to "release" it to users. **Issues and PRs should be filed in that repository.**

See `README.md` for repo context, and [SeeWhatISee/README.md](https://github.com/jshute96/SeeWhatISee/blob/main/README.md) for the extension.

Everything here is generated or mirrored from the dev repo's `skills/release-gemini/` by `skills/copy-gemini-extension-release.sh` — this file and `README.md` included. Don't edit anything here; changes will be overwritten on the next mirror.

Client specifics:

- The extension config is `gemini-extension.json`, and `skills/` sits at the repo root — Gemini installs the repo itself as the extension.
- `install-skills.sh` is the fallback for users who copy the skills in by hand instead of using `gemini extensions install`.
