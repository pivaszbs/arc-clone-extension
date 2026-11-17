#!/usr/bin/env bash
# Build Anime Study's iPad app for this Mac ("Designed for iPad", Apple Silicon only) and open it.
# Usage: npm run mac            (build + open)
#        npm run mac -- --open  (open the last build without rebuilding)
#
# Release configuration, so the JS bundle is embedded and Metro is not needed.
# Gatekeeper only lets a development-signed iPad app run from the exact path Xcode built it at,
# so the launcher below points at that build instead of copying it elsewhere.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="ios/build/mac"
PRODUCT="$PWD/$OUT/Build/Products/Release-iphoneos/AnimeStudy.app"
LAUNCHER="$PWD/$OUT/Anime Study.app"

if [ "$(uname -m)" != "arm64" ]; then
  echo "iPad apps run only on Apple Silicon Macs." >&2
  exit 1
fi

if [ "${1:-}" != "--open" ]; then
  [ -d ios ] || npx expo prebuild --platform ios

  # The "My Mac (Designed for iPad)" destination, looked up by id because its variant name contains a comma.
  MAC_ID="$(xcodebuild -workspace ios/AnimeStudy.xcworkspace -scheme AnimeStudy -showdestinations 2>/dev/null \
    | grep 'platform:macOS' | grep 'Designed for' | sed -E 's/.*id:([^,]+),.*/\1/' | head -1)"
  if [ -z "$MAC_ID" ]; then
    echo "Xcode lists no 'My Mac (Designed for iPad)' destination for the AnimeStudy scheme." >&2
    exit 1
  fi

  LOG="$OUT/build.log"
  mkdir -p "$OUT"
  echo "Building Release for My Mac (log: $LOG)…"
  if ! xcodebuild -workspace ios/AnimeStudy.xcworkspace -scheme AnimeStudy -configuration Release \
      -destination "id=$MAC_ID" -derivedDataPath "$OUT" -allowProvisioningUpdates build > "$LOG" 2>&1; then
    grep -E "error:" "$LOG" | sort -u | head -20 >&2
    echo "Build failed; see $LOG" >&2
    exit 1
  fi
fi

if [ ! -d "$PRODUCT" ]; then
  echo "No build at $PRODUCT; run without --open first." >&2
  exit 1
fi

# macOS opens iPad apps through a wrapper bundle: Wrapper/<app> plus a WrappedBundle link.
rm -rf "$LAUNCHER"
mkdir -p "$LAUNCHER/Wrapper"
ln -s "$PRODUCT" "$LAUNCHER/Wrapper/AnimeStudy.app"
ln -s Wrapper/AnimeStudy.app "$LAUNCHER/WrappedBundle"

pkill -f "$PRODUCT/AnimeStudy" 2>/dev/null || true
# LaunchServices sometimes refuses a rebuilt wrapper ("executable is missing"); Xcode's Run always works.
if open "$LAUNCHER" 2>/dev/null; then
  echo "Opened $LAUNCHER"
else
  echo "macOS would not open the wrapper. Opening Xcode: pick 'My Mac (Designed for iPad)' and press ⌘R." >&2
  open ios/AnimeStudy.xcworkspace
fi
