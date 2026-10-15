# Architecture

This repo extends [career-ops](https://github.com/santifer/career-ops) (MIT). career-ops does the core
loop: it scans job boards, scores postings against your CV, tailors documents, keeps the tracker, and
fills application forms up to Submit. This repo adds a daily, unattended layer on top of it, plus a few
scanners career-ops does not have.

## Constraints the design follows

- **$0 a month.** Claude runs on an existing Claude Code subscription; no API key is used. Job
  discovery uses the free public Greenhouse, Ashby and Lever APIs. Firecrawl (free tier) is used only
  where those APIs do not reach.
- **career-ops stays a separate clone** in `career-ops/` (gitignored). Your CV, profile, tracker and
  generated PDFs live there and are never committed here. This repo holds code and config only.
- **Posting text is untrusted.** It is only matched by code or shown to Claude as fenced, quoted data.
- **Code decides; the model picks.** Knock-out rules are code the Claude session cannot overrule. The
  session may only choose a verdict and bullet IDs from a vetted pool; it never writes resume wording.
- **One write path for the tracker.** Rows are added only through career-ops' `merge-tracker.mjs` and
  statuses changed only through `set-status.mjs`. The web page is a copy, not the record.
- **Nothing is sent and nothing is submitted** by the pipeline. Messages, invites and application
  submits are done by the person.

## The daily run

```
05:45  launchd → scripts/morning/dawn.sh            (plain code, no Claude)
         career-ops scan.mjs                         new postings → career-ops/data/scan-history.tsv
         scripts/morning/run.mjs prepare             fetch each posting, apply knock-out rules,
                                                     write the ledger and to-judge-<run>.json
         scripts/check-watchlist.mjs                 confirm each named company's search parsed today
06:00  Claude Code scheduled session                 follows scripts/morning/SESSION.md
         manifest.mjs before                         file manifest taken around the session
         (session) writes verdicts-<run>.json        its only file: fit/no_fit + bullet IDs
         manifest.mjs after
         run.mjs apply-verdicts / finish             validate verdicts, build + gate resumes,
                                                     add tracker rows through career-ops
         scripts/page/drain.mjs                      apply status changes / reviews queued on the page
         scripts/page/build.mjs                      render page.html + page-snapshot.json
         publish the private tracker page
07:00  launchd → scripts/morning/audit.sh            the outside audit (scripts/audit.mjs all)
```

## Pieces

| Path | What it does |
|---|---|
| `config/portals.fde.yml` | Scan list (FDE, AI/ML and data roles), title and location filters, named "watchlist" companies. `scripts/build_portals.py` merges it into career-ops' `portals.yml`. |
| `integrations/firecrawl/` | career-ops plugin: Firecrawl search and careers-page scraping mapped to career-ops jobs. Dry-run mode spends no credits. |
| `integrations/extra-boards/` | career-ops plugin for three public boards it has no provider for (Dover, Jibe, Eightfold PCSX). |
| `scripts/morning/knockout.mjs` | The knock-out rules: seniority, years of experience, graduation window, visa sponsorship, citizenship, clearance, required MS/PhD. Keeps the sentence that triggered each. |
| `scripts/morning/ledger.mjs` | Append-only run ledger keyed by the scanner's fingerprint, one lock per run, so a killed run resumes and a re-posted job stays one record. |
| `scripts/morning/verdicts.mjs` | Schema for the session's verdict file. Unknown bullet IDs, extra fields or a knocked-out role reject the whole file. |
| `scripts/morning/manifest.mjs` | Snapshot of the file tree before and after the session; the audit uses it to prove the session wrote only its verdict file. |
| `outreach/resume/` | `build_resume.py` builds one-page resumes from a private bullet pool and per-role spec files; `build-all.sh` renders and gates each (one page, layout lint, career-ops fact and ATS checks). |
| `scripts/page/` | The private tracker page: a morning inbox (new roles, good fits with their chosen bullets, Approve / Needs change, every application's status). Taps are queued in the page's database and drained into the tracker by the next session. |
| `scripts/audit.mjs` | The 07:00 outside audit. It trusts nothing the run wrote: re-fetches every good fit against its own knock-out phrase list, checks each resume is one page and on-pool, each role is still open, statuses match the tracker, approvals match current resume contents, and the session touched only its own file. |
| `scripts/apply/packet.mjs` + `.claude/skills/apply/` | Apply help: a packet of answers for one tracker row (refused unless the resume is approved and the posting re-checks clean), and a Claude skill that fills the form in your browser and stops before Submit. |
| `outreach/queue.mjs`, `outreach/outreach.mjs` | Optional warm-intro list: crosses a LinkedIn connections export and named seed people with target companies, at most 20 people a day, notes checked for length and personalisation. Nothing is sent. |
| `scripts/check-*.mjs` | One-command checks: Firecrawl plugin loaded, watchlist parsed today, schedule installed, injection trap held. |

## Proofs

Each guarantee has a command. Most run with no private data:

- `node --test scripts/test/knockout-traps.test.mjs` — planted postings ("will not provide immigration
  sponsorship", "no C2C / no OPT", a 2027 graduation window, a clearance, a required PhD) end as SKIP
  through the morning entry point.
- `node --test scripts/test/verdict-schema.test.mjs` — malformed or off-pool verdict files are rejected whole.
- `node --test scripts/test/ledger.test.mjs` — killed runs resume, concurrent runs exit, re-posts dedupe.
- `node --test scripts/test/page-*.test.mjs scripts/test/review-queue.test.mjs` — queued taps survive a
  republish, Undo works, stale approvals are refused, page banners for stale, failed, empty and huge runs.
- `node scripts/check-injection-trap.mjs --offline` — a posting that tells an assistant to mark it a
  perfect fit and email the resume is knocked out or quarantined by code; the live half needs a real session.
- `node --test outreach/test/resume-gates.test.mjs` — needs your private bullet pool in `outreach/state/`;
  skips without it.

## Out of scope

Auto-submitting applications, solving CAPTCHAs, stealth browsers, unattended LinkedIn sending or
scraping, paid services, and writing new resume wording unattended.
