#!/usr/bin/env node
// The outside audit (07:00, launchd). It trusts nothing the morning run said
// about itself: it reads the saved snapshot of what was published, re-fetches
// postings, and compares against the tracker, the pool and the PDFs on disk.
//
//   node scripts/audit.mjs stamp|knockouts|resumes|live|statuses|reviews|writers|all
//
// Its knock-out phrase list (AUDIT_PHRASES) is deliberately its own, written
// separately from scripts/morning/knockout.mjs, so the two do not share a blind spot.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchPosting } from './morning/fetch-posting.mjs';
import { loadState, readRuns } from './morning/ledger.mjs';
import { readTracker } from './page/tracker.mjs';
import { dumpSpec } from './page/resume.mjs';
import { readReviews } from './page/drain.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const AUDIT_PHRASES = [
  ['sponsorship', /\b(?:not|no|unable to|cannot|can ?not|won'?t|will not|does not|doesn'?t)\b[^.\n]{0,60}\bsponsor/i],
  ['sponsorship', /\bwithout\b[^.\n]{0,40}\bsponsorship\b/i],
  ['sponsorship', /\bno\s+(?:opt|cpt|h-?1b)\b/i],
  ['citizenship', /\b(?:u\.?s\.?|united states)\s+(?:citizen(?:ship)?|person)\b[^.\n]{0,40}\b(?:required|only|must|is a requirement)/i],
  ['citizenship', /\bmust be (?:a |an )?(?:u\.?s\.?|united states) (?:citizen|person)/i],
  ['clearance', /\b(?:active|current|obtain|maintain|eligib\w+ for)\b[^.\n]{0,40}\b(?:security )?clearance\b/i],
  ['clearance', /\b(?:ts\/sci|top secret|secret clearance|polygraph)\b/i],
  ['experience', /\b(?:[3-9]|1\d)\s*\+?\s*(?:or more\s+)?years?\b[^.\n]{0,40}\bexperience\b/i],
  ['experience', /\bminimum of (?:[3-9]|1\d|three|four|five|six|seven|eight) years\b/i],
  ['grad_window', /\b(?:class of|graduat\w+ (?:in|by|between|date)[^.\n]{0,40})\b(?:december 2026|2027|2028)\b/i],
  ['degree', /\b(?:ph\.?d|doctorate|master'?s(?: degree)?)\b[^.\n]{0,30}\b(?:is )?required\b/i],
];

export function auditKnockout(text) {
  for (const [rule, re] of AUDIT_PHRASES) {
    const m = re.exec(text);
    if (m) {
      const start = Math.max(text.lastIndexOf('\n', m.index), text.lastIndexOf('. ', m.index)) + 1;
      return { rule, sentence: text.slice(start, m.index + m[0].length + 80).trim().slice(0, 240) };
    }
  }
  return null;
}

const CLOSED_RE = /\b(?:no longer (?:accepting|available|open)|position (?:has been|is) (?:filled|closed)|job (?:not found|has expired|is closed|posting has expired)|this job is no longer)\b/i;

function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function context({ root = ROOT, now = new Date(), fetchImpl = fetchPosting } = {}) {
  const dir = join(root, 'outreach', 'state', 'morning');
  const snapPath = join(dir, 'page-snapshot.json');
  return {
    root,
    dir,
    now,
    today: localDay(now),
    fetchImpl,
    snapshot: existsSync(snapPath) ? JSON.parse(readFileSync(snapPath, 'utf8')) : null,
  };
}

const fits = (snapshot) => (snapshot.rows || []).filter((r) => r.fit);

export const CHECKS = {
  // Today's date, today's run, and nobody left unjudged: a run that never
  // reached the session must not read as "no good fits".
  stamp(c) {
    const out = [];
    if (!c.snapshot) return ['no page-snapshot.json: the page was never built'];
    if (localDay(new Date(c.snapshot.built_at)) !== c.today) out.push(`the snapshot was built ${String(c.snapshot.built_at).slice(0, 10)}, not today (${c.today})`);
    const last = readRuns(c.dir).filter((r) => r.date === c.today).pop();
    if (!last) out.push(`no morning run finished today (${c.today})`);
    else if (c.snapshot.run?.id !== last.run_id) out.push(`the snapshot carries run "${c.snapshot.run?.id || 'none'}", today's run is "${last.run_id}"`);
    const unjudged = [...loadState(c.dir).records.values()].filter((r) => r.stage === 'survived');
    if (unjudged.length) out.push(`${unjudged.length} posting(s) passed the knock-out rules and have no verdict, e.g. ${unjudged[0].company}: ${unjudged[0].title}`);
    return out;
  },

  async knockouts(c) {
    const out = [];
    if (!c.snapshot) return ['no page-snapshot.json'];
    for (const r of fits(c.snapshot)) {
      const name = `row ${r.row} ${r.company}: ${r.role}`;
      if (!r.url) {
        out.push(`${name}: no posting URL, so it cannot be re-checked`);
        continue;
      }
      try {
        const { text } = await c.fetchImpl(r.url, '');
        const hit = auditKnockout(`${r.role}\n${text}`);
        if (hit) out.push(`${name}: shown as a good fit, but the posting says (${hit.rule}) "${hit.sentence}"`);
      } catch (e) {
        out.push(`${name}: could not be fetched again (${e.message}), so it is not proven clean`);
      }
    }
    return out;
  },

  resumes(c) {
    const out = [];
    if (!c.snapshot) return ['no page-snapshot.json'];
    let pool;
    try {
      pool = JSON.parse(execFileSync('python3', ['outreach/resume/build_resume.py', '--list-bullets'], { cwd: c.root, encoding: 'utf8' })).bullets;
    } catch (e) {
      return [`the bullet pool could not be read: ${e.message.split('\n')[0]}`];
    }
    for (const r of (c.snapshot.rows || []).filter((x) => x.resume && x.resume.sections)) {
      const name = `row ${r.row} ${r.company} (${r.resume.key})`;
      const pdf = join(c.root, 'career-ops', 'output', r.resume.pdf_name);
      if (!existsSync(pdf)) {
        out.push(`${name}: ${r.resume.pdf_name} is not on disk`);
        continue;
      }
      const pages = /Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }));
      if (!pages || pages[1] !== '1') out.push(`${name}: the PDF has ${pages ? pages[1] : 'an unknown number of'} pages, not 1`);
      for (const s of r.resume.sections) {
        if (s.heading === 'Education' || s.heading === 'Technical Skills') continue;
        for (const e of s.entries) for (const b of e.bullets || []) if (pool[b.id] !== b.text) out.push(`${name}: bullet "${b.id}" is not in the vetted pool with this wording`);
      }
    }
    return out;
  },

  async live(c) {
    const out = [];
    if (!c.snapshot) return ['no page-snapshot.json'];
    for (const r of fits(c.snapshot).filter((x) => x.status === 'Evaluated')) {
      const name = `row ${r.row} ${r.company}: ${r.role}`;
      try {
        const { text } = await c.fetchImpl(r.url, '');
        if (CLOSED_RE.test(text)) out.push(`${name}: the posting now reads as closed`);
      } catch (e) {
        out.push(`${name}: the posting could not be opened (${e.message})`);
      }
    }
    return out;
  },

  statuses(c) {
    const out = [];
    if (!c.snapshot) return ['no page-snapshot.json'];
    const tracker = new Map(readTracker(join(c.root, 'career-ops', 'data', 'applications.md')).map((r) => [r.row, r.status]));
    // A change drained after the snapshot was built is the one allowed difference.
    const resultsPath = join(c.dir, 'queue-results.json');
    const drained = new Set();
    if (existsSync(resultsPath)) {
      const res = JSON.parse(readFileSync(resultsPath, 'utf8'));
      if (Date.parse(res.drained_at) > Date.parse(c.snapshot.built_at)) for (const x of res.results) if (x.outcome === 'applied') drained.add(x.id);
    }
    for (const r of c.snapshot.rows || []) {
      if (!tracker.has(r.row)) out.push(`row ${r.row} ${r.company}: on the page but not in the tracker`);
      else if (tracker.get(r.row) !== r.status && !drained.has(`status-row-${r.row}`)) out.push(`row ${r.row} ${r.company}: the page says ${r.status}, the tracker says ${tracker.get(r.row)}`);
    }
    if (tracker.size !== (c.snapshot.rows || []).length) out.push(`the tracker has ${tracker.size} rows, the page ${(c.snapshot.rows || []).length}`);
    return out;
  },

  reviews(c) {
    const out = [];
    if (!c.snapshot) return ['no page-snapshot.json'];
    const saved = readReviews(join(c.dir, 'reviews.jsonl'));
    for (const r of (c.snapshot.rows || []).filter((x) => x.resume?.review?.decision === 'approve')) {
      const name = `row ${r.row} ${r.company} (${r.resume.key})`;
      const now = dumpSpec(r.resume.key)?.spec_hash;
      if (!now) out.push(`${name}: shown as approved, but the resume spec cannot be read`);
      else if (r.resume.review.spec_hash !== now) out.push(`${name}: shown as approved, but the resume has changed since that Approve`);
      else if (!saved.some((s) => s.key === r.resume.key && s.spec_hash === now && s.decision === 'approve')) out.push(`${name}: shown as approved, but reviews.jsonl has no Approve for its current contents`);
    }
    return out;
  },

  writers(c) {
    const out = [];
    const last = readRuns(c.dir).filter((r) => r.date === c.today).pop();
    if (!last) return [`no morning run finished today (${c.today})`];
    const path = join(c.dir, `writers-${last.run_id}.json`);
    if (!existsSync(path)) return [`no file manifest was taken around the session for run ${last.run_id}`];
    const { changed } = JSON.parse(readFileSync(path, 'utf8'));
    const allowed = `outreach/state/morning/verdicts-${last.run_id}.json`;
    if (!changed.some((x) => x.file === allowed)) out.push(`the session did not write ${allowed}`);
    for (const x of changed) if (x.file !== allowed) out.push(`the session ${x.change} ${x.file}`);
    return out;
  },
};

export async function runChecks(names, c) {
  const results = {};
  for (const n of names) {
    try {
      results[n] = await CHECKS[n](c);
    } catch (e) {
      results[n] = [`the check itself broke: ${e.message}`];
    }
  }
  return results;
}

async function main() {
  const arg = process.argv[2];
  const names = arg === 'all' ? Object.keys(CHECKS) : [arg];
  if (!arg || names.some((n) => !CHECKS[n])) {
    console.error(`usage: node scripts/audit.mjs ${Object.keys(CHECKS).join('|')}|all`);
    process.exit(1);
  }
  const c = context();
  const results = await runChecks(names, c);
  let bad = 0;
  for (const [n, problems] of Object.entries(results)) {
    if (!problems.length) console.log(`ok    ${n}`);
    for (const p of problems) {
      bad += 1;
      console.log(`FAIL  ${n}: ${p}`);
    }
  }
  if (arg === 'all') writeFileSync(join(c.dir, `audit-${c.today}.json`), JSON.stringify({ date: c.today, at: new Date().toISOString(), ok: bad === 0, results }, null, 2));
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
