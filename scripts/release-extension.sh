#!/bin/bash

# Cut a GitHub release for the Chrome extension.
#
# Tag scheme: extension-vX.Y.Z. The "extension-" prefix leaves room for
# a separate plugin-vX.Y.Z track in the future.
# Version source: package.json and src/manifest.json (must match).
# Artifact: /tmp/SeeWhatISee-extension-vX.Y.Z.zip (built from dist/).
#
# Steps:
#   0. Verify gh is installed + authenticated.
#   1. Verify versions in package.json and src/manifest.json match.
#   2. Verify the working tree is clean and we're on main, in sync with origin/main.
#   3. Verify the tag doesn't already exist locally or on the remote.
#   4. Build + zip via scripts/zip_extension.sh --release VERSION.
#   5. Create + push an annotated tag.
#   6. gh release create with the zip attached and auto-generated notes.
#      Always creates a draft by default — review and publish from the
#      GitHub UI. Pass --publish to skip the draft step.
#
# Usage:
#   scripts/release-extension.sh             # creates a draft release (default)
#   scripts/release-extension.sh --publish   # publishes immediately, no draft
#
# Bump versions before running by editing both package.json and src/manifest.json.

set -euo pipefail

usage() {
  cat <<EOF
Usage: scripts/release-extension.sh [--publish] [--help]

Cuts a GitHub release for the Chrome extension. By default creates a
draft so you can review and publish from the GitHub UI.

Options:
  --publish   Publish immediately instead of creating a draft.
  --help      Show this help and exit.

Bump the version in package.json and src/manifest.json (must match) and
commit before running.
EOF
}

DRAFT_FLAG="--draft"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish)   DRAFT_FLAG=""; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

# shellcheck source=scripts/_release-common.sh
source scripts/_release-common.sh

# 0. gh preflight.
release_check_gh

# 1. Verify versions match.
PKG_VERSION=$(node -p "require('./package.json').version")
MANIFEST_VERSION=$(node -p "require('./src/manifest.json').version")

if [[ "$PKG_VERSION" != "$MANIFEST_VERSION" ]]; then
  echo "Version mismatch:"
  echo "  package.json:      $PKG_VERSION"
  echo "  src/manifest.json: $MANIFEST_VERSION"
  echo "Bump both to the same value before releasing."
  exit 1
fi

VERSION="$PKG_VERSION"
TAG="extension-v$VERSION"
echo "Releasing $TAG"

# 2. Clean tree on main, in sync with origin/main.
release_check_clean_main

# 3. Tag unused.
release_check_tag_unused "$TAG"

# 4. Build + zip.
bash scripts/zip_extension.sh --release "$VERSION"
ZIP="/tmp/SeeWhatISee-extension-v${VERSION}.zip"
[[ -f "$ZIP" ]] || { echo "Expected zip at $ZIP, not found."; exit 1; }

# 5. Tag + push, then arm the orphaned-tag cleanup hint.
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"
release_install_orphaned_tag_trap "$TAG"

# 6. Create the GitHub release.
gh release create "$TAG" "$ZIP" \
  --title "$TAG" \
  --generate-notes \
  $DRAFT_FLAG

trap - ERR

echo
if [[ -n "$DRAFT_FLAG" ]]; then
  echo "Drafted $TAG. Review and publish at the URL above."
else
  echo "Released $TAG"
fi
