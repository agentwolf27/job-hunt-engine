import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewModel, renderHTML, ageBanner, LIST_CAP } from '../page/core.mjs';
import { pageHTML } from '../page/build.mjs';

const NOW = new Date(2026, 9, 13, 7, 30).getTime();
const at = (daysAgo, h = 6, m = 4) => new Date(2026, 9, 13 - daysAgo, h, m).toISOString();

const resume = (key) => ({
  key,
  pdf_name: `Resume_${key}.pdf`,
  pdf_url: '',
  spec_hash: `hash-${key}`,
  sections: [{ heading: 'Experience', entries: [{ title: 'Acme Corp | Software Engineer Intern', dates: '2026', bullets: [{ id: 'acme.llm', text: 'Engineered a 6-stage LLM pipeline.' }] }] }],
  review: null,
});

function snap(over = {}) {
  return {
    version: 1,
    built_at: at(0),
    run: { id: '2026-10-13T0600', status: 'ok', error: '', counts: { found: 3, fits: 1 } },
    watchlist: [{ company: 'Qualcomm', ok: true, total: 40, matched: 2, checked_at: at(0) }],
    rows: [
      { row: 1, date: '2026-10-13', company: 'Qualcomm', role: 'ML Engineer, College Graduate', score: 'N/A', status: 'Evaluated', url: 'https://careers.qualcomm.com/x', notes: '', resume: resume('qualcomm'), fit: { reason: 'New-grad ML role', new: true } },
      { row: 2, date: '2026-10-01', company: 'Stripe', role: 'Software Engineer, Early Career', score: '4.3/5', status: 'Evaluated', url: '', notes: 'n', resume: null, fit: null },
      { row: 3, date: '2026-10-13', company: 'WHOOP', role: 'Software Engineer I (Backend)', score: 'N/A', status: 'Applied', url: '', notes: '', resume: null, fit: null },
      { row: 4, date: '2026-10-01', company: 'Palantir', role: 'FDI Engineer', score: '1.5/5', status: 'SKIP', url: '', notes: '', resume: null, fit: null },
    ],
    skipped: [{ company: 'Fidelity', title: 'Leap Software Engineer', url: '', rule: 'no sponsorship', sentence: 'Fidelity will not provide immigration sponsorship for this position.' }],
    passed: [],
    unfetched: [],
    ...over,
  };
}

const html = (s, q = {}, now = NOW) => renderHTML(viewModel(s, q, now), {}, true);
const openDetails = (h) => (h.match(/<details[^>]*\sopen>/g) || []).map((d) => /data-key="([^"]+)"/.exec(d)[1]);

test('a three-day-old run leads with its age', () => {
  const h = html(snap({ built_at: at(3) }));
  assert.match(h, /class="banner stale"/);
  assert.match(h, /Last built 3 days ago \(Oct 10, 6:04 AM\)/);
  assert.ok(h.indexOf('banner stale') < h.indexOf('For you this morning'), 'the banner comes first');
  assert.equal(ageBanner(snap({ built_at: at(1) }), NOW).text.startsWith('Last built yesterday'), true);
});

test('a page built today says so, and never claims to be stale', () => {
  const h = html(snap());
  assert.match(h, /class="banner ok"/);
  assert.match(h, /Built today at 6:04 AM\./);
  assert.doesNotMatch(h, /Last built/);
});

test('a failed run says it failed and why', () => {
  const h = html(snap({ run: { id: 'r', status: 'failed', error: 'scan exited 1', counts: {} } }));
  assert.match(h, /class="banner failed"/);
  assert.match(h, /This morning&#39;s run failed: scan exited 1\./);
});

test('a company whose search failed is listed before anything else', () => {
  const h = html(snap({ watchlist: [{ company: 'Siemens', ok: false, error: 'HTTP 403' }, { company: 'Qualcomm', ok: true, total: 1, matched: 0 }] }));
  assert.match(h, /Not checked today/);
  assert.match(h, /Siemens<\/span><span class="li-sub">search failed: HTTP 403/);
  assert.ok(h.indexOf('Not checked today') < h.indexOf('For you this morning'));
});

test('zero new roles shows a plain empty state, not a blank section', () => {
  const s = snap({ skipped: [], run: { id: 'r', status: 'ok', error: '', counts: { found: 0, fits: 0 } } });
  s.rows = s.rows.filter((r) => r.row !== 1);
  const h = html(s);
  assert.match(h, /No new good fits this morning/);
  assert.match(h, /0 new postings found, 0 ruled out, 0 read and passed over, 0 good fits\./);
  assert.doesNotMatch(h, /Ruled out today/);
});

test('400 new roles: only good fits are expanded, the rest collapse to counts', () => {
  const skipped = Array.from({ length: 330 }, (_, i) => ({ company: `Co${i}`, title: `Senior Engineer ${i}`, url: '', rule: 'seniority', sentence: `Senior Engineer ${i}` }));
  const passed = Array.from({ length: 68 }, (_, i) => ({ company: `P${i}`, title: `Engineer ${i}`, url: '', reason: 'wrong stack' }));
  const s = snap({ skipped, passed, run: { id: 'r', status: 'ok', error: '', counts: { found: 400, fits: 2 } } });
  s.rows.push({ row: 5, date: '2026-10-13', company: 'Motorq', role: 'Forward Deployed Engineer', score: 'N/A', status: 'Evaluated', url: '', notes: '', resume: resume('motorq'), fit: { reason: 'FDE', new: true } });
  const h = html(s);
  assert.deepEqual(openDetails(h).sort(), ['active', 'resume-1', 'resume-5']);
  assert.match(h, /<h2>Ruled out today<\/h2><span class="count">330<\/span>/);
  assert.match(h, /<h2>Read and passed over<\/h2><span class="count">68<\/span>/);
  assert.match(h, new RegExp(`${330 - LIST_CAP} more postings not shown`));
  assert.equal((h.match(/Senior Engineer \d+<\/span>/g) || []).length, LIST_CAP);
  assert.ok(h.length < 400_000, `page body stays small (${h.length} chars)`);
});

test('a ruled-out role shows the sentence that ruled it out', () => {
  assert.match(html(snap()), /<b>no sponsorship<\/b> “Fidelity will not provide immigration sponsorship for this position\.”/);
});

test('a refused status change stays on its card with the reason', () => {
  const q = { 'status-row-3': { kind: 'status', row: 3, from: 'Applied', to: 'Interview', state: 'refused', reason: 'tracker already says Rejected' } };
  const h = html(snap(), q);
  assert.match(h, /Not changed to Interview: tracker already says Rejected\./);
  const card = /<article class="card" id="row-3">.*?<\/article>/s.exec(h)[0];
  assert.match(card, /class="pill s-applied">Applied</, 'the card keeps the tracker status, it does not silently revert or advance');
});

test('posting text cannot inject markup or links', () => {
  const s = snap();
  s.rows[0].role = '<img src=x onerror=alert(1)>';
  s.rows[0].url = 'javascript:alert(1)';
  s.skipped[0].sentence = '</script><script>alert(1)</script>';
  const h = html(s);
  assert.doesNotMatch(h, /<img|<script|javascript:/);
  const page = pageHTML(s);
  assert.equal((page.match(/<\/script>/g) || []).length, 2, 'the embedded snapshot cannot close its script tag');
});

test('with no way to save, the buttons are disabled and the page says why', () => {
  const h = renderHTML(viewModel(snap(), {}, NOW), {}, false);
  assert.match(h, /Buttons are off in this view/);
  assert.doesNotMatch(h, /<button(?![^>]*disabled)[^>]*data-act="(status|approve)"/);
});

test('a failed audit is shown on the page, a passed one in one quiet line', () => {
  const bad = html(snap({ audit: { date: '2026-10-12', ok: false, problems: ['knockouts: row 1 Qualcomm: could not be fetched again'], more: 0 } }));
  assert.match(bad, /The 2026-10-12 audit found problems/);
  assert.match(bad, /knockouts: row 1 Qualcomm/);
  assert.match(html(snap({ audit: { date: '2026-10-12', ok: true, problems: [], more: 0 } })), /The 2026-10-12 audit passed\./);
});
