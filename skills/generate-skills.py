#!/usr/bin/env python3
"""Generate the per-client skill bundles from templates in skills/.

Usage:
  generate-skills.py            Validate: check that each target file exactly
                                matches the content generated from its template.
                                Prints one line per target (match / DIFF) and
                                exits 0 if everything matches, 1 if any file
                                differs.
  generate-skills.py --diff     Same as validate, but also prints a unified
                                diff for each mismatching file (via `diff -u`,
                                with the generated content fed on stdin).
  generate-skills.py --update   Write generated content to the target files,
                                overwriting them. Unchanged files are skipped.
  generate-skills.py --help     Show this help and exit.

Templates live alongside this script in skills/. Each template may reference
another template via a `[[filename]]` placeholder; the placeholder is replaced
with the content of the referenced template (recursively). The PAIRS table
below maps each top-level template file to the target file it generates.

Edit the templates (not the generated files). Run with --update after any
change to propagate edits to every target.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

# (template filename in skills/, target path relative to project root,
#  optional transform name applied to the expanded template).
#
# The "verbatim" transform skips template expansion entirely and just
# copies the source file's bytes — used for the SeeWhatISee.py master
# script, which is propagated unchanged into each release-bundle's
# install location so it can be invoked sibling-relative.
#
# A template can feed several targets. Where a client's skill needs
# nothing of its own, point its target at the generic template rather
# than adding an identical <client>.<skill>.md that would have to be
# kept in sync by hand. Only skills that actually differ get their own
# template.
PAIRS = [
    ("claude.see.md",    "skills/release-claude/plugin/skills/see-what-i-see/SKILL.md"),
    ("claude.watch.md",  "skills/release-claude/plugin/skills/see-what-i-see-watch/SKILL.md"),
    ("claude.stop.md",   "skills/release-claude/plugin/skills/see-what-i-see-stop/SKILL.md"),
    ("claude.history.md","skills/release-claude/plugin/skills/see-what-i-see-history/SKILL.md"),
    ("gemini.see.md",    "skills/release-gemini/skills/see-what-i-see/SKILL.md"),
    ("gemini.watch.md",  "skills/release-gemini/skills/see-what-i-see-watch/SKILL.md"),
    ("gemini.stop.md",   "skills/release-gemini/skills/see-what-i-see-stop/SKILL.md"),
    ("gemini.xtract.md", "skills/release-gemini/skills/see-what-i-see-xtract/SKILL.md"),
    ("gemini.history.md","skills/release-gemini/skills/see-what-i-see-history/SKILL.md"),
    # MCP-driven skills. These double as (a) installable skills that drive
    # the `see-what-i-see` MCP server and (b) the prompt bodies the server
    # returns from `prompts/get` — `mcp-server/build-prompts.mjs` reads the
    # same SKILL.md files and inlines their frontmatter + body into the bundle.
    ("mcp-server.see.md",   "skills/mcp/see-what-i-see/SKILL.md"),
    ("mcp-server.watch.md", "skills/mcp/see-what-i-see-watch/SKILL.md"),
    ("mcp-server.stop.md",  "skills/mcp/see-what-i-see-stop/SKILL.md"),
    # Generic skills: a client-agnostic hybrid of the Claude and Gemini
    # sets, with the client-specific workarounds removed. Reference-only
    # (the README points users at them to copy/adapt); not mirrored to a
    # release repo. The wrapper scripts are committed directly; only the
    # SeeWhatISee.py backend is propagated verbatim like the other bundles.
    ("generic.see.md",   "skills/generic-skills/see-what-i-see/SKILL.md"),
    ("generic.watch.md", "skills/generic-skills/see-what-i-see-watch/SKILL.md"),
    ("generic.stop.md",  "skills/generic-skills/see-what-i-see-stop/SKILL.md"),
    ("generic.history.md", "skills/generic-skills/see-what-i-see-history/SKILL.md"),
    # Antigravity plugin: same absolute-path assumptions as the generic
    # set (Antigravity reads capture files in place), but with the watch
    # skill pinned to the single-shot loop instead of offering a choice —
    # the choice is what made Antigravity agents read the scripts. Only
    # watch and stop differ, so see and history reuse the generic ones.
    ("generic.see.md",         "skills/release-antigravity/skills/see-what-i-see/SKILL.md"),
    ("antigravity.watch.md",   "skills/release-antigravity/skills/see-what-i-see-watch/SKILL.md"),
    ("antigravity.stop.md",    "skills/release-antigravity/skills/see-what-i-see-stop/SKILL.md"),
    ("generic.history.md",     "skills/release-antigravity/skills/see-what-i-see-history/SKILL.md"),
    ("SeeWhatISee.py",   "skills/release-claude/plugin/skills/see-what-i-see/scripts/SeeWhatISee.py", "verbatim"),
    ("SeeWhatISee.py",   "skills/release-gemini/skills/see-what-i-see/scripts/SeeWhatISee.py",    "verbatim"),
    ("SeeWhatISee.py",   "skills/generic-skills/see-what-i-see/scripts/SeeWhatISee.py",       "verbatim"),
    ("SeeWhatISee.py",   "skills/release-antigravity/skills/see-what-i-see/scripts/SeeWhatISee.py", "verbatim"),
    # Wrapper scripts. Every bundle that can use a wrapper unchanged gets
    # a verbatim copy from skills/wrappers/, so the one implementation is
    # the only thing to edit. The bodies were identical across bundles
    # already; only the comments had drifted apart, so the shared copies
    # are worded client-neutrally.
    #
    # Gemini's wrappers can't be shared — they compute the workspace tmp
    # dir and pass --copy-to-dir, which no other client needs — but they
    # live in skills/wrappers/ too, named *.gemini.sh, so that every
    # wrapper under a bundle dir is a generated copy and none is edited
    # in place. Gemini shares only stop.sh with the others.
    ("wrappers/get-latest.sh",  "skills/release-claude/plugin/skills/see-what-i-see/scripts/get-latest.sh",      "verbatim"),
    ("wrappers/get-latest.sh",  "skills/generic-skills/see-what-i-see/scripts/get-latest.sh",            "verbatim"),
    ("wrappers/get-latest.sh",  "skills/release-antigravity/skills/see-what-i-see/scripts/get-latest.sh", "verbatim"),
    ("wrappers/stop.sh",        "skills/release-claude/plugin/skills/see-what-i-see-stop/scripts/stop.sh",       "verbatim"),
    ("wrappers/stop.sh",        "skills/release-gemini/skills/see-what-i-see-stop/scripts/stop.sh",          "verbatim"),
    ("wrappers/stop.sh",        "skills/generic-skills/see-what-i-see-stop/scripts/stop.sh",             "verbatim"),
    ("wrappers/stop.sh",        "skills/release-antigravity/skills/see-what-i-see-stop/scripts/stop.sh",  "verbatim"),
    ("wrappers/watch.sh",       "skills/release-claude/plugin/skills/see-what-i-see-watch/scripts/watch.sh",     "verbatim"),
    ("wrappers/watch.sh",       "skills/generic-skills/see-what-i-see-watch/scripts/watch.sh",           "verbatim"),
    ("wrappers/watch-once.sh",  "skills/generic-skills/see-what-i-see-watch/scripts/watch-once.sh",      "verbatim"),
    ("wrappers/watch-once.sh",  "skills/release-antigravity/skills/see-what-i-see-watch/scripts/watch-once.sh", "verbatim"),
    ("wrappers/history.sh",     "skills/release-claude/plugin/skills/see-what-i-see-history/scripts/history.sh", "verbatim"),
    ("wrappers/history.sh",     "skills/generic-skills/see-what-i-see-history/scripts/history.sh",       "verbatim"),
    ("wrappers/history.sh",     "skills/release-antigravity/skills/see-what-i-see-history/scripts/history.sh", "verbatim"),
    ("wrappers/copy-last-snapshot.gemini.sh", "skills/release-gemini/skills/see-what-i-see/scripts/copy-last-snapshot.sh",        "verbatim"),
    ("wrappers/watch-and-copy.gemini.sh",     "skills/release-gemini/skills/see-what-i-see-watch/scripts/watch-and-copy.sh",      "verbatim"),
    ("wrappers/history.gemini.sh",            "skills/release-gemini/skills/see-what-i-see-history/scripts/history.sh",           "verbatim"),
    ("wrappers/xtract-copy-last-snapshot.gemini.sh",
                                              "skills/release-gemini/skills/see-what-i-see-xtract/scripts/copy-last-snapshot.sh", "verbatim"),
]

PLACEHOLDER_RE = re.compile(r"\[\[([^\[\]]+)\]\]")


def expand(src_dir: Path, text: str, stack: tuple = ()) -> str:
    """Recursively expand [[filename]] placeholders with template contents.

    A trailing newline on the included file is stripped so that a placeholder
    sitting inline on a line (e.g. "2. [[foo.md]]") doesn't introduce a blank
    line after substitution.
    """
    def sub(match: re.Match) -> str:
        name = match.group(1).strip()
        if name in stack:
            chain = " -> ".join(stack + (name,))
            raise RuntimeError(f"circular include: {chain}")
        path = src_dir / name
        if not path.is_file():
            raise RuntimeError(f"missing template: {path}")
        inner = path.read_text()
        if inner.endswith("\n"):
            inner = inner[:-1]
        return expand(src_dir, inner, stack + (name,))
    return PLACEHOLDER_RE.sub(sub, text)


def main(argv: list[str]) -> int:
    script_path = Path(argv[0]).resolve()
    src_dir = script_path.parent           # <project>/skills/
    project_root = src_dir.parent          # <project>/

    update = False
    show_diff = False
    for arg in argv[1:]:
        if arg in ("-h", "--help"):
            print(__doc__)
            return 0
        if arg == "--update":
            update = True
        elif arg == "--diff":
            show_diff = True
        else:
            print(f"unknown argument: {arg}", file=sys.stderr)
            print("run with --help for usage", file=sys.stderr)
            return 2

    if update and show_diff:
        print("--diff and --update are mutually exclusive", file=sys.stderr)
        return 2

    verb = "updating" if update else "checking"
    print(f"{verb} {len(PAIRS)} target file(s) (project root: {project_root})")

    any_diff = False
    mismatches: list[tuple[str, Path, str]] = []  # (target_rel, target_path, generated)
    for entry in PAIRS:
        src_name, target_rel, *rest = entry
        transform = rest[0] if rest else None
        src_path = src_dir / src_name
        target_path = project_root / target_rel
        if not src_path.is_file():
            print(f"  MISSING TEMPLATE  {src_name}")
            any_diff = True
            continue
        # The "verbatim" transform skips the [[...]] expansion pass —
        # source code can legitimately contain `[[ ... ]]` sequences
        # that would otherwise be misinterpreted as template includes.
        if transform == "verbatim":
            generated = src_path.read_text()
        elif transform is None:
            generated = expand(src_dir, src_path.read_text())
        else:
            raise RuntimeError(f"unknown transform: {transform!r}")
        current = target_path.read_text() if target_path.is_file() else None
        matches = current == generated

        if update:
            if matches:
                print(f"  unchanged  {target_rel}")
            else:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                target_path.write_text(generated)
                # Preserve the source file's mode bits — matters for the
                # SeeWhatISee.py propagation (exec bit) and is harmless for
                # markdown targets, which inherit 0644 either way.
                target_path.chmod(src_path.stat().st_mode & 0o777)
                print(f"  updated    {target_rel}")
        else:
            if matches:
                print(f"  match      {target_rel}")
            else:
                any_diff = True
                if current is None:
                    print(f"  MISSING    {target_rel}")
                else:
                    print(f"  DIFF       {target_rel}")
                if show_diff:
                    mismatches.append((target_rel, target_path, generated))

    if show_diff and mismatches:
        # Flush before invoking `diff`: the subprocess inherits fd 1 and writes
        # directly, while our own print()s are buffered when stdout isn't a TTY.
        # Without this, piped output (`... --diff | less`, CI logs) comes out
        # with the diff bodies appearing before the "checking..." headers.
        sys.stdout.flush()
        for target_rel, target_path, generated in mismatches:
            print()
            print(f"--- diff for {target_rel} ---")
            sys.stdout.flush()
            # Feed generated content on stdin so we don't need a temp file.
            # Labels make the diff header readable ("current" vs. "generated")
            # instead of showing the literal "-" for stdin.
            current_arg = str(target_path) if target_path.is_file() else os.devnull
            subprocess.run(
                [
                    "diff", "-u",
                    "--label", f"{target_rel} (current)",
                    "--label", f"{target_rel} (generated)",
                    current_arg, "-",
                ],
                input=generated,
                text=True,
            )

    if not update and any_diff:
        hint = "Run with --diff to see diffs, or --update to regenerate"
        print(f"Validation failed: {hint}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
