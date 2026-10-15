#!/bin/bash
# Install (or reinstall) the two launchd agents: the 05:45 scan and the 07:00 audit.
# The plists in scripts/launchd/ are templates: __REPO_DIR__ becomes this repo's
# absolute path and __PATH__ the PATH launchd should use (by default the PATH of
# the shell running this script, so node, uv and python3 resolve the same way).
#   JOBHUNT_LAUNCHD_PATH="/opt/homebrew/bin:/usr/bin:/bin" scripts/install-schedule.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
launch_path="${JOBHUNT_LAUNCHD_PATH:-$PATH}"
mkdir -p "$repo/logs" "$HOME/Library/LaunchAgents"
for label in com.jobhunt.scan com.jobhunt.audit; do
  src="$here/launchd/$label.plist"
  dest="$HOME/Library/LaunchAgents/$label.plist"
  REPO_DIR="$repo" LAUNCH_PATH="$launch_path" perl -pe 's/__REPO_DIR__/$ENV{REPO_DIR}/g; s/__PATH__/$ENV{LAUNCH_PATH}/g' "$src" > "$dest"
  plutil -lint "$dest"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dest"
done
echo "installed: scan at 05:45 (logs/scan.log), audit at 07:00 (logs/audit.log)"
