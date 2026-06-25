#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <Tunara.app|Tunara.dmg>" >&2
  exit 64
fi

INPUT=$1
MOUNT_DIR=

cleanup() {
  if [ -n "${MOUNT_DIR:-}" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

case "$INPUT" in
  *.app)
    APP=$INPUT
    ;;
  *.dmg)
    MOUNT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tunara-dmg.XXXXXX")
    hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_DIR" "$INPUT" >/dev/null
    APP=$(find "$MOUNT_DIR" -maxdepth 1 -name '*.app' -type d -print -quit)
    if [ -z "$APP" ]; then
      echo "No .app bundle found inside $INPUT" >&2
      exit 1
    fi
    ;;
  *)
    echo "Expected a .app bundle or .dmg image, got: $INPUT" >&2
    exit 64
    ;;
esac

if [ ! -f "$APP/Contents/_CodeSignature/CodeResources" ]; then
  echo "Missing bundle signature resources: $APP/Contents/_CodeSignature/CodeResources" >&2
  codesign -dv --verbose=4 "$APP" 2>&1 || true
  exit 1
fi

EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
EXECUTABLE_PATH="$APP/Contents/MacOS/$EXECUTABLE"

if otool -L "$EXECUTABLE_PATH" | grep -Eq '[[:space:]](/opt/homebrew|/usr/local)/'; then
  echo "Release executable links to non-system dylibs:" >&2
  otool -L "$EXECUTABLE_PATH" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$APP"
