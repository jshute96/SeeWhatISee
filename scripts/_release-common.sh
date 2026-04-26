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
