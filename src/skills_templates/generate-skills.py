#!/usr/bin/env python3
"""Generate plugin/.gemini skill files from templates in src/skills_templates/.

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

Templates live alongside this script in src/skills_templates/. Each template may reference
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

# (template filename in src/skills_templates/, target path relative to project root)
PAIRS = [
    ("claude.see.md",   "plugin/skills/see-what-i-see/SKILL.md"),
    ("claude.watch.md", "plugin/skills/see-what-i-see-watch/SKILL.md"),
    ("claude.stop.md",  "plugin/skills/see-what-i-see-stop/SKILL.md"),
    ("claude.help.md",  "plugin/skills/see-what-i-see-help/SKILL.md"),
    ("gemini.see.md",   ".gemini/commands/see-what-i-see.toml"),
    ("gemini.watch.md", ".gemini/commands/see-what-i-see-watch.toml"),
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
    src_dir = script_path.parent           # <project>/src/skills_templates/
    project_root = src_dir.parent.parent   # <project>/

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
    for src_name, target_rel in PAIRS:
        src_path = src_dir / src_name
        target_path = project_root / target_rel
        if not src_path.is_file():
            print(f"  MISSING TEMPLATE  {src_name}")
            any_diff = True
            continue
        generated = expand(src_dir, src_path.read_text())
        current = target_path.read_text() if target_path.is_file() else None
        matches = current == generated

        if update:
            if matches:
                print(f"  unchanged  {target_rel}")
            else:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                target_path.write_text(generated)
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
