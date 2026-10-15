import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { viewModel, renderHTML, makeReview, applyOp, reviewDocId } from '../page/core.mjs';
import { drain, readReviews } from '../page/drain.mjs';

const NOW = new Date(2026, 9, 13, 9, 0).getTime();
const ISO = new Date(NOW).toISOString();
const resume = (hash = 'h1', review = null) => ({
  key: 'fde-motorq',
  pdf_name: 'Resume_Motorq.pdf',
  pdf_url: '',
  spec_hash: hash,
  sections: [{ heading: 'Experience', entries: [{ title: 'Acme Corp', dates: '', bullets: [{ id: 'acme.llm', text: 'Engineered a 6-stage LLM pipeline.' }] }] }],
  review,
});
const snap = (r, built = ISO) => ({
  version: 1,
  built_at: built,
  run: { id: 'r1', status: 'ok', counts: {} },
  watchlist: [],
  rows: [{ row: 12, date: '2026-10-12', company: 'Motorq', role: 'Forward Deployed Engineer', score: 'N/A', status: 'Evaluated', url: '', notes: '', resume: r, fit: null }],
  skipped: [],
  passed: [],
  unfetched: [],
});
const queued = (r, decision, note) => {
  const rv = makeReview(r, decision, note, ISO);
  return applyOp({}, { type: 'set', id: rv.id, doc: rv.doc });
};
const html = (s, q) => renderHTML(viewModel(s, q, NOW), {}, true);
const docsOf = (q) => Object.entries(q).map(([id, d]) => ({ id, ...d }));

function fileDeps(hashNow) {
  const path = join(mkdtempSync(join(tmpdir(), 'reviews-')), 'reviews.jsonl');
  const seen = new Set(readReviews(path).map((r) => `${r.key}|${r.spec_hash}|${r.decision}|${r.at}`));
  return {
    path,
    statusOf: () => undefined,
    setStatus: () => ({ ok: false }),
    specHash: () => hashNow,
    seenReviews: seen,
    appendReview: (o) => appendFileSync(path, JSON.stringify(o) + '\n'),
  };
}

test('the bullets are on the card as text, with Approve and Needs change', () => {
  const h = html(snap(resume()), {});
  assert.match(h, /<li>Engineered a 6-stage LLM pipeline\.<\/li>/);
  assert.match(h, /data-act="approve" data-row="12"/);
  assert.match(h, /data-act="needs" data-row="12"/);
});

test('an Approve survives a republish and reaches reviews.jsonl', () => {
  const q = queued(resume(), 'approve', '');
  const later = snap(resume(), new Date(NOW + 3600_000).toISOString());
  assert.match(html(later, q), /Approved · waiting for Mac/);
  const d = fileDeps('h1');
  assert.deepEqual(drain(docsOf(q), d), [{ id: reviewDocId('fde-motorq'), outcome: 'applied', reason: 'approve' }]);
  const saved = readReviews(d.path);
  assert.equal(saved.length, 1);
  assert.deepEqual({ key: saved[0].key, spec_hash: saved[0].spec_hash, decision: saved[0].decision }, { key: 'fde-motorq', spec_hash: 'h1', decision: 'approve' });
  drain(docsOf(q), d);
  assert.equal(readReviews(d.path).length, 1, 'draining the same export twice appends once');
});

test('a Needs change carries its note through a republish to reviews.jsonl', () => {
  const q = queued(resume(), 'needs_change', 'Lead with the Jira pipeline');
  const h = html(snap(resume(), new Date(NOW + 3600_000).toISOString()), q);
  assert.match(h, /Change requested · waiting for Mac: “Lead with the Jira pipeline”/);
  const d = fileDeps('h1');
  drain(docsOf(q), d);
  assert.equal(readReviews(d.path)[0].note, 'Lead with the Jira pipeline');
  assert.equal(readReviews(d.path)[0].decision, 'needs_change');
});

test('an Approve for a resume that has since changed is refused and nothing is saved', () => {
  const q = queued(resume('h1'), 'approve', '');
  const d = fileDeps('h2');
  assert.deepEqual(drain(docsOf(q), d), [{ id: reviewDocId('fde-motorq'), outcome: 'refused', reason: 'the resume changed after this review' }]);
  assert.equal(readReviews(d.path).length, 0);
});

test('the page shows a stale review as not counting, and asks again', () => {
  const q = queued(resume('h1'), 'approve', '');
  const vm = viewModel(snap(resume('h2')), q, NOW);
  assert.equal(vm.todo[0].approved, false);
  assert.equal(vm.todo[0].needsReview, true);
  assert.match(renderHTML(vm, {}, true), /This resume changed after your review/);
});

test('a saved Approve for the current resume takes the card out of the review list; an old one does not', () => {
  const ok = viewModel(snap(resume('h1', { decision: 'approve', spec_hash: 'h1', note: '', at: ISO })), {}, NOW);
  assert.equal(ok.todo.length, 0);
  assert.match(renderHTML(ok, {}, true), /You approved this resume\./);
  const old = viewModel(snap(resume('h2', { decision: 'approve', spec_hash: 'h1', note: '', at: ISO })), {}, NOW);
  assert.equal(old.todo.length, 1);
});

test('Undo removes a queued review', () => {
  let q = queued(resume(), 'approve', '');
  q = applyOp(q, { type: 'delete', id: reviewDocId('fde-motorq') });
  assert.equal(viewModel(snap(resume()), q, NOW).todo[0].review.state, 'none');
});

test('a review with an unknown decision or for an unknown resume is refused', () => {
  const d = fileDeps(null);
  const out = drain([{ id: 'review-x', kind: 'review', key: 'x', spec_hash: 'h', decision: 'approve', state: 'queued', at: ISO }], d);
  assert.equal(out[0].reason, 'no such resume on the Mac');
  const d2 = fileDeps('h');
  assert.equal(drain([{ id: 'review-x', kind: 'review', key: 'x', spec_hash: 'h', decision: 'ship it', state: 'queued', at: ISO }], d2)[0].outcome, 'refused');
});

test('an approved resume on an unapplied role says how to start the application', () => {
  const approved = snap(resume('h1', { decision: 'approve', spec_hash: 'h1', note: '', at: ISO }));
  assert.match(html(approved, {}), /Ready to apply\. In Claude on the Mac, say: <b>apply to row 12<\/b>/);
  assert.doesNotMatch(html(snap(resume('h1')), {}), /Ready to apply/);
  approved.rows[0].status = 'Applied';
  assert.doesNotMatch(html(approved, {}), /Ready to apply/);
});
