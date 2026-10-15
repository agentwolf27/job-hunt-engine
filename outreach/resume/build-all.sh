#!/bin/bash
# Build, render, lint and gate resumes. Usage: build-all.sh [key ...]   (no key = every spec in the folder)
# A spec is outreach/state/specs/<key>.json; adding a file there is all it takes to get it built and gated.
# Gates, per spec: spec (bullets all in the pool), render, one page, layout lint, fact check, ATS check.
# Exits non-zero if any gate fails for any spec, and says which spec and which gate.
# Overridable for tests: RESUME_SPECS_DIR, RESUME_OUT_DIR, RESUME_POOL (read by build_resume.py), CAREER_OPS_DIR.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GEN="$HERE/build_resume.py"
CO="${CAREER_OPS_DIR:-$ROOT/career-ops}"
SPECS="${RESUME_SPECS_DIR:-$ROOT/outreach/state/specs}"

cd "$CO" || { echo "GATE FAILED: setup (no career-ops folder at $CO)"; exit 1; }

keys=("$@")
if [ ${#keys[@]} -eq 0 ]; then
  for f in "$SPECS"/*.json; do
    [ -e "$f" ] || continue
    k="${f##*/}"; keys+=("${k%.json}")
  done
fi
[ ${#keys[@]} -eq 0 ] && { echo "GATE FAILED: setup (no specs in $SPECS)"; exit 1; }

failed=()
fail() { echo "  GATE FAILED: $2 ($1)"; failed+=("$1: $2"); }

for n in "${keys[@]}"; do
  echo "== $n"
  # Each command's exit code is captured on its own line: piping into tail/sed would hide a failure.
  html=$(python3 "$GEN" "$n" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then echo "  $html"; fail "$n" "spec"; continue; fi
  pdf=$(python3 "$GEN" --pdf-path "$n" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then echo "  $pdf"; fail "$n" "spec"; continue; fi

  out=$(node output/render-own-format.mjs "$html" "$pdf" 2>&1); rc=$?
  echo "$out"
  pages=$(pdfinfo "$pdf" 2>/dev/null | awk '/^Pages:/ {print $2}')
  lint=$(echo "$out" | grep -c "lint:")
  if [ "$pages" != "1" ]; then fail "$n" "one page (got ${pages:-no PDF})"; fi
  if [ "$lint" -ne 0 ]; then fail "$n" "layout lint"; fi
  if [ $rc -ne 0 ] && [ "$pages" = "1" ] && [ "$lint" -eq 0 ]; then fail "$n" "render"; fi

  facts=$(node verify-cv-facts.mjs "$html" 2>&1); rc=$?
  echo "$facts" | grep -v "fact-gate config" | tail -4
  [ $rc -ne 0 ] && fail "$n" "fact check"

  ats=$(node verify-ats.mjs "$html" 2>&1); rc=$?
  echo "$ats" | sed -n 2p
  [ $rc -ne 0 ] && fail "$n" "ATS check"
done

if [ ${#failed[@]} -ne 0 ]; then
  echo "FAILED: ${#failed[@]} gate(s)"
  for f in "${failed[@]}"; do echo "  $f"; done
  exit 1
fi
echo "OK: ${#keys[@]} resume(s) built, one page each, all gates passed"
exit 0
