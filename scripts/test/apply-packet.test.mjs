import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, packetMarkdown } from '../apply/packet.mjs';
import { pdfNameFor } from '../morning/steps.mjs';

const row = (over = {}) => ({ row: 59, company: 'Amazon', role: 'Front-End Engineer - 2026 (US)', status: 'Evaluated', url: 'https://www.amazon.jobs/en/jobs/10428762', resume: { key: 'k', pdf_name: 'Resume_Amazon_Front_End_Engineer_2026.pdf', spec_hash: 'h' }, ...over });
const open = { text: 'Front-End Engineer. Build web interfaces in JavaScript and React. Bachelor’s degree in computer science. Internship experience preferred. New graduates welcome.' };
const ready = { row: row(), approved: true, pdfOnDisk: true, pages: 1, posting: open };

test('a ready role passes with no warnings', () => {
  assert.deepEqual(gate(ready), { ok: true, stop: [], warn: [] });
});

test('filling does not start without an Approve, unless the candidate waives it', () => {
  const g = gate({ ...ready, approved: false });
  assert.equal(g.ok, false);
  assert.match(g.stop[0], /no Approve for its current wording/);
  const waived = gate({ ...ready, approved: false, unreviewed: true });
  assert.equal(waived.ok, true);
  assert.match(waived.warn[0], /no Approve/);
});

test('each of these stops it: already applied, no resume, old-layout resume, two pages, missing file', () => {
  assert.match(gate({ ...ready, row: row({ status: 'Applied' }) }).stop[0], /already says Applied/);
  assert.match(gate({ ...ready, row: row({ resume: null }) }).stop[0], /no resume is attached/);
  assert.match(gate({ ...ready, row: row({ resume: { key: 'Stripe', pdf_name: 'x.pdf', spec_hash: '' } }) }).stop[0], /older layout/);
  assert.match(gate({ ...ready, pages: 2 }).stop[0], /2 pages, not 1/);
  assert.match(gate({ ...ready, pdfOnDisk: false }).stop[0], /not on disk/);
  assert.deepEqual(gate({ ...ready, row: null }).stop, ['no such row in the tracker']);
});

test('a posting that closed, grew a knock-out, or cannot be opened stops it', () => {
  assert.match(gate({ ...ready, posting: { text: 'This job is no longer accepting applications.' } }).stop[0], /reads as closed/);
  assert.match(gate({ ...ready, posting: { text: `${open.text} Amazon will not provide immigration sponsorship for this position.` } }).stop[0], /knock-out \(sponsorship\)/);
  assert.match(gate({ ...ready, posting: { error: 'HTTP 403' } }).stop[0], /could not be opened to re-check it \(HTTP 403\)/);
  assert.match(gate({ ...ready, posting: null }).warn[0], /not re-fetched/);
});

test('the packet answers sponsorship truthfully and leaves Submit to the candidate', () => {
  const profile = { name: 'N', email: 'e@x.com', phone: 'p', location: 'l', linkedin: 'https://li', github: 'https://gh', portfolio: 'https://p', school: 's', degree: 'd', graduated: 'May 2026', visa: 'Example visa status', needsSponsorship: true, relocation: 'anywhere', salary: null };
  const md = packetMarkdown({ row: row(), profile, pdfPath: '/x/r.pdf', verdict: { warn: [] }, date: '2026-10-13' });
  assert.match(md, /require sponsorship\? \| Yes \(Example visa status\)/);
  assert.match(md, /\*\*Submit\.\*\* Stop on the last page/);
  assert.match(md, /Signing in, creating an account, any password/);
  assert.match(md, /Salary expectation \| not set in the profile/);
  assert.match(md, /set-status\.mjs --row 59 Applied/);
});

test('resume file names are clean: company and role words, nothing machine-made', () => {
  assert.equal(pdfNameFor({ company: 'Amazon Development Center U.S., Inc. - B02', title: 'Front-End Engineer – 2026 (US)' }), 'Amazon_Front_End_Engineer_2026');
  assert.equal(pdfNameFor({ company: 'Twitch Interactive, Inc. - D48', title: 'Software Engineer I, Payments' }), 'Twitch_Software_Engineer_I_Payments');
  assert.equal(pdfNameFor({ company: 'Applied Materials', title: 'New College Grad Software Engineer I (Bachelors - Santa Clara, CA)' }), 'Applied_Materials_New_College_Grad_Software_Engineer_I');
  for (const r of [{ company: 'Zoë & Co.', title: 'Ingénieur·e ML / Données' }, { company: '', title: '' }, { company: 'A', title: 'x '.repeat(80) }]) {
    const n = pdfNameFor(r);
    assert.match(n, /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/);
    assert.ok(n.length <= 60);
  }
});
