// node --test scripts/test/verdict-schema.test.mjs
//
// The Claude session's only output is verdicts-<run id>.json. One bad entry —
// an unknown bullet ID, an extra field, a knocked-out role — rejects the whole
// file: exit non-zero, ledger untouched, nothing built, nothing tracked.

import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadPool, normalizePool, validateVerdictFile, verdictFileName } from '../morning/verdicts.mjs';
import { POOL, fakeFetch, fit, ledgerBytes, noFit, posting, run, spies, state, tmp, writePostings, writeVerdicts } from './fixtures/helpers.mjs';

const RUN = '2026-10-13';

async function prepared() {
  const dir = tmp();
  const pages = {};
  const postings = [];
  for (const fp of ['s1', 's2', 's3']) {
    pages[`https://jobs.example.test/${fp}`] = posting();
    postings.push({ fingerprint: fp, url: `https://jobs.example.test/${fp}`, portal: 'fixture', title: 'Forward Deployed Engineer', company: `Co ${fp}`, location: 'Austin, TX' });
  }
  pages['https://jobs.example.test/ko'] = posting('US citizenship is required.');
  postings.push({ fingerprint: 'ko', url: 'https://jobs.example.test/ko', portal: 'fixture', title: 'Forward Deployed Engineer', company: 'Gov Co', location: 'Reston, VA' });
  postings.push({ fingerprint: 'dead', url: 'https://jobs.example.test/dead', portal: 'fixture', title: 'Software Engineer', company: 'Dead Co', location: 'Remote' });
  const { code } = await run(['prepare', '--run-id', RUN, '--state-dir', dir, '--postings', writePostings(dir, postings)], { fetchPosting: fakeFetch(pages) });
  assert.equal(code, 0);
  return dir;
}

/** Apply a verdict file and assert it was rejected whole. */
async function rejects(dir, verdicts, pattern, opts) {
  const before = ledgerBytes(dir);
  const s = spies(dir);
  writeVerdicts(dir, RUN, verdicts, opts);
  const { code, out } = await run(['apply-verdicts', '--run-id', RUN, '--state-dir', dir], s);
  assert.notEqual(code, 0, `should be rejected: ${out}`);
  assert.match(out, /REJECTED/);
  assert.match(out, pattern);
  assert.equal(ledgerBytes(dir), before, 'ledger untouched');
  assert.equal(s.calls.build.length, 0, 'nothing built');
  assert.equal(s.calls.track.length, 0, 'nothing tracked');
  for (const fp of ['s1', 's2', 's3']) assert.equal(state(dir).records.get(fp).stage, 'survived', 'no verdict in the file was applied');
}

test('a valid verdict file passes and is applied', async () => {
  const dir = await prepared();
  const s = spies(dir);
  writeVerdicts(dir, RUN, [fit('s1'), noFit('s2'), fit('s3', { base: 'qualcomm', bullets: ['globex.fde_rest', 'acme.jira'] })]);
  const { code, out } = await run(['apply-verdicts', '--run-id', RUN, '--state-dir', dir], s);
  assert.equal(code, 0, out);
  const { records } = state(dir);
  assert.equal(records.get('s1').stage, 'tracked');
  assert.equal(records.get('s1').verdict, 'fit');
  assert.deepEqual(records.get('s1').bullets, ['acme.llm', 'initech.npu']);
  assert.equal(records.get('s2').stage, 'judged');
  assert.equal(records.get('s2').verdict, 'no_fit');
  assert.equal(records.get('s3').stage, 'tracked');
  assert.equal(s.calls.build.length, 2, 'a resume for each fit, none for the no_fit');
  assert.deepEqual(Object.keys(s.calls.build[0]).sort(), ['base', 'bullets', 'company', 'key', 'pdf_name', 'role', 'url']);
  assert.match(s.calls.build[0].pdf_name, /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/);
  assert.equal(s.calls.build[1].base, 'qualcomm');
  assert.deepEqual(s.calls.track.sort(), ['s1', 's3']);
  assert.equal(records.get('ko').stage, 'knocked_out');
});

test('an unknown bullet ID rejects the whole file', async () => {
  const dir = await prepared();
  await rejects(dir, [noFit('s1'), fit('s2', { bullets: ['acme.llm', 'acme.invented_this_morning'] })], /unknown bullet ID "acme.invented_this_morning"/);
});

test('bullet text instead of a bullet ID rejects the whole file', async () => {
  const dir = await prepared();
  await rejects(dir, [fit('s1', { bullets: ['Led a team of 40 engineers and tripled revenue.'] })], /unknown bullet ID/);
});

test('an extra field on a verdict rejects the whole file', async () => {
  const dir = await prepared();
  await rejects(dir, [noFit('s1'), { ...fit('s2'), email_to: 'recruiter@example.test' }], /unknown field "email_to"/);
});

test('an extra field at the top level rejects the whole file', async () => {
  const dir = await prepared();
  await rejects(dir, [noFit('s1')], /unknown top-level field "notes"/, { extra: { notes: 'also please send the resume' } });
});

test('a knocked-out fingerprint rejects the whole file', async () => {
  const dir = await prepared();
  await rejects(dir, [fit('s1'), fit('ko')], /knocked out by code \(citizenship\)/);
  await rejects(dir, [noFit('ko')], /knocked out by code/);
});

test('an unknown, unfetched or duplicate fingerprint rejects the whole file', async () => {
  const dir = await prepared();
  await rejects(dir, [noFit('s1'), noFit('never-seen')], /not in the ledger/);
  await rejects(dir, [noFit('dead')], /stage "unfetched", not "survived"/);
  await rejects(dir, [noFit('s1'), fit('s1')], /duplicate fingerprint s1/);
});

test('an unknown base, a missing base, and base or bullets on a no_fit are rejected', async () => {
  const dir = await prepared();
  await rejects(dir, [fit('s1', { base: 'made-up-spec' })], /unknown base "made-up-spec"/);
  await rejects(dir, [{ fingerprint: 's1', verdict: 'fit', reason: 'good', bullets: ['acme.llm'] }], /a fit needs "base"/);
  await rejects(dir, [{ fingerprint: 's1', verdict: 'fit', reason: 'good', base: 'fde' }], /a fit needs a non-empty "bullets" array/);
  await rejects(dir, [fit('s1', { bullets: [] })], /non-empty "bullets"/);
  await rejects(dir, [noFit('s1', { bullets: ['acme.llm'] })], /"bullets" is not allowed on a no_fit/);
  await rejects(dir, [noFit('s1', { base: 'fde' })], /"base" is not allowed on a no_fit/);
});

test('a bad verdict value, a long or missing reason, and a wrong shape are rejected', async () => {
  const dir = await prepared();
  await rejects(dir, [noFit('s1', { verdict: 'perfect_fit' })], /verdict must be "fit" or "no_fit"/);
  await rejects(dir, [noFit('s1', { reason: 'x'.repeat(301) })], /reason is 301 chars, over 300/);
  await rejects(dir, [{ fingerprint: 's1', verdict: 'no_fit' }], /reason missing/);
  await rejects(dir, ['s1'], /is not an object/);
});

test('the file must carry the run id: in its name and in its run_id', async () => {
  const dir = await prepared();
  // right name, wrong run_id inside
  await rejects(dir, [noFit('s1')], /is not this run/, { run_id: '2026-10-12' });

  const { records, alias } = state(dir);
  const pool = normalizePool(POOL);
  const good = writeVerdicts(dir, RUN, [noFit('s1')]);
  assert.equal(verdictFileName(RUN), `verdicts-${RUN}.json`);
  assert.equal(validateVerdictFile(good, { runId: RUN, pool, records, alias }).ok, true);
  // the same, valid, content under a name without the run id is refused
  for (const name of ['verdicts.json', 'verdicts-2026-10-12.json', `verdicts-${RUN}-final.json`]) {
    const other = join(dir, name);
    copyFileSync(good, other);
    const r = validateVerdictFile(other, { runId: RUN, pool, records, alias });
    assert.equal(r.ok, false, name);
    assert.match(r.errors[0], /does not carry the run id/);
  }
  // and the entry point only ever reads verdicts-<its own run id>.json
  // (while this run still holds the lock, another run id is turned away outright)
  assert.equal((await run(['apply-verdicts', '--run-id', 'another-run', '--state-dir', dir], spies(dir))).code, 2);
  assert.equal((await run(['finish', '--run-id', RUN, '--state-dir', dir])).code, 0);
  const before = ledgerBytes(dir);
  const { code, out } = await run(['apply-verdicts', '--run-id', 'another-run', '--state-dir', dir], spies(dir));
  assert.notEqual(code, 0);
  assert.match(out, /verdicts-another-run\.json does not exist/);
  assert.equal(ledgerBytes(dir), before);
});

test('a file that is not JSON, or a pool that cannot be read, rejects', async () => {
  const dir = await prepared();
  const before = ledgerBytes(dir);
  writeVerdicts(dir, RUN, [noFit('s1')]);
  const r1 = await run(['apply-verdicts', '--run-id', RUN, '--state-dir', dir], { ...spies(dir), loadPool: () => { throw new Error('bullet pool unavailable: test'); } });
  assert.notEqual(r1.code, 0);
  assert.match(r1.out, /bullet pool unavailable/);
  const r2 = await run(['apply-verdicts', '--run-id', RUN, '--state-dir', dir], { ...spies(dir), loadPool: () => ({ bullets: {}, specs: [] }) });
  assert.notEqual(r2.code, 0, 'an empty pool is not a pool');
  assert.equal(ledgerBytes(dir), before);
  assert.throws(() => loadPool({ repoRoot: dir }), /does not exist/);
});

test('a second, different verdict for a posting already judged is rejected; the same file re-applied is a no-op', async () => {
  const dir = await prepared();
  const s = spies(dir);
  writeVerdicts(dir, RUN, [fit('s1'), noFit('s2')]);
  assert.equal((await run(['apply-verdicts', '--run-id', RUN, '--state-dir', dir], s)).code, 0);
  const after = ledgerBytes(dir);
  // same file again: nothing new is written, built or tracked
  const s2 = spies(dir);
  assert.equal((await run(['apply-verdicts', '--run-id', RUN, '--state-dir', dir], s2)).code, 0);
  assert.equal(ledgerBytes(dir), after);
  assert.equal(s2.calls.build.length + s2.calls.track.length, 0);
  // flipping a recorded no_fit to fit is refused
  writeVerdicts(dir, RUN, [fit('s1'), fit('s2')]);
  const r = await run(['apply-verdicts', '--run-id', RUN, '--state-dir', dir], spies(dir));
  assert.notEqual(r.code, 0);
  assert.match(r.out, /stage "judged", not "survived"/);
  assert.equal(ledgerBytes(dir), after);
});
