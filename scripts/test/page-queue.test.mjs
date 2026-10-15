import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewModel, renderHTML, makeStatusChange, applyOp, statusDocId } from '../page/core.mjs';
import { drain, judgeStatus } from '../page/drain.mjs';

const NOW = new Date(2026, 9, 13, 9, 0).getTime();
const ISO = new Date(NOW).toISOString();
const row = (over = {}) => ({ row: 7, date: '2026-10-01', company: 'Stripe', role: 'Software Engineer, Early Career', score: '4.3/5', status: 'Evaluated', url: '', notes: '', resume: null, fit: null, ...over });
const snap = (rows, built = ISO) => ({ version: 1, built_at: built, run: { id: 'r1', status: 'ok', counts: {} }, watchlist: [], rows, skipped: [], passed: [], unfetched: [] });
const card = (s, q) => viewModel(s, q, NOW).active.concat(viewModel(s, q, NOW).toApply, viewModel(s, q, NOW).todo, viewModel(s, q, NOW).closed).find((c) => c.row === 7);
const tap = (q, r, to) => {
  const ch = makeStatusChange(r, to, ISO);
  return applyOp(q, { type: 'set', id: ch.id, doc: ch.doc });
};

test('a tap changes the card at once to "waiting for Mac" with Undo', () => {
  const s = snap([row()]);
  const q = tap({}, s.rows[0], 'Applied');
  const c = card(s, q);
  assert.equal(c.status, 'Applied');
  assert.deepEqual(c.pending, { to: 'Applied', from: 'Evaluated' });
  const h = renderHTML(viewModel(s, q, NOW), {}, true);
  assert.match(h, /Applied · waiting for Mac/);
  assert.match(h, /data-act="undo-status" data-row="7"/);
  assert.match(h, /1 change waiting for the Mac/);
});

test('a queued change survives a republish that still carries the old status', () => {
  const q = tap({}, row(), 'Applied');
  const republished = snap([row()], new Date(NOW + 3600_000).toISOString());
  assert.equal(card(republished, q).status, 'Applied');
  assert.ok(card(republished, q).pending);
});

test('a double tap queues one change', () => {
  let q = tap({}, row(), 'Applied');
  q = tap(q, row(), 'Applied');
  assert.deepEqual(Object.keys(q), [statusDocId(7)]);
  assert.equal(q[statusDocId(7)].from, 'Evaluated');
});

test('a second, different tap replaces the first instead of stacking', () => {
  let q = tap({}, row(), 'Applied');
  q = tap(q, row(), 'Discarded');
  assert.equal(Object.keys(q).length, 1);
  assert.equal(q[statusDocId(7)].to, 'Discarded');
});

test('Undo removes the change and the card goes back', () => {
  let q = tap({}, row(), 'Applied');
  q = applyOp(q, { type: 'delete', id: statusDocId(7) });
  assert.deepEqual(q, {});
  const c = card(snap([row()]), q);
  assert.equal(c.status, 'Evaluated');
  assert.equal(c.pending, null);
});

test('once the tracker has the change, the card stops saying it is waiting', () => {
  const q = tap({}, row(), 'Applied');
  const c = card(snap([row({ status: 'Applied' })]), q);
  assert.equal(c.pending, null);
  assert.equal(c.status, 'Applied');
});

function deps(statuses) {
  const calls = [];
  return {
    calls,
    statusOf: (r) => statuses[r],
    setStatus: (r, to) => {
      calls.push([r, to]);
      statuses[r] = to;
      return { ok: true };
    },
    specHash: () => null,
    seenReviews: new Set(),
    appendReview: () => {},
  };
}

test('the drain writes a queued change through set-status, once', () => {
  const q = tap({}, row(), 'Applied');
  const docs = Object.entries(q).map(([id, d]) => ({ id, ...d }));
  const d = deps({ 7: 'Evaluated' });
  assert.deepEqual(drain(docs, d), [{ id: 'status-row-7', outcome: 'applied', reason: 'Evaluated → Applied' }]);
  assert.deepEqual(d.calls, [[7, 'Applied']]);
  const again = drain(docs, d);
  assert.equal(again[0].outcome, 'applied');
  assert.equal(d.calls.length, 1, 'a second drain of the same export does not write again');
});

test('the drain refuses a change the tracker has moved past, and never moves a status back', () => {
  assert.deepEqual(judgeStatus({ row: 7, from: 'Evaluated', to: 'Applied' }, 'Rejected'), { outcome: 'refused', reason: 'tracker already says Rejected' });
  assert.equal(judgeStatus({ row: 7, from: 'Interview', to: 'Applied' }, 'Interview').outcome, 'refused');
  assert.equal(judgeStatus({ row: 7, from: 'Offer', to: 'Applied' }, 'Offer').outcome, 'refused');
  assert.equal(judgeStatus({ row: 9, from: 'Evaluated', to: 'Applied' }, undefined).outcome, 'refused');
  assert.equal(judgeStatus({ row: 7, from: 'Evaluated', to: 'Hacked' }, 'Evaluated').outcome, 'refused');
  assert.equal(judgeStatus({ row: 7, from: 'Applied', to: 'Rejected' }, 'Applied').outcome, 'apply');
  const d = deps({ 7: 'Rejected' });
  const out = drain([{ id: 'status-row-7', kind: 'status', row: 7, from: 'Evaluated', to: 'Applied', state: 'queued' }], d);
  assert.equal(out[0].outcome, 'refused');
  assert.equal(d.calls.length, 0);
});

test('a set-status failure is reported as refused, with its reason', () => {
  const d = deps({ 7: 'Evaluated' });
  d.setStatus = () => ({ ok: false, error: 'tracker lock timeout' });
  const out = drain([{ id: 'status-row-7', kind: 'status', row: 7, from: 'Evaluated', to: 'Applied', state: 'queued' }], d);
  assert.deepEqual(out, [{ id: 'status-row-7', outcome: 'refused', reason: 'tracker lock timeout' }]);
});
