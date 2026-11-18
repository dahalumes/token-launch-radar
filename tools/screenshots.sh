#!/usr/bin/env bash
# Capture the dashboard screenshots (board, detail, filtered view, method; the gate takes 3 to 4) from a rendered
# output directory, with an installed Chrome/Chromium in headless mode. Development tool only: the
# grader never runs it. 1440x900 keeps the long side at the 1440 cap and the short side over 800.
#
#   tools/screenshots.sh <output dir with dashboard/ and data.js> <detail slug> [chrome binary]
#
# On WSL it drives the Windows Chrome (paths converted with wslpath); elsewhere any chrome on PATH.
set -euo pipefail
out=$(cd "$1" && pwd)
slug=$2
chrome=${3:-}
repo=$(cd "$(dirname "$0")/.." && pwd)
dest="$repo/screenshots"
profile=$(mktemp -d)
trap 'rm -rf "$profile"' EXIT

if [[ -z "$chrome" ]]; then
  for c in chromium chromium-browser google-chrome google-chrome-stable "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"; do
    if command -v "$c" >/dev/null 2>&1 || [[ -x "$c" ]]; then chrome=$c; break; fi
  done
fi
[[ -n "$chrome" ]] || { echo "no Chrome/Chromium found" >&2; exit 1; }

winpath() { if [[ "$chrome" == *.exe ]]; then wslpath -w "$1"; else printf '%s' "$1"; fi; }
page=$(winpath "$out/dashboard/index.html")
page="file:///${page//\\//}"

shot() { # name hash
  local tmp="$profile/$1"
  "$chrome" --headless=new --disable-gpu --no-first-run --hide-scrollbars --force-device-scale-factor=1 \
    --user-data-dir="$(winpath "$profile")" --window-size=1440,900 --virtual-time-budget=3000 \
    --screenshot="$(winpath "$tmp")" "$page$2" >/dev/null 2>&1
  mv "$tmp" "$dest/$1"
  echo "screenshots/$1 $(stat -c %s "$dest/$1") bytes"
}

mkdir -p "$dest"
shot 1-board.png '#/'
shot 2-detail.png "#/p/$slug"
shot 3-filtered.png '#/?tier=early&fam=Trading%20venues&sort=change_7d&dir=desc'
shot 4-method.png '#/method'
