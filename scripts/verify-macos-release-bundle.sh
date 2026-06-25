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

# v1.6.0 shipped ad-hoc + skipped notarization without anyone noticing because
# `codesign --verify` passes on ad-hoc bundles. The asserts below catch that.

EXPECTED_TEAM_ID=${EXPECTED_TEAM_ID:-GB8P637499}
SIG_INFO=$(codesign -dv --verbose=2 "$APP" 2>&1)

if echo "$SIG_INFO" | grep -q 'Signature=adhoc'; then
  echo "Bundle is ad-hoc signed (expected Developer ID)" >&2
  echo "$SIG_INFO" >&2
  exit 1
fi

if ! echo "$SIG_INFO" | grep -q "TeamIdentifier=${EXPECTED_TEAM_ID}"; then
  echo "Wrong TeamIdentifier (expected ${EXPECTED_TEAM_ID})" >&2
  echo "$SIG_INFO" >&2
  exit 1
fi

ENT=$(codesign -d --entitlements - --xml "$APP" 2>/dev/null || true)
for key in allow-jit allow-unsigned-executable-memory disable-library-validation allow-dyld-environment-variables; do
  if ! printf '%s' "$ENT" | grep -q "com.apple.security.cs.$key"; then
    echo "Missing entitlement: com.apple.security.cs.$key" >&2
    printf '%s\n' "$ENT" >&2
    exit 1
  fi
done

spctl --assess --type execute --verbose=4 "$APP"

xcrun stapler validate "$APP"
