// node --test scripts/test/ledger.test.mjs
//
// The run ledger: a killed run resumes without duplicate rows or resumes, a
// second run started while one is alive exits, and a job re-posted under a new
// URL stays one record.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquireLock, appendEvent, foldLedger, readLedger, readLock, readRuns, releaseLock, repostKey } from '../morning/ledger.mjs';
import { fingerprintFor, readScanHistory } from '../morning/run.mjs';
import { fakeFetch, fit, ledgerBytes, list, noFit, posting, run, spies, state, tmp, toJudge, writePostings, writeVerdicts } from './fixtures/helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KILLED = join(HERE, 'fixtures/killed-run.mjs');
const RUN_MJS = join(HERE, '../morning/run.mjs');

const child = (stateDir, outDir, kill = '') => spawnSync(process.execPath, [KILLED, stateDir, outDir, kill], { encoding: 'utf8' });
const log = (outDir) => (existsSync(join(outDir, 'calls.log')) ? readFileSync(join(outDir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
const count = (arr, pred) => arr.filter(pred).length;
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // a pid that has already exited

function stageRows(stateDir) {
  const rows = {};
  for (const e of readLedger(stateDir)) {
    if (e.alias_of) continue;
    rows[e.stage] ??= {};
    rows[e.stage][e.fingerprint] = (rows[e.stage][e.fingerprint] ?? 0) + 1;
  }
  return rows;
}

function assertNoDuplicates(stateDir, outDir) {
  const rows = stageRows(stateDir);
  for (const fp of ['k1', 'k2', 'k3', 'k4', 'k5']) {
    assert.equal(rows.found[fp], 1, `${fp}: one found row`);
    assert.equal(rows.survived[fp], 1, `${fp}: one survived row`);
    assert.equal(rows.judged[fp], 1, `${fp}: one judged row`);
  }
  for (const fp of ['k1', 'k2', 'k3']) {
    assert.equal(rows.built[fp], 1, `${fp}: one built row`);
    assert.equal(rows.tracked[fp], 1, `${fp}: one tracked row`);
    assert.equal(state(stateDir).records.get(fp).stage, 'tracked');
  }
  assert.equal(rows.built.k4, undefined);
  assert.equal(rows.tracked.k4, undefined);
  assert.equal(list(join(outDir, 'tsv')).length, 3, 'three tracker TSVs, no duplicates');
  assert.equal(list(join(outDir, 'builds')).length, 3, 'three resumes, no duplicates');
  assert.equal(readRuns(stateDir).length, 1, 'the run is recorded once');
  assert.equal(readLock(stateDir), null, 'lock released');
}

test('ledger lines are appended in the documented shape and fold to one record', () => {
  const dir = tmp();
  const a = appendEvent(dir, { run_id: 'r', fingerprint: 'f1', stage: 'found', url: 'https://x.test/1', company: 'Acme, Inc.', title: 'FDE', location: 'NYC', key: 'k' });
  assert.deepEqual(Object.keys(a).slice(0, 4), ['ts', 'run_id', 'fingerprint', 'stage']);
  appendEvent(dir, { run_id: 'r', fingerprint: 'f1', stage: 'survived' });
  const first = ledgerBytes(dir);
  appendEvent(dir, { run_id: 'r', fingerprint: 'f1', stage: 'judged', verdict: 'no_fit', reason: 'no' });
  assert.ok(ledgerBytes(dir).startsWith(first), 'append-only: earlier bytes never change');
  const { records } = foldLedger(readLedger(dir));
  assert.equal(records.size, 1);
  assert.equal(records.get('f1').stage, 'judged');
  assert.deepEqual(records.get('f1').stages, ['found', 'survived', 'judged']);
  assert.throws(() => appendEvent(dir, { run_id: 'r', fingerprint: 'f1', stage: 'invented' }), /bad ledger event/);
  assert.throws(() => appendEvent(dir, { fingerprint: 'f1', stage: 'found' }), /bad ledger event/);
});

test('a run killed while fetching resumes: nothing settled is fetched or written twice', () => {
  const stateDir = tmp();
  const outDir = tmp();
  assert.equal(child(stateDir, outDir, 'fetch:3').status, 137);
  assert.equal(state(stateDir).records.get('k2').stage, 'survived');
  assert.equal(state(stateDir).records.get('k3').stage, 'found', 'the posting in flight is still only found');
  assert.equal(readRuns(stateDir).length, 0);
  assert.equal(child(stateDir, outDir).status, 0);
  const calls = log(outDir);
  for (const fp of ['k1', 'k2', 'k3', 'k4', 'k5']) assert.equal(count(calls, (l) => l === `fetch https://jobs.example.test/${fp}`), 1, `${fp} fetched once`);
  assertNoDuplicates(stateDir, outDir);
});

test('a run killed between building a resume and recording it resumes without a second ledger row', () => {
  const stateDir = tmp();
  const outDir = tmp();
  assert.equal(child(stateDir, outDir, 'build:2:after').status, 137);
  assert.equal(state(stateDir).records.get('k1').stage, 'tracked');
  assert.equal(state(stateDir).records.get('k2').stage, 'judged');
  assert.equal(child(stateDir, outDir).status, 0);
  const calls = log(outDir);
  assert.equal(count(calls, (l) => l.startsWith('fetch ')), 5, 'no posting fetched again');
  assert.equal(count(calls, (l) => l.startsWith('build ') && l.includes('k1')), 1, 'a recorded build is never repeated');
  assert.equal(count(calls, (l) => l.startsWith('build ') && l.includes('k3')), 1);
  assertNoDuplicates(stateDir, outDir);
});

test('a run killed before a tracker step resumes without duplicate rows or resumes', () => {
  const stateDir = tmp();
  const outDir = tmp();
  assert.equal(child(stateDir, outDir, 'track:2:before').status, 137);
  assert.equal(state(stateDir).records.get('k2').stage, 'built');
  assert.equal(child(stateDir, outDir).status, 0);
  const calls = log(outDir);
  assert.equal(count(calls, (l) => l.startsWith('build ')), 3, 'each resume built exactly once across both processes');
  assert.equal(count(calls, (l) => l.startsWith('track ')), 3, 'each tracker row written exactly once');
  assertNoDuplicates(stateDir, outDir);
});

test('a run killed right after a tracker TSV was written resumes to one TSV and one tracked row', () => {
  const stateDir = tmp();
  const outDir = tmp();
  assert.equal(child(stateDir, outDir, 'track:2:after').status, 137);
  assert.equal(child(stateDir, outDir).status, 0);
  assert.equal(count(log(outDir), (l) => l.startsWith('build ')), 3, 'no resume rebuilt');
  assertNoDuplicates(stateDir, outDir);
  // a third run of the same day adds nothing at all
  const bytes = ledgerBytes(stateDir);
  assert.equal(child(stateDir, outDir).status, 0);
  assert.equal(ledgerBytes(stateDir), bytes);
  assert.equal(count(log(outDir), (l) => l.startsWith('build ')), 3);
});

test('a line torn by a kill mid-write is ignored and its work redone; a corrupt line is an error', async () => {
  const dir = tmp();
  const pages = { 'https://jobs.example.test/t1': posting() };
  const file = writePostings(dir, [{ fingerprint: 't1', url: 'https://jobs.example.test/t1', portal: 'fixture', title: 'Engineer', company: 'Torn Co', location: 'Remote' }]);
  appendEvent(dir, { run_id: 'r1', fingerprint: 't1', stage: 'found', url: 'https://jobs.example.test/t1', title: 'Engineer', company: 'Torn Co', location: 'Remote', key: repostKey({ company: 'Torn Co', title: 'Engineer', location: 'Remote' }) });
  appendFileSync(join(dir, 'ledger.jsonl'), '{"ts":"2026-10-13T06:00:01.000Z","run_id":"r1","fingerprint":"t1","stage":"surv');
  const { code } = await run(['prepare', '--run-id', 'r1', '--state-dir', dir, '--postings', file], { fetchPosting: fakeFetch(pages) });
  assert.equal(code, 0);
  assert.equal(state(dir).records.get('t1').stage, 'survived');
  assert.equal(state(dir).records.size, 1);
  appendFileSync(join(dir, 'ledger.jsonl'), '{"ts": oops}\n');
  assert.throws(() => readLedger(dir), /is not JSON/);
});

test('a second run started while one is alive exits non-zero and writes nothing', async () => {
  const dir = tmp();
  const pages = { 'https://jobs.example.test/a': posting() };
  const file = writePostings(dir, [{ fingerprint: 'a', url: 'https://jobs.example.test/a', portal: 'fixture', title: 'Engineer', company: 'Lock Co', location: 'Remote' }]);
  // the first run: this very process, alive
  assert.deepEqual(acquireLock(dir, 'first'), { ok: true });
  assert.equal(readLock(dir).pid, process.pid);
  assert.equal(readLock(dir).run_id, 'first');

  // in-process, as another pid
  const calls = [];
  const r = await run(['prepare', '--run-id', 'second', '--state-dir', dir, '--postings', file], { fetchPosting: fakeFetch(pages, calls), pid: process.pid + 1 });
  assert.equal(r.code, 2);
  assert.match(r.out, /another run holds the lock/);
  assert.equal(calls.length, 0);
  assert.equal(ledgerBytes(dir), '');
  assert.ok(!existsSync(join(dir, 'to-judge-second.json')));

  // and as a real second process through the command line
  const cli = spawnSync(process.execPath, [RUN_MJS, 'prepare', '--run-id', 'second', '--state-dir', dir, '--postings', file], { encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /another run holds the lock/);
  assert.equal(ledgerBytes(dir), '');
  for (const cmd of ['apply-verdicts', 'finish']) {
    const c = spawnSync(process.execPath, [RUN_MJS, cmd, '--run-id', 'second', '--state-dir', dir], { encoding: 'utf8' });
    assert.equal(c.status, 2, `${cmd}: ${c.stdout}${c.stderr}`);
  }
  assert.equal(readLock(dir).run_id, 'first', 'the first run still holds the lock');
  assert.equal(readRuns(dir).length, 0);
  assert.equal(releaseLock(dir, 'second'), false, 'only the holder releases');
  assert.equal(releaseLock(dir, 'first'), true);
});

test('a stale lock from a dead pid is taken over', async () => {
  const dir = tmp();
  const pid = deadPid();
  writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid, run_id: 'crashed', started: '2026-10-12T06:00:00.000Z' }));
  const pages = { 'https://jobs.example.test/a': posting() };
  const file = writePostings(dir, [{ fingerprint: 'a', url: 'https://jobs.example.test/a', portal: 'fixture', title: 'Engineer', company: 'Lock Co', location: 'Remote' }]);
  const r = await run(['prepare', '--run-id', 'fresh', '--state-dir', dir, '--postings', file], { fetchPosting: fakeFetch(pages) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /took over a lock left by pid/);
  assert.equal(readLock(dir).run_id, 'fresh');
  assert.equal(readLock(dir).pid, process.pid);
  assert.equal(state(dir).records.get('a').stage, 'survived');
  assert.equal((await run(['finish', '--run-id', 'fresh', '--state-dir', dir])).code, 0);
  assert.equal(readLock(dir), null);
  assert.equal(list(dir).filter((f) => f.startsWith('run.lock')).length, 0, 'one lockfile, and it is gone');
});

test('a job re-posted under a new URL stays one record and keeps its verdict and status', async () => {
  const dir = tmp();
  const s = spies(dir);
  const first = [
    { fingerprint: 'fp-fit', url: 'https://jobs.example.test/old-fit', portal: 'fixture', title: 'Forward Deployed Engineer', company: 'Acme, Inc.', location: 'New York, NY' },
    { fingerprint: 'fp-no', url: 'https://jobs.example.test/old-no', portal: 'fixture', title: 'Data Engineer', company: 'Globex', location: 'Austin, TX' },
  ];
  const pages = Object.fromEntries(first.map((p) => [p.url, posting()]));
  assert.equal((await run(['prepare', '--run-id', 'd1', '--state-dir', dir, '--postings', writePostings(dir, first)], { fetchPosting: fakeFetch(pages) })).code, 0);
  writeVerdicts(dir, 'd1', [fit('fp-fit'), noFit('fp-no')]);
  assert.equal((await run(['apply-verdicts', '--run-id', 'd1', '--state-dir', dir], s)).code, 0);
  assert.equal((await run(['finish', '--run-id', 'd1', '--state-dir', dir])).code, 0);
  assert.equal(state(dir).records.size, 2);

  // next day: the same two jobs, re-posted — new URLs, new fingerprints, cosmetic differences
  const second = [
    { fingerprint: 'fp-fit-2', url: 'https://jobs.example.test/new-fit', portal: 'fixture', title: 'Forward  Deployed Engineer', company: 'ACME Inc', location: 'New York, NY' },
    { fingerprint: 'fp-no-2', url: 'https://jobs.example.test/new-no', portal: 'fixture', title: 'Data Engineer', company: 'Globex', location: 'Austin,  TX' },
    // same fingerprint under a new URL (a cross-listing)
    { fingerprint: 'fp-no', url: 'https://boards.example.test/cross-listed', portal: 'fixture', title: 'Data Engineer', company: 'Globex', location: 'Austin, TX' },
    // same title at the same company in another city is a different job
    { fingerprint: 'fp-sf', url: 'https://jobs.example.test/sf', portal: 'fixture', title: 'Forward Deployed Engineer', company: 'Acme, Inc.', location: 'San Francisco, CA' },
  ];
  const calls = [];
  const pages2 = { 'https://jobs.example.test/sf': posting() };
  assert.equal((await run(['prepare', '--run-id', 'd2', '--state-dir', dir, '--postings', writePostings(dir, second)], { fetchPosting: fakeFetch(pages2, calls) })).code, 0);

  const st = state(dir);
  assert.equal(st.records.size, 3, 'two re-posts fold into their records; only the SF job is new');
  assert.deepEqual(calls, ['https://jobs.example.test/sf'], 're-posts are not fetched again');
  const f = st.records.get('fp-fit');
  assert.equal(st.alias.get('fp-fit-2'), 'fp-fit');
  assert.deepEqual(f.aliases, ['fp-fit-2']);
  assert.deepEqual(f.urls, ['https://jobs.example.test/old-fit', 'https://jobs.example.test/new-fit']);
  assert.equal(f.stage, 'tracked', 'status inherited');
  assert.equal(f.verdict, 'fit', 'verdict inherited');
  const n = st.records.get('fp-no');
  assert.equal(n.stage, 'judged');
  assert.equal(n.verdict, 'no_fit');
  assert.deepEqual(n.urls, ['https://jobs.example.test/old-no', 'https://jobs.example.test/new-no', 'https://boards.example.test/cross-listed']);
  assert.deepEqual(toJudge(dir, 'd2').postings.map((p) => p.fingerprint), ['fp-sf'], 'only the genuinely new job goes to the session');

  // the re-posts bring no second resume and no second tracker row
  writeVerdicts(dir, 'd2', [noFit('fp-sf')]);
  assert.equal((await run(['apply-verdicts', '--run-id', 'd2', '--state-dir', dir], s)).code, 0);
  assert.equal(s.calls.build.length, 1);
  assert.equal(s.calls.track.length, 1);
  assert.equal(list(join(dir, 'tsv')).length, 1);
  assert.equal(count(readLedger(dir), (e) => e.stage === 'tracked'), 1);
  assert.equal((await run(['finish', '--run-id', 'd2', '--state-dir', dir])).code, 0);
  const runs = readRuns(dir);
  assert.deepEqual(runs.map((r) => r.run_id), ['d1', 'd2']);
  assert.equal(runs[1].counts.aliased, 3);
  assert.equal(runs[1].totals.tracked, 1);
  assert.equal(runs[1].records, 3);
});

test('a gate failure is recorded as failed with its reason and gets no tracker row', async () => {
  const dir = tmp();
  const s = spies(dir);
  const p = [{ fingerprint: 'g1', url: 'https://jobs.example.test/g1', portal: 'fixture', title: 'Engineer', company: 'Gate Co', location: 'Remote' }];
  await run(['prepare', '--run-id', 'g', '--state-dir', dir, '--postings', writePostings(dir, p)], { fetchPosting: fakeFetch({ [p[0].url]: posting() }) });
  writeVerdicts(dir, 'g', [fit('g1', { bullets: ['acme.llm', '__gate_fail__'] })]);
  const { code } = await run(['apply-verdicts', '--run-id', 'g', '--state-dir', dir], { ...s, loadPool: () => ({ bullets: ['acme.llm', '__gate_fail__'], specs: ['fde'] }) });
  assert.equal(code, 0);
  const rec = state(dir).records.get('g1');
  assert.equal(rec.stage, 'failed');
  assert.match(rec.error, /GATE FAILED: one page/);
  assert.equal(s.calls.track.length, 0);
  assert.deepEqual(rec.stages, ['found', 'survived', 'judged', 'failed']);
});

test('postings come from scan-history first seen since the last completed run; a missing fingerprint gets a stable one', async () => {
  const dir = tmp();
  const tsv = join(dir, 'scan-history.tsv');
  const head = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company';
  const row = (id, day, fp = `fp${id}`, status = 'added') => `https://jobs.example.test/${id}\t${day}\tfixture\tEngineer ${id}\tCo ${id}\t${status}\tRemote\t${fp}\t\t\t\tco ${id}`;
  writeFileSync(tsv, `${[head, row('old', '2026-10-01'), row('y', '2026-10-12'), row('t', '2026-10-13'), row('nofp', '2026-10-13', ''), row('skipped', '2026-10-13', 'fpskip', 'skipped_title')].join('\n')}\n`);
  assert.deepEqual(readScanHistory(tsv, '2026-10-12').map((r) => r.title), ['Engineer y', 'Engineer t', 'Engineer nofp']);
  assert.equal(readScanHistory(tsv, null).length, 4);
  assert.throws(() => readScanHistory(join(dir, 'absent.tsv'), null), /not found/);
  const a = fingerprintFor({ url: 'https://jobs.example.test/nofp', fingerprint: '' });
  assert.match(a, /^u[0-9a-f]{15}$/);
  assert.equal(a, fingerprintFor({ url: 'https://jobs.example.test/nofp' }));

  const pages = Object.fromEntries(['old', 'y', 't', 'nofp', 'new'].map((id) => [`https://jobs.example.test/${id}`, posting()]));
  const day = (d) => () => new Date(`${d}T13:00:00`);
  const state1 = tmp();
  // first ever run: only what was first seen today
  let calls = [];
  assert.equal((await run(['prepare', '--state-dir', state1, '--scan-history', tsv], { fetchPosting: fakeFetch(pages, calls), now: day('2026-10-13') })).code, 0);
  assert.deepEqual(calls.sort(), ['https://jobs.example.test/nofp', 'https://jobs.example.test/t']);
  assert.ok(existsSync(join(state1, 'to-judge-2026-10-13.json')), 'the run id defaults to the date');
  assert.equal((await run(['finish', '--run-id', '2026-10-13', '--state-dir', state1], { now: day('2026-10-13') })).code, 0);
  // next morning: rows since the last completed run's date, minus what the ledger already holds
  appendFileSync(tsv, `${row('new', '2026-10-14')}\n`);
  calls = [];
  assert.equal((await run(['prepare', '--state-dir', state1, '--scan-history', tsv], { fetchPosting: fakeFetch(pages, calls), now: day('2026-10-14') })).code, 0);
  assert.deepEqual(calls, ['https://jobs.example.test/new']);
  // unjudged survivors from yesterday are offered again
  assert.equal(toJudge(state1, '2026-10-14').postings.length, 3);
});

test('an unfetched posting is retried on later runs, at most three times, and is never a pass', async () => {
  const dir = tmp();
  const p = [{ fingerprint: 'u1', url: 'https://jobs.example.test/u1', portal: 'fixture', title: 'Engineer', company: 'Flaky Co', location: 'Remote' }];
  const file = writePostings(dir, p);
  const calls = [];
  for (const id of ['a', 'b', 'c', 'd']) {
    await run(['prepare', '--run-id', id, '--state-dir', dir, '--postings', file], { fetchPosting: fakeFetch({ [p[0].url]: new Error('timed out after 20000 ms') }, calls) });
    assert.equal(state(dir).records.get('u1').stage, 'unfetched');
    assert.equal(toJudge(dir, id).postings.length, 0);
    await run(['finish', '--run-id', id, '--state-dir', dir]);
  }
  assert.equal(calls.length, 3);
  assert.match(state(dir).records.get('u1').error, /timed out/);
});
