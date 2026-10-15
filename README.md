# job-hunt-engine

A daily, zero-cost job-search pipeline built on top of
[career-ops](https://github.com/santifer/career-ops). It runs on a Mac with launchd and a Claude Code
subscription, aimed at early-career software, AI/ML, data and forward-deployed engineering roles.

Every morning, with nobody watching:

1. **Scan.** career-ops scans the Greenhouse, Ashby and Lever public APIs (plus two plugins here for
   Firecrawl and a few boards career-ops has no provider for) and records new postings.
2. **Knock-out rules, in code.** Each new posting is fetched again and checked against plain-code
   rules: senior titles, 3+ years required, a graduation window that excludes you, no visa
   sponsorship, US citizenship or clearance required, MS/PhD required. The sentence that triggered a
   rule is kept so you can check the call. Nothing the model says can overrule these.
3. **An unattended Claude session judges the survivors.** It reads postings only as quoted, untrusted
   data and writes exactly one file: a verdict per posting and, for a good fit, a list of resume
   bullet **IDs** chosen from a pool you have already vetted. It never writes resume wording. Code
   rejects the whole file if it names an unknown bullet, adds a field, or calls a knocked-out role a fit.
4. **Gated one-page resumes.** For each good fit, code builds a resume from those bullets and gates it:
   one page, layout lint, career-ops' fact and ATS checks. A failed gate fails the run.
5. **A private tracker page.** A Claude Artifact page, private to you, republished each morning: what is
   new, which roles are good fits, each resume's bullets as text with Approve / Needs change, and
   every application's status. Taps on a phone are queued and written into the career-ops tracker by
   the next session, through career-ops' own write path.
6. **An outside audit at 07:00.** A separate job that trusts nothing the run wrote: it re-fetches
   every good fit against its own knock-out list, checks every resume is one page and uses only
   pool bullets, checks every role is still open, that page statuses match the tracker, and that the
   Claude session changed no file but its verdict file.
7. **Apply help that stops before Submit.** `scripts/apply/packet.mjs <row>` builds the answers for one
   application (and refuses if the resume is unapproved or the posting now shows a knock-out); the
   `/apply` Claude skill fills the form in your own browser and stops on the last page. You click Submit.

Nothing in this repo sends a message, submits an application, signs in anywhere or solves a CAPTCHA.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit and the command that proves each guarantee.

## Layout

```
config/portals.fde.yml          scan list, title + location filters, named "watchlist" companies
integrations/firecrawl/         career-ops plugin: Firecrawl search and careers-page scraping
integrations/extra-boards/      career-ops plugin: Dover, Jibe and Eightfold PCSX boards
scripts/morning/                dawn.sh (05:45), run.mjs, knockout.mjs, ledger, verdict schema, SESSION.md (06:00)
scripts/page/                   the private tracker page: snapshot, render, queue drain, resume assets
scripts/audit.mjs               the 07:00 outside audit
scripts/apply/packet.mjs        apply packet for one tracker row
.claude/skills/apply/           the /apply skill (fills a form, stops before Submit)
outreach/resume/                resume builder and gates (reads your private pool and specs)
outreach/queue.mjs              optional warm-intro list (never sends)
scripts/launchd/                launchd templates, installed by scripts/install-schedule.sh
```

Private data never lives in this repo. It sits in two gitignored places: `career-ops/` (your CV,
profile, tracker, reports and PDFs, and its `.env`) and `outreach/state/` (bullet pool, resume specs,
run ledger, page state).

## Setup

Requirements: macOS (launchd), Node 22+, Python 3.11+ with [uv](https://docs.astral.sh/uv/),
`pdfinfo` (poppler), and Claude Code.

1. **Clone this repo, then career-ops inside it**, and set career-ops up by its own instructions
   (CV, `config/profile.yml`, tracker):
   ```bash
   git clone <this repo> job-hunt-engine && cd job-hunt-engine
   git clone https://github.com/santifer/career-ops career-ops
   npm --prefix career-ops install
   npm --prefix career-ops run doctor
   ```
2. **Link the plugins into career-ops** and, if you want Firecrawl, put `FIRECRAWL_API_KEY` in
   `career-ops/.env` (free tier):
   ```bash
   mkdir -p career-ops/plugins.local
   ln -s ../../integrations/firecrawl career-ops/plugins.local/firecrawl
   ln -s ../../integrations/extra-boards career-ops/plugins.local/extra-boards
   node scripts/check-firecrawl.mjs
   ```
3. **Edit the scan list** in `config/portals.fde.yml` (companies, title filter, `location_filter`), then
   merge it into career-ops: `uv run scripts/build_portals.py`, and check it with
   `uv run scripts/check_portals.py`.
4. **Write your bullet pool and resume specs** in `outreach/state/resume/pool.json` and
   `outreach/state/specs/<key>.json` (see the docstring at the top of `outreach/resume/build_resume.py`
   for the format). Bullet IDs are `<owner>.<name>`, for example `acme.llm`. Every bullet should be
   one you have checked is true; the morning session can only choose among them.
5. **Tune the knock-out rules** in `scripts/morning/knockout.mjs` to your situation (graduation month,
   which rules apply), and the fit criteria in `scripts/morning/SESSION.md`.
6. **Install the schedule**: `scripts/install-schedule.sh` fills in this repo's path and your PATH and
   installs the 05:45 scan and the 07:00 audit. Check it with `node scripts/check-schedule.mjs`.
7. **Schedule the 06:00 Claude Code session** with `scripts/morning/SESSION.md` as its prompt. On its
   first run it publishes the tracker page; the page URL is kept in `outreach/state/morning/page.json`.

### Configuration

| Variable | Default | Used by |
|---|---|---|
| `JOBHUNT_RESUME_PREFIX` | `Resume_` | `scripts/page/snapshot.mjs`. Must match `pdf_prefix` in your `pool.json` (e.g. `Jane_Doe_Resume_`). |
| `JOBHUNT_PREFERRED_LOCATIONS` | California places | `outreach/queue.mjs` ranking; comma-separated, e.g. `seattle,remote`. |
| `JOBHUNT_LAUNCHD_PATH` | your shell's `PATH` | `scripts/install-schedule.sh` |
| `RESUME_POOL`, `RESUME_SPECS_DIR`, `RESUME_OUT_DIR`, `CAREER_OPS_DIR` | under `outreach/state/` and `career-ops/` | resume builder and gates |
| `FIRECRAWL_API_KEY` | none | in `career-ops/.env`, read by career-ops for the Firecrawl plugin |

## Tests

```bash
for f in scripts/test/*.test.mjs outreach/test/*.test.mjs integrations/*/test/*.test.mjs; do node --test "$f"; done
node scripts/check-injection-trap.mjs --offline
```

The tests use fixtures and need neither career-ops nor any private data, except
`outreach/test/resume-gates.test.mjs`, which skips unless your bullet pool is in `outreach/state/`.

## Known limits

- `outreach/resume/build-all.sh` renders PDFs with `career-ops/output/render-own-format.mjs`, a renderer
  for a custom one-page layout that is not part of upstream career-ops and is not included here.
  Supply your own renderer at that path (HTML in, PDF out) or adapt the script to career-ops' own PDF mode.
- macOS only (launchd, `caffeinate`, `plutil`). The tracker page needs Claude Artifacts.
- Automating a personal LinkedIn account breaks LinkedIn's terms; the outreach list here only drafts.

## Credit

Built on [career-ops](https://github.com/santifer/career-ops) by santifer (MIT). career-ops is not
vendored here; you clone it yourself. `scripts/build_portals.py` merges this repo's scan list into
career-ops' own `templates/portals.example.yml` at build time.

## License

MIT, see [LICENSE](LICENSE).
