#!/bin/bash
# 07:00, launchd. The outside audit; writes audit-<date>.json for the page.
cd "$(dirname "$0")/../.." || exit 1
echo "== audit $(date +%FT%T)"
caffeinate -i node scripts/audit.mjs all
