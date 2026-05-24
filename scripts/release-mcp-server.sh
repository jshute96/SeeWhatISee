#!/bin/bash

# Make a new release of @see-what-i-see/mcp-server to npm.
#
# Tag scheme: mcp-server-vX.Y.Z. The "mcp-server-" prefix keeps these
# separate from the Chrome-extension release tags (extension-vX.Y.Z).
# Version source: mcp-server/package.json (single source of truth).
# Artifact: published to the npm registry; no GitHub-attached zip.
#
# Steps:
#   0. Verify gh + npm + that you're logged into npm.
#   1. Verify the working tree is clean, on main, in sync with origin.
#   2. Compute the new version from the requested bump type.
#   3. Verify the resulting tag doesn't exist locally or on origin.
#   4. Run tests + build before mutating any state, so a failing test
#      doesn't pollute git.
#   5. Bump mcp-server/package.json with `npm version --no-git-tag-version`
#      (file-only — no auto-commit or auto-tag from npm).
#   6. Sync the root lockfile so the workspace + lockfile stay aligned.
#   7. Commit the version bump and create the mcp-server-vX.Y.Z tag.
#   8. `npm publish` from inside mcp-server/ (its prepack runs the build,
#      its prepublishOnly runs the tests, so this is the second safety
#      net after step 4).
#   9. Push the commit + tag to origin together.
#  10. Create a GitHub release with auto-generated notes (draft by default).
#
# Usage:
#   scripts/release-mcp-server.sh patch              # 0.1.0 → 0.1.1 (draft GH release)
#   scripts/release-mcp-server.sh minor              # 0.1.0 → 0.2.0
#   scripts/release-mcp-server.sh major              # 0.1.0 → 1.0.0
#   scripts/release-mcp-server.sh patch --publish    # publish the GH release immediately
#   scripts/release-mcp-server.sh patch --no-gh-release   # skip the GH release entirely
#
# NOTE: For the first publish of the package, do it manually once to
# register the name on the npm registry:
#   cd mcp-server && npm publish
# Subsequent releases use this script.
#
# If the publish step fails after the version-bump commit / tag exist
# locally, undo with:
#   git reset --hard HEAD~1 && git tag -d mcp-server-vX.Y.Z

set -euo pipefail

usage() {
  cat <<EOF
Usage: scripts/release-mcp-server.sh (patch|minor|major) [--publish] [--no-gh-release] [--help]

Cuts a new release of @see-what-i-see/mcp-server to npm and creates a
matching GitHub release (draft by default).

Bump type (required):
  patch              0.1.0 → 0.1.1
  minor              0.1.0 → 0.2.0
  major              0.1.0 → 1.0.0

Options:
  --publish          Publish the GitHub release immediately (default: draft).
  --no-gh-release    Skip the GitHub release entirely (npm-only release).
  --help             Show this help and exit.
EOF
}

BUMP=""
DRAFT_FLAG="--draft"
SKIP_GH_RELEASE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major)   BUMP="$1"; shift ;;
    --publish)           DRAFT_FLAG=""; shift ;;
    --no-gh-release)     SKIP_GH_RELEASE=true; shift ;;
    -h|--help)           usage; exit 0 ;;
    *)                   echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$BUMP" ]]; then
  echo "Bump type required (patch / minor / major)." >&2
  usage >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# shellcheck source=scripts/_release-common.sh
source scripts/_release-common.sh

# 0. Preflight.
release_check_gh
command -v npm >/dev/null 2>&1 || { echo "npm not found in PATH."; exit 1; }
if ! npm whoami >/dev/null 2>&1; then
  echo "Not logged into npm. Run 'npm login' first."
  exit 1
fi

# 1. Clean tree on main, in sync with origin/main.
release_check_clean_main

# 2. Compute the new version using simple semver math. Bash-only so we
#    don't depend on an installed `semver` package.
CURRENT=$(node -p "require('./mcp-server/package.json').version")
IFS='.' read -r MAJ MIN PAT <<<"$CURRENT"
case "$BUMP" in
  patch)  NEW="$MAJ.$MIN.$((PAT + 1))" ;;
  minor)  NEW="$MAJ.$((MIN + 1)).0" ;;
  major)  NEW="$((MAJ + 1)).0.0" ;;
esac
TAG="mcp-server-v$NEW"

echo "Releasing $TAG"
echo "  current: $CURRENT"
echo "  new:     $NEW"
echo

# 3. Tag must be free locally and on origin.
release_check_tag_unused "$TAG"

# 4. Tests + build first, so a red test doesn't pollute git state.
echo "Running tests and build..."
npm run test:mcp-server --silent
npm run build:mcp-server --silent

# 5. Bump just the version in mcp-server/package.json. --no-git-tag-version
#    prevents npm from creating its own commit / tag — we control both.
(cd mcp-server && npm version "$NEW" --no-git-tag-version >/dev/null)

# 6. Refresh the root lockfile so it carries the new workspace version.
npm install --silent

# 7. Commit + tag locally. The tag is annotated so it shows up cleanly in
#    `git tag -l --format` and gets a creation date.
git add mcp-server/package.json package-lock.json
git commit -m "mcp-server: $TAG"
git tag -a "$TAG" -m "Release $TAG"

# 8. Publish to npm. prepack → npm run build; prepublishOnly → npm test.
#    If this fails the commit + tag are still local-only and easy to
#    undo (see the script header).
(cd mcp-server && npm publish)

# 9. Now that the registry has the new version, push the commit + tag
#    together. --follow-tags only pushes annotated tags that point at
#    pushed commits, which matches what we just made.
git push --follow-tags

# 10. GitHub release with the bundled binary attached and auto-generated
#     notes prefixed with the npm install URL.
if ! $SKIP_GH_RELEASE; then
  # Stage a versioned copy of the bundle so the asset name on the
  # release page reads as a real version, not a generic name.
  RELEASE_BIN="/tmp/seewhatisee-mcp-v${NEW}.js"
  cp mcp-server/dist/seewhatisee-mcp.js "$RELEASE_BIN"

  NOTES_FILE=$(mktemp)
  trap "rm -f '$NOTES_FILE' '$RELEASE_BIN'" EXIT

  release_compose_notes "$TAG" "mcp-server-v" "\
**Release pushed to npm**. See [package page on npm](https://www.npmjs.com/package/@see-what-i-see/mcp-server) for setup instructions.

**Run the MCP server** with: \`npx -y @see-what-i-see/mcp-server\`

The server is also attached below as \`$(basename "$RELEASE_BIN")\` for direct download (requires Node 22+ to run)." \
    > "$NOTES_FILE"

  gh release create "$TAG" "$RELEASE_BIN" \
    --title "$TAG" \
    --notes-file "$NOTES_FILE" \
    $DRAFT_FLAG
fi

# 11. Clean up the GitHub source-code archive directory if anything
#     extracted one alongside the release. No-op when not present.
release_cleanup_extracted_archive "$TAG"

echo
echo "Released $TAG → https://www.npmjs.com/package/@see-what-i-see/mcp-server/v/$NEW"
if [[ -n "$DRAFT_FLAG" ]] && ! $SKIP_GH_RELEASE; then
  echo "GitHub release drafted — review and publish at the URL above."
fi
