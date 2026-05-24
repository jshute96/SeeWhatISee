# Shared helpers for scripts/release-*.sh. Source this file; do not run
# it directly. Each release script supplies its own version source and
# artifact and reuses these checks so the preconditions stay identical
# across components. Currently only release-extension.sh consumes this,
# but the helper is kept factored out so a future release-plugin.sh (or
# similar) can reuse the same preflight logic.

release_check_gh() {
  command -v gh >/dev/null 2>&1 || { echo "gh CLI not found. Install from https://cli.github.com/."; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh not authenticated. Run 'gh auth login' first."; exit 1; }
}

release_check_clean_main() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree is not clean. Commit or stash changes first."
    git status --short
    exit 1
  fi

  local branch
  branch=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$branch" != "main" ]]; then
    echo "Not on main (on $branch). Switch to main before releasing."
    exit 1
  fi

  git fetch origin main --quiet
  local local_sha remote_sha
  local_sha=$(git rev-parse main)
  remote_sha=$(git rev-parse origin/main)
  if [[ "$local_sha" != "$remote_sha" ]]; then
    echo "Local main ($local_sha) does not match origin/main ($remote_sha)."
    echo "Pull or push so they match before releasing."
    exit 1
  fi
}

release_check_tag_unused() {
  local tag="$1"
  if git rev-parse "$tag" >/dev/null 2>&1; then
    echo "Tag $tag already exists locally."
    exit 1
  fi
  if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
    echo "Tag $tag already exists on origin."
    exit 1
  fi
}

# Installs an ERR trap that prints the cleanup command for an orphaned
# tag. Call AFTER `git push origin TAG` and clear with `trap - ERR` on
# success — otherwise an unrelated later failure would print the wrong
# guidance.
release_install_orphaned_tag_trap() {
  local tag="$1"
  # shellcheck disable=SC2064  # expand $tag now, not at trap time
  trap "echo; echo 'Release failed after the tag was pushed. To clean up and retry:'; echo '  git push --delete origin $tag && git tag -d $tag'" ERR
}

# Echo release-note body to stdout: a static header (typically the
# install URL for this component), separator, then the same auto-generated
# notes `gh release create --generate-notes` would emit. Caller redirects
# to a file and passes it via `--notes-file`.
#
# Args:
#   $1 tag         — e.g. mcp-server-v0.1.1
#   $2 tag_prefix  — used to find the prior release of this component
#                    (so cross-component tags don't leak into the notes).
#                    e.g. "mcp-server-v" or "extension-v"
#   $3 header      — markdown text to prepend (multi-line OK)
release_compose_notes() {
  local tag="$1"
  local tag_prefix="$2"
  local header="$3"

  printf '%s\n\n---\n\n' "$header"

  # Pick the previous release of *this component*, not the most recent
  # tag of any kind. The new tag is first in the descending list (we've
  # already created it locally), so the second is the prior release.
  # Empty if this is the first release of this component — then we let
  # GitHub pick the baseline.
  local prev_tag
  prev_tag=$(git tag --list "${tag_prefix}*" --sort=-v:refname | sed -n 2p)

  if [[ -n "$prev_tag" ]]; then
    gh api repos/{owner}/{repo}/releases/generate-notes \
      -f tag_name="$tag" \
      -f previous_tag_name="$prev_tag" \
      --jq .body
  else
    gh api repos/{owner}/{repo}/releases/generate-notes \
      -f tag_name="$tag" \
      --jq .body
  fi
}

# Remove a leftover GitHub source-archive directory if anything in the
# local environment (gh, a CI hook, manual `gh release download`)
# extracted one next to the repo root. Named `<RepoName>-<tag>/`.
# Safe no-op if the directory doesn't exist.
release_cleanup_extracted_archive() {
  local tag="$1"
  local repo_root
  repo_root=$(git rev-parse --show-toplevel)
  local repo_name
  repo_name=$(basename "$repo_root")
  local dir="$repo_root/${repo_name}-${tag}"
  if [[ -d "$dir" ]]; then
    rm -rf "$dir"
    echo "Removed leftover source-archive directory: ${repo_name}-${tag}"
  fi
}
