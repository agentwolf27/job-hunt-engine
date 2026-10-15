// Builds the page snapshot: exactly what gets published, saved so the audit can
// read it (node cannot read a private Artifact).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTracker } from './tracker.mjs';
import { loadState, readRuns } from '../morning/ledger.mjs';
import { readReviews } from './drain.mjs';
import { dumpSpec } from './resume.mjs';
export { dumpSpec };

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MORNING = join(ROOT, 'outreach', 'state', 'morning');
// File-name prefix of built resume PDFs. It must match "pdf_prefix" in outreach/state/resume/pool.json,
// which build_resume.py uses when it writes the PDF (for example "Jane_Doe_Resume_").
export const RESUME_PREFIX = process.env.JOBHUNT_RESUME_PREFIX ?? 'Resume_';

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function reportUrl(reportRel) {
  if (!reportRel) return '';
  const path = resolve(ROOT, 'career-ops', 'data', reportRel);
  if (!existsSync(path)) return '';
  const m = /^\*\*URL:\*\*\s*(https:\/\/\S+)/m.exec(readFileSync(path, 'utf8'));
  return m ? m[1] : '';
}

function latestWatchlist() {
  if (!existsSync(MORNING)) return [];
  const files = readdirSync(MORNING).filter((f) => /^watchlist-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) return [];
  const data = readJson(join(MORNING, files[files.length - 1]), []);
  return Array.isArray(data) ? data : data.companies || [];
}

function latestAudit() {
  if (!existsSync(MORNING)) return null;
  const files = readdirSync(MORNING).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) return null;
  const a = readJson(join(MORNING, files[files.length - 1]), null);
  if (!a) return null;
  const problems = Object.entries(a.results || {}).flatMap(([check, list]) => list.map((p) => `${check}: ${p}`));
  return { date: a.date, ok: !!a.ok, problems: problems.slice(0, 20), more: Math.max(0, problems.length - 20) };
}

export function buildSnapshot({ now = new Date() } = {}) {
  const tracker = readTracker(join(ROOT, 'career-ops', 'data', 'applications.md'));
  const resumeMap = readJson(join(MORNING, 'resume-map.json'), {});
  const assets = readJson(join(MORNING, 'assets.json'), {});
  const urls = readJson(join(MORNING, 'row-urls.json'), {});
  const reviews = new Map();
  for (const r of readReviews(join(MORNING, 'reviews.jsonl'))) reviews.set(r.key, r);

  const runs = readRuns(MORNING);
  const last = runs[runs.length - 1] || null;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const ledger = [...loadState(MORNING).records.values()];
  const inRun = last ? ledger.filter((r) => r.run_id === last.run_id || r.judged_run === last.run_id) : [];
  const byRow = new Map();
  for (const r of ledger) if (r.tracker && r.tracker.num) byRow.set(Number(r.tracker.num), r);
  // dawn.sh (05:45, launchd) leaves a note of how the scan and the knock-out
  // step went, so a morning that started and broke is shown as failed.
  const dawn = readJson(join(MORNING, `dawn-${today}.json`), null);
  let run = { id: '', status: 'none', error: '', counts: {} };
  if (last && last.date === today) run = { id: last.run_id, status: 'ok', error: '', finished_at: last.completed_at, counts: { ...last.counts, fits: last.counts?.fit || 0 } };
  else if (dawn) {
    const broke = dawn.scan_exit !== 0 ? `the scan exited ${dawn.scan_exit}` : dawn.prepare_exit !== 0 ? `the knock-out step exited ${dawn.prepare_exit}` : 'the 6 AM session has not judged the new postings';
    run = { id: dawn.run_id || '', status: 'failed', error: broke, counts: {} };
  }

  const rows = tracker.map((t) => {
    const led = byRow.get(t.row);
    const map = resumeMap[String(t.row)] || (led && led.spec_key ? { key: led.spec_key } : null);
    let resume = null;
    if (map) {
      const dump = map.key ? dumpSpec(map.key) : null;
      const pdfName = (dump && dump.pdf_name) || map.pdf_name || '';
      const file = pdfName ? `${RESUME_PREFIX}${pdfName}.pdf` : '';
      resume = {
        key: map.key || pdfName,
        pdf_name: file,
        pdf_url: (assets[file] && assets[file].url) || '',
        spec_hash: dump ? dump.spec_hash : '',
        sections: dump ? dump.sections : null,
        old_format: !map.key,
        review: null,
      };
      const rv = reviews.get(resume.key);
      if (rv) resume.review = { decision: rv.decision, note: rv.note || '', spec_hash: rv.spec_hash, at: rv.at };
    }
    return {
      row: t.row,
      date: t.date,
      company: t.company,
      role: t.role,
      score: t.score,
      status: t.status,
      url: (led && led.url) || urls[String(t.row)] || reportUrl(t.report),
      notes: t.notes,
      resume,
      fit: led && led.verdict === 'fit' ? { reason: led.reason || '', new: !!last && led.judged_run === last.run_id && last.date === today } : null,
    };
  });

  const pick = (r, extra) => ({ company: r.company || '', title: r.title || '', url: r.url || '', ...extra });
  const snapshot = {
    version: 1,
    built_at: now.toISOString(),
    run,
    watchlist: latestWatchlist(),
    audit: latestAudit(),
    rows,
    skipped: inRun.filter((r) => r.stage === 'knocked_out').map((r) => pick(r, { rule: r.rule || '', sentence: String(r.sentence || '').slice(0, 300) })),
    passed: inRun.filter((r) => r.stage === 'judged' && r.verdict === 'no_fit').map((r) => pick(r, { reason: r.reason || '' })),
    unfetched: inRun.filter((r) => r.stage === 'unfetched').map((r) => pick(r, { error: r.error || '' })),
  };
  return snapshot;
}
