# CLAUDE.md

This file provides guidance to agents when working with code in this
repository. See `README.md` for setup instructions and available commands.

## Workflow Rules

- **Documentation**:
  - Keep `docs/*.md` design documents in sync with behavioral changes.
  - Update `docs/file-index.md` when adding, renaming, or removing source files, or when their description should change. The index is a navigation aid meant to describe what the files are now.
  - **`docs/file-index.md` is a one-line-per-file index, NOT a place for design summaries.** Each row gets a single short sentence (≈ 80–120 chars). If you find yourself wanting to explain *how* a file works, that belongs in `architecture.md` or other docs, not the index.
  - **No prose blobs in design docs.** Hard rule: any block of text longer than ~4 lines must be broken up into bullets, sub-sections, or smaller paragraphs. Reviewers should be able to scan the page without reading any single chunk top-to-bottom.
    - If a single concept needs multiple sentences, split it across bullets.
    - If a doc section grows past ~8 lines, give it sub-headings.
    - Prefer bullets to paragraphs; prefer short bullets to long bullets.
  - When adding a new feature, you can add new sections in the relevant design doc rather than appending to an existing one.
  - **Avoid stating counts of list elements in comments or docs.** If there are more than 2-3 items, don't say the count before listing them. That requires unnecessary edits when the list changes.
- **Commit Preparation**:
  - Ensure `README.md` is updated if setup, commands, or user-visible features change.
    - `README.md` is user-facing documentation. Keep it concise and focus on briefly listing what users can do, without a lot of technical details.
    - User docs in `README.md` describe the currently released extension. For new features that won't be available until released, add an item under "Pending docs" in `TODO.md` instead.
  - Always update `docs/file-index.md` when the file set changes or file descriptions become stale.
  - Include all significant changes in the commit message.

## Development Conventions

### Code Logic
- **Documentation**: Where code has subtle or surprising logic, add comments to explain the "why" and intended behavior.

## Planning vs Implementation
When the user asks you to implement something, start coding quickly. Do NOT
spend the entire session planning unless explicitly asked for a plan. If a plan
is needed, keep it concise (bullet points, not paragraphs) and confirm with the
user before elaborating further. Default to action over planning.

## Git & Commits
- Do not commit or push changes without getting user instructions to do so.
- When committing, include ALL relevant changed files — check `git status` before committing to avoid missing files like TODO.md, documentation, or new files.

## Code Changes
- Use the file index to help find relevant files.
- When changing behavior, read existing design docs to understand previous designs and intentions. Ask questions if unsure if we should change those requirements.
- When the user asks for a change, apply it consistently to ALL similar patterns.
- Do NOT drop or overwrite existing content in files like README.md — preserve what's there and add to it.
- When similar logic occurs on multiple parallel paths, use common helper methods when possible, to ensure the logic stays consistent.

## Running tests
- Prefer running a single test file over `npm test` — the full suite (Playwright e2e) is slow.
  - Unit: `node --test tests/unit/<file>.test.mjs`
  - E2E: `npx playwright test tests/e2e/<file>.spec.ts`
- When you do need a full run, start it with Bash `run_in_background: true` so it doesn't block the turn.

## Dev repo vs. release repos for skills

This repo holds **development source**. Users install from separate
release repos that live as siblings of this one:

- `../SeeWhatISee-claude` — the Claude Code plugin marketplace.
  - `skills/claude-plugin/` here → `plugin/` in the release repo.
  - `skills/dot-claude-plugin/` here → `.claude-plugin/` in the release repo.
- `../SeeWhatISee-gemini` — the Gemini CLI extension.
  - Each top-level entry under `skills/dot-gemini/` lands as a
    sibling at the release-repo root — `skills/`, plus top-level
    files like `gemini-extension.json` — *not* nested under a
    `.gemini/` directory.

Publish with the rsync mirror scripts:

- `skills/copy-claude-plugin-release.sh`
- `skills/copy-gemini-extension-release.sh`

Both bail if the release repo isn't cloned next to this one. Files are
copied verbatim (no path rewriting) — anything in the dev tree that
references its own location must use the *release-repo* path
(e.g. `marketplace.json` says `"source": "./plugin"`). See
`docs/claude-plugin.md` for the full story.

## Keep the skill files in sync

The Claude and Gemini skills describe the same `log.json` outputs
and the same steps to take for each. To keep them consistent, they are
**generated from shared templates** in `skills/` — never edit the
generated files directly.

The same generator also propagates `skills/SeeWhatISee.sh` (the
unified backend script behind every per-skill wrapper) into each
release bundle's `scripts/` dir as a verbatim byte-for-byte copy.
Edit the canonical `skills/SeeWhatISee.sh` and re-run the generator —
do not edit the per-bundle copies.

- Templates live in `skills/` (one file per generated target, plus
  shared blocks like `json-record.template.md` and `process.template.md`
  which are embedded via `[[filename]]` placeholders).
- The generator is `skills/generate-skills.py`:
  - `skills/generate-skills.py` — validate that each target matches the
    template output (exits non-zero if any differ). Also wired up as
    `npm run test:skills` and runs as part of `npm test`, so `npm test` will
    fail if the generated files have drifted from the templates.
  - `skills/generate-skills.py --diff` — same validation, but also
    prints a unified diff for each mismatching file.
  - `skills/generate-skills.py --update` — regenerate the target files
    from the templates.
- Generated targets (do not edit these directly):
  - `skills/claude-plugin/skills/see-what-i-see/SKILL.md`
  - `skills/claude-plugin/skills/see-what-i-see-watch/SKILL.md`
  - `skills/claude-plugin/skills/see-what-i-see-stop/SKILL.md`
  - `skills/dot-gemini/skills/see-what-i-see/SKILL.md`
  - `skills/dot-gemini/skills/see-what-i-see-watch/SKILL.md`
  - `skills/dot-gemini/skills/see-what-i-see-xtract/SKILL.md`
  - `skills/claude-plugin/skills/see-what-i-see/scripts/SeeWhatISee.sh` (verbatim copy)
  - `skills/dot-gemini/skills/see-what-i-see/scripts/SeeWhatISee.sh` (verbatim copy)
- When updating behavior shared across skills (e.g. the JSON record shape or
  the processing rules), edit the relevant template in `skills/` and
  re-run the generator so every target picks up the change.
