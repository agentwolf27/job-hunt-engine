// node --test scripts/test/knockout-traps.test.mjs
//
// Planted postings go THROUGH the morning entry point (run.mjs `prepare`, with
// the network replaced by a fixture fetch) and must end as SKIP — stage
// `knocked_out` — in the ledger, by code. A verdict file that calls one of them
// a fit is rejected whole. The pure-function fixture table runs here too.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { knockout } from '../morning/knockout.mjs';
import { PASS, SKIP } from './fixtures/knockout-cases.mjs';
import { fakeFetch, fit, ledgerBytes, noFit, posting, run, spies, state, tmp, toJudge, writePostings, writeVerdicts } from './fixtures/helpers.mjs';

const TRAPS = [
  ['trap-years', 'experience', '3+ years of non-internship experience', '3+ years of non-internship experience in software engineering.'],
  ['trap-nosponsor', 'sponsorship', 'will not provide immigration sponsorship', 'Please note that the company will not provide immigration sponsorship for this role.'],
  ['trap-future', 'sponsorship', 'without sponsorship now or in the future', 'Candidates must be authorized to work in the United States without sponsorship now or in the future.'],
  ['trap-opt', 'sponsorship', 'no C2C / no OPT', 'W2 only: no C2C / no OPT.'],
  ['trap-gradwindow', 'grad_window', 'graduation between December 2026 and June 2027', 'Requires a graduation between December 2026 and June 2027.'],
  ['trap-clearance', 'clearance', 'security clearance', 'Must hold an active Secret security clearance.'],
  ['trap-phd', 'degree', 'PhD', 'A PhD in Computer Science or a related field is required.'],
];
const CONTROLS = ['clean-a', 'clean-b'];

function setup() {
  const dir = tmp();
  const pages = {};
  const postings = [];
  for (const [fp, , , sentence] of TRAPS) {
    const url = `https://jobs.example.test/${fp}`;
    pages[url] = posting(sentence);
    postings.push({ fingerprint: fp, url, portal: 'fixture', title: 'Forward Deployed Engineer', company: `Trap ${fp}`, location: 'San Francisco, CA' });
  }
  for (const fp of CONTROLS) {
    const url = `https://jobs.example.test/${fp}`;
    pages[url] = posting('0-2 years of experience; visa sponsorship is available.');
    postings.push({ fingerprint: fp, url, portal: 'fixture', title: 'Forward Deployed Engineer, New Grad', company: `Clean ${fp}`, location: 'New York, NY' });
  }
  postings.push({ fingerprint: 'gone', url: 'https://jobs.example.test/gone', portal: 'fixture', title: 'Software Engineer', company: 'Gone Co', location: 'Remote' });
  postings.push({ fingerprint: 'senior', url: 'https://jobs.example.test/senior', portal: 'fixture', title: 'Senior Forward Deployed Engineer', company: 'Senior Co', location: 'Remote' });
  pages['https://jobs.example.test/senior'] = posting();
  return { dir, pages, file: writePostings(dir, postings) };
}

test('fixture table: every knock-out wording skips with the right rule and keeps its sentence', () => {
  for (const [rule, text, title] of SKIP) {
    const r = knockout({ title: title ?? 'Software Engineer', text });
    assert.equal(r.skip, true, `should skip: ${title ?? ''} | ${text}`);
    assert.equal(r.rule, rule, `wrong rule for: ${title ?? ''} | ${text}`);
    assert.ok(typeof r.sentence === 'string' && r.sentence.length > 0 && r.sentence.length <= 300, 'keeps the triggering sentence');
  }
});

test('fixture table: wording that must NOT trigger does not', () => {
  for (const [text, title] of PASS) {
    const r = knockout({ title: title ?? 'Software Engineer', text });
    assert.deepEqual(r, { skip: false }, `should pass: ${title ?? ''} | ${text} -> ${JSON.stringify(r)}`);
  }
});

test('the sentence kept is the one that triggered, not its neighbours', () => {
  const r = knockout({ title: 'Software Engineer', text: posting('The company will not provide immigration sponsorship.') });
  assert.equal(r.sentence, 'The company will not provide immigration sponsorship.');
});

test('planted postings fed through `run.mjs prepare` end knocked_out in the ledger', async () => {
  const { dir, pages, file } = setup();
  const { code } = await run(['prepare', '--run-id', 'r1', '--state-dir', dir, '--postings', file], { fetchPosting: fakeFetch(pages) });
  assert.equal(code, 0);
  const { records } = state(dir);
  for (const [fp, rule, phrase] of TRAPS) {
    const rec = records.get(fp);
    assert.equal(rec.stage, 'knocked_out', `${fp} should be knocked out`);
    assert.equal(rec.rule, rule, `${fp} rule`);
    assert.ok(rec.sentence.toLowerCase().includes(phrase.toLowerCase()), `${fp} keeps its sentence: ${rec.sentence}`);
  }
  assert.equal(records.get('senior').stage, 'knocked_out');
  assert.equal(records.get('senior').rule, 'seniority');
  for (const fp of CONTROLS) assert.equal(records.get(fp).stage, 'survived', `${fp} should survive`);
  // a posting that could not be fetched is unfetched, never a pass
  assert.equal(records.get('gone').stage, 'unfetched');

  const tj = toJudge(dir, 'r1');
  assert.deepEqual(tj.postings.map((p) => p.fingerprint).sort(), [...CONTROLS].sort(), 'to-judge holds the survivors only');
  assert.equal(tj.verdict_file, 'verdicts-r1.json');
  for (const p of tj.postings) {
    assert.deepEqual(Object.keys(p).sort(), ['company', 'fingerprint', 'location', 'text', 'title', 'url']);
    assert.match(p.text, /^<<<UNTRUSTED_POSTING_TEXT /);
    assert.match(p.text, /<<<END_UNTRUSTED_POSTING_TEXT /);
  }
});

test('a verdict file that marks a knocked-out posting "fit" is rejected whole', async () => {
  const { dir, pages, file } = setup();
  await run(['prepare', '--run-id', 'r1', '--state-dir', dir, '--postings', file], { fetchPosting: fakeFetch(pages) });
  const before = ledgerBytes(dir);
  const s = spies(dir);
  // one honest verdict plus one that tries to promote a knock-out
  writeVerdicts(dir, 'r1', [noFit('clean-a'), fit('trap-nosponsor')]);
  const { code, out } = await run(['apply-verdicts', '--run-id', 'r1', '--state-dir', dir], s);
  assert.notEqual(code, 0);
  assert.match(out, /REJECTED/);
  assert.match(out, /knocked out by code/);
  assert.equal(ledgerBytes(dir), before, 'ledger untouched');
  assert.equal(s.calls.build.length, 0, 'no resume built');
  assert.equal(s.calls.track.length, 0, 'no tracker row');
  assert.equal(state(dir).records.get('clean-a').stage, 'survived', 'the honest verdict in the same file is not applied either');
});

test('every knocked-out trap is refused, one at a time, even as no_fit', async () => {
  const { dir, pages, file } = setup();
  await run(['prepare', '--run-id', 'r1', '--state-dir', dir, '--postings', file], { fetchPosting: fakeFetch(pages) });
  const before = ledgerBytes(dir);
  for (const [fp] of TRAPS) {
    for (const v of [fit(fp), noFit(fp)]) {
      writeVerdicts(dir, 'r1', [v]);
      const { code } = await run(['apply-verdicts', '--run-id', 'r1', '--state-dir', dir], spies(dir));
      assert.notEqual(code, 0, `${fp} ${v.verdict} must be refused`);
    }
  }
  assert.equal(ledgerBytes(dir), before);
});

test('a knocked-out posting re-posted with the knock-out sentence removed stays knocked out', async () => {
  const { dir, pages, file } = setup();
  await run(['prepare', '--run-id', 'r1', '--state-dir', dir, '--postings', file], { fetchPosting: fakeFetch(pages) });
  await run(['finish', '--run-id', 'r1', '--state-dir', dir]);
  const calls = [];
  const again = writePostings(dir, [{
    fingerprint: 'trap-nosponsor-v2', url: 'https://jobs.example.test/reposted', portal: 'fixture',
    title: 'Forward Deployed Engineer', company: 'Trap trap-nosponsor', location: 'San Francisco, CA',
  }], 'again.json');
  const { code } = await run(['prepare', '--run-id', 'r2', '--state-dir', dir, '--postings', again],
    { fetchPosting: fakeFetch({ 'https://jobs.example.test/reposted': posting() }, calls) });
  assert.equal(code, 0);
  const st = state(dir);
  assert.equal(st.alias.get('trap-nosponsor-v2'), 'trap-nosponsor');
  assert.equal(st.records.get('trap-nosponsor').stage, 'knocked_out');
  assert.ok(!calls.includes('https://jobs.example.test/reposted'), 'the re-post is not fetched or re-judged');
  assert.ok(!toJudge(dir, 'r2').postings.some((p) => p.url.includes('reposted')));
  writeVerdicts(dir, 'r2', [fit('trap-nosponsor-v2')]);
  const r = await run(['apply-verdicts', '--run-id', 'r2', '--state-dir', dir], spies(dir));
  assert.notEqual(r.code, 0, 'and its alias cannot be promoted either');
});
