import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditKnockout, CHECKS } from '../audit.mjs';
import { walk, diff, run as manifest } from '../morning/manifest.mjs';

const fit = (over = {}) => ({ row: 1, company: 'Acme', role: 'Software Engineer I', status: 'Evaluated', url: 'https://example.com/job/1', fit: { reason: 'r', new: true }, ...over });
const ctx = (rows, fetchImpl) => ({ snapshot: { built_at: new Date().toISOString(), rows }, fetchImpl });
const clean = 'We are hiring a Software Engineer I. You will build services in Python and React. New graduates are welcome and sponsorship is available.';

test("the audit's own phrase list catches the knock-outs and passes clean wording", () => {
  for (const [rule, text] of [
    ['sponsorship', 'Acme will not provide immigration sponsorship for this position.'],
    ['sponsorship', 'Must be authorized to work without sponsorship now or in the future.'],
    ['sponsorship', 'Contract role: no C2C, no OPT.'],
    ['citizenship', 'Must be a U.S. citizen.'],
    ['clearance', 'Must be able to obtain a Secret clearance.'],
    ['experience', '3+ years of non-internship software experience.'],
    ['grad_window', 'Graduating between December 2026 and June 2027.'],
    ['degree', 'A PhD in machine learning is required.'],
  ]) assert.equal(auditKnockout(text)?.rule, rule, text);
  assert.equal(auditKnockout(clean), null);
  assert.equal(auditKnockout('0-2 years of experience. PhD preferred. No clearance needed for this role.'), null);
});

test('a good fit whose re-fetched posting has a knock-out fails the audit', async () => {
  const out = await CHECKS.knockouts(ctx([fit()], async () => ({ text: clean + ' Acme will not sponsor visas.' })));
  assert.equal(out.length, 1);
  assert.match(out[0], /shown as a good fit, but the posting says \(sponsorship\)/);
});

test('a good fit that cannot be fetched again fails, it is not waved through', async () => {
  const out = await CHECKS.knockouts(ctx([fit()], async () => { throw new Error('HTTP 403'); }));
  assert.match(out[0], /could not be fetched again \(HTTP 403\)/);
  assert.match((await CHECKS.knockouts(ctx([fit({ url: '' })], async () => ({ text: clean }))))[0], /no posting URL/);
});

test('a clean, open posting passes; a closed one fails the live check', async () => {
  assert.deepEqual(await CHECKS.knockouts(ctx([fit()], async () => ({ text: clean }))), []);
  assert.deepEqual(await CHECKS.live(ctx([fit()], async () => ({ text: clean }))), []);
  assert.match((await CHECKS.live(ctx([fit()], async () => ({ text: 'This job is no longer accepting applications.' }))))[0], /reads as closed/);
});

test('the file manifest names every file the session touched', () => {
  const root = mkdtempSync(join(tmpdir(), 'manifest-'));
  const dir = join(root, 'outreach', 'state', 'morning');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'career-ops', 'data'), { recursive: true });
  writeFileSync(join(root, 'career-ops', 'data', 'shortlist.md'), 'a');
  writeFileSync(join(root, 'notes.md'), 'a');
  assert.equal(manifest(['before', '--run-id', 'r1'], { root }), 0);
  writeFileSync(join(dir, 'verdicts-r1.json'), '{}');
  writeFileSync(join(root, 'career-ops', 'data', 'shortlist.md'), 'b');
  rmSync(join(root, 'notes.md'));
  const before = walk(root);
  assert.equal(manifest(['after', '--run-id', 'r1'], { root }), 0);
  assert.deepEqual(diff({ a: '1', b: '1' }, { a: '2', c: '1' }).map((x) => `${x.change} ${x.file}`), ['changed a', 'removed b', 'added c']);
  assert.ok(before['career-ops/data/shortlist.md']);
});
