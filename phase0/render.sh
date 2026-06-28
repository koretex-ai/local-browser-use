#!/usr/bin/env bash
# Render each test page to a 1280x800 PNG at device-scale-factor=1 (1px CSS == 1px image).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for f in "$DIR"/pages/*.html; do
  name="$(basename "$f" .html)"
  out="$DIR/shots/$name.png"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=1280,800 \
    --screenshot="$out" "file://$f" >/dev/null 2>&1
  dims="$(sips -g pixelWidth -g pixelHeight "$out" 2>/dev/null | awk '/pixel/{print $2}' | paste -sd x -)"
  echo "rendered $name -> $out ($dims)"
done
