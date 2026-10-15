#!/usr/bin/env node
// Drains the page's queue into the local record.
//
// A Claude session exports the page database's `queue` collection to a JSON
// file (node cannot read a private Artifact). This script does every write:
// status changes go through career-ops' set-status.mjs, reviews are appended to
// reviews.jsonl. It writes a results file saying what to do with each queue
// document, which the session then mirrors back into the page database.
//
//   node scripts/page/drain.mjs <queue-export.json> [--dry-run]
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIFECYCLE, CLOSED, PAGE_STATUSES } from './core.mjs';
import { readTracker } from './tracker.mjs';
import { dumpSpec } from './resume.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MORNING = join(ROOT, 'outreach', 'state', 'morning');

function rank(status) {
  return LIFECYCLE.indexOf(status);
}

// Decides one status change against what the tracker says now.
export function judgeStatus(doc, current) {
  if (!PAGE_STATUSES.includes(doc.to)) return { outcome: 'refused', reason: `"${doc.to}" is not a status the page may set` };
  if (current === undefined) return { outcome: 'refused', reason: `tracker has no row ${doc.row}` };
  if (current === doc.to) return { outcome: 'applied', reason: 'tracker already says so', noop: true };
  if (current !== doc.from) return { outcome: 'refused', reason: `tracker already says ${current}` };
  if (CLOSED.includes(current) || current === 'Offer' || current === 'Hired') return { outcome: 'refused', reason: `tracker already says ${current}` };
  if (rank(doc.to) >= 0 && rank(doc.to) < rank(current)) return { outcome: 'refused', reason: `that would move it back from ${current}` };
  return { outcome: 'apply' };
}

// deps: { statusOf(row) -> string|undefined, setStatus(row, to, at) -> {ok, error?},
//         specHash(key) -> string|null, seenReviews: Set<string>, appendReview(obj) }
export function drain(docs, deps) {
  const results = [];
  for (const d of docs) {
    const id = d.id;
    if (d.state === 'refused') {
      results.push({ id, outcome: 'kept', reason: d.reason || '' });
      continue;
    }
    if (d.kind === 'status') {
      const verdict = judgeStatus(d, deps.statusOf(d.row));
      if (verdict.outcome === 'apply') {
        const res = deps.setStatus(d.row, d.to, d.at);
        results.push(res.ok ? { id, outcome: 'applied', reason: `${d.from} → ${d.to}` } : { id, outcome: 'refused', reason: res.error || 'set-status failed' });
      } else results.push({ id, outcome: verdict.outcome, reason: verdict.reason });
    } else if (d.kind === 'review') {
      const now = deps.specHash(d.key);
      if (!['approve', 'needs_change'].includes(d.decision)) results.push({ id, outcome: 'refused', reason: 'unknown review decision' });
      else if (!now) results.push({ id, outcome: 'refused', reason: 'no such resume on the Mac' });
      else if (now !== d.spec_hash) results.push({ id, outcome: 'refused', reason: 'the resume changed after this review' });
      else {
        const mark = `${d.key}|${d.spec_hash}|${d.decision}|${d.at}`;
        if (!deps.seenReviews.has(mark)) {
          deps.appendReview({ id, key: d.key, spec_hash: d.spec_hash, decision: d.decision, note: d.note || '', at: d.at });
          deps.seenReviews.add(mark);
        }
        results.push({ id, outcome: 'applied', reason: d.decision });
      }
    } else results.push({ id, outcome: 'refused', reason: 'unknown kind of change' });
  }
  return results;
}

export function readReviews(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function main() {
  const resumeHash = (key) => dumpSpec(key)?.spec_hash || null;
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node scripts/page/drain.mjs <queue-export.json> [--dry-run]');
    process.exit(1);
  }
  // Accepts one JSON array, or the folder ArtifactData writes with out_dir
  // (one <id>.json per document, body under "data").
  const flat = (o, name) => ({ ...(o.data && typeof o.data === 'object' ? o.data : o), id: o.id || name, version: o.version });
  const docs = statSync(file).isDirectory()
    ? readdirSync(file).filter((f) => f.endsWith('.json')).map((f) => flat(JSON.parse(readFileSync(join(file, f), 'utf8')), f.slice(0, -5)))
    : JSON.parse(readFileSync(file, 'utf8')).map((o) => flat(o));
  const trackerPath = join(ROOT, 'career-ops', 'data', 'applications.md');
  const reviewsPath = join(MORNING, 'reviews.jsonl');
  mkdirSync(MORNING, { recursive: true });
  const seen = new Set(readReviews(reviewsPath).map((r) => `${r.key}|${r.spec_hash}|${r.decision}|${r.at}`));
  const results = drain(docs, {
    statusOf: (row) => readTracker(trackerPath).find((r) => r.row === Number(row))?.status,
    setStatus: (row, to, at) => {
      if (dry) return { ok: true };
      try {
        const on = /^\d{4}-\d{2}-\d{2}/.test(at || '') ? ['--on', at.slice(0, 10)] : [];
        execFileSync('node', ['set-status.mjs', '--row', String(row), to, ...on, '--json'], { cwd: join(ROOT, 'career-ops'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.stderr || e.stdout || e.message).trim().split('\n')[0].slice(0, 200) };
      }
    },
    specHash: (key) => resumeHash(key),
    seenReviews: seen,
    appendReview: (obj) => {
      if (!dry) appendFileSync(reviewsPath, JSON.stringify(obj) + '\n');
    },
  });
  const out = join(MORNING, 'queue-results.json');
  if (!dry) writeFileSync(out, JSON.stringify({ drained_at: new Date().toISOString(), results }, null, 2));
  for (const r of results) console.log(`${r.outcome.padEnd(8)} ${r.id}  ${r.reason}`);
  console.log(`${results.length} queued change(s) handled${dry ? ' (dry run, nothing written)' : `; results in ${out}`}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
