#!/bin/bash
# 05:45, launchd. Plain code only, no Claude: scan the job boards, check the
# named companies' searches, apply the knock-out rules. Leaves a note
# (dawn-<date>.json) that the 06:00 session and the page read.
cd "$(dirname "$0")/../.." || exit 1
day=$(date +%F)
run_id="${day}-$(date +%H%M)"
state=outreach/state/morning
mkdir -p "$state" logs
echo "== dawn $run_id"
note() {
  printf '{"run_id":"%s","date":"%s","scan_exit":%d,"prepare_exit":%d,"watchlist_exit":%s,"at":"%s"}\n' \
    "$run_id" "$day" "$scan" "$prep" "$1" "$(date -u +%FT%TZ)" > "$state/dawn-$day.json"
}
# caffeinate keeps the Mac awake for the length of each step; a sleep mid-crawl
# showed up as timeouts when this was first run by hand.
(cd career-ops && caffeinate -i node scan.mjs); scan=$?
caffeinate -i node scripts/morning/run.mjs prepare --run-id "$run_id"; prep=$?
# The session can start as soon as this note exists. The named-company check
# takes several minutes, so it runs last and fills in its result afterwards.
note null
caffeinate -i node scripts/check-watchlist.mjs; watch=$?
note "$watch"
echo "== dawn done: scan $scan, watchlist $watch, prepare $prep"
[ "$scan" -eq 0 ] && [ "$prep" -eq 0 ]
