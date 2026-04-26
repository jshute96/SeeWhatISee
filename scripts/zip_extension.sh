#!/bin/bash

# Make a zip file for distributing the extension.
#
# Default output:           /tmp/SeeWhatISee.zip
# With --release VERSION:   /tmp/SeeWhatISee-extension-vVERSION.zip
#
# The versioned name is used by scripts/release-extension.sh so the
# downloaded release artifact is self-identifying. The "extension-"
# prefix matches the extension-vX.Y.Z tag scheme.

set -e

usage() {
  cat <<EOF
Usage: scripts/zip_extension.sh [--release VERSION] [--help]

Builds the extension and zips dist/ for distribution.

Options:
  --release VERSION   Tag the zip with VERSION
                      (/tmp/SeeWhatISee-extension-vVERSION.zip).
                      Default is /tmp/SeeWhatISee.zip.
  --help              Show this help and exit.
EOF
}

VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      if [[ -z "${2:-}" || "$2" == -* ]]; then
        echo "--release requires a VERSION argument" >&2
        usage >&2
        exit 2
      fi
      VERSION="$2"
      shift 2
      ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

if [[ -n "$VERSION" ]]; then
  TARGET="/tmp/SeeWhatISee-extension-v${VERSION}.zip"
else
  TARGET="/tmp/SeeWhatISee.zip"
fi

npm run build

rm -f "$TARGET"
cd dist && zip -r "$TARGET" .

echo
echo "Made zip file in $TARGET"
