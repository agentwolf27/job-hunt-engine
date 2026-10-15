// node --test scripts/test/fetch-posting.test.mjs
//
// fetchPosting with the network replaced by a fixture: the right public JSON
// endpoint is chosen per board, HTML is stripped to text, and every failure —
// HTTP error, timeout, a page too short to be a posting — throws, so the caller
// records `unfetched` and never a pass.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MIN_TEXT, endpointFor, fetchPosting, htmlToText } from '../morning/fetch-posting.mjs';

const LONG = 'You will build and deploy production systems with customers. '.repeat(8);

function fixture(routes, calls = []) {
  return async (url, init) => {
    calls.push(url);
    assert.ok(init.signal instanceof AbortSignal, 'every request carries an abort signal');
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    if (typeof body === 'function') return body(init);
    return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

test('endpointFor picks the public JSON endpoint per board', () => {
  assert.equal(endpointFor('https://job-boards.greenhouse.io/acme/jobs/123456').api, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/123456');
  assert.equal(endpointFor('https://job-boards.eu.greenhouse.io/parloa/jobs/4604587101').api, 'https://boards-api.eu.greenhouse.io/v1/boards/parloa/jobs/4604587101');
  assert.equal(endpointFor('https://jobs.ashbyhq.com/elevenlabs/275f43d0-b62d').api, 'https://api.ashbyhq.com/posting-api/job-board/elevenlabs');
  assert.equal(endpointFor('https://jobs.lever.co/acme/abc-123').api, 'https://api.lever.co/v0/postings/acme/abc-123');
  assert.equal(endpointFor('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Engineer_R123').api,
    'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Austin-TX/Engineer_R123');
  assert.equal(endpointFor('https://www.amazon.jobs/en/jobs/123').kind, 'html');
  assert.equal(endpointFor('https://stripe.com/jobs/listing/x?gh_jid=1').kind, 'html');
  assert.equal(endpointFor('file:///etc/passwd').kind, 'invalid');
  assert.equal(endpointFor('not a url').kind, 'invalid');
});

test('htmlToText strips tags and scripts, keeps one block per line, decodes entities', () => {
  const t = htmlToText('<h3>Requirements</h3><ul><li>3+ years &amp; a degree</li><li>U.S.&nbsp;citizen</li></ul><script>alert("x")</script><p>We won&#39;t sponsor.</p>');
  assert.equal(t, "Requirements\n- 3+ years & a degree\n- U.S. citizen\nWe won't sponsor.");
});

test('greenhouse, lever, ashby and workday postings are read from JSON', async () => {
  const calls = [];
  const f = fixture({
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1': { title: 'FDE', location: { name: 'NYC' }, content: `&lt;p&gt;${LONG}&lt;/p&gt;&lt;p&gt;No visa sponsorship.&lt;/p&gt;` },
    'https://api.lever.co/v0/postings/acme/abc': { text: 'FDE', categories: { location: 'SF' }, descriptionPlain: LONG, lists: [{ text: 'Requirements', content: '<li>5+ years</li>' }], additionalPlain: 'EEO' },
    'https://api.ashbyhq.com/posting-api/job-board/acme': { jobs: [{ id: 'u-1', title: 'FDE', location: 'Remote', descriptionPlain: LONG }, { id: 'u-2', title: 'Other', descriptionPlain: `${LONG} other` }] },
    'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Ext/job/Austin/Eng_R1': { jobPostingInfo: { title: 'Eng', location: 'Austin', jobDescription: `<p>${LONG}</p>` } },
  }, calls);
  const gh = await fetchPosting('https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse-api', { fetchImpl: f });
  assert.equal(gh.source, 'greenhouse');
  assert.match(gh.text, /^FDE\nNYC\nYou will build/);
  assert.match(gh.text, /No visa sponsorship\.$/);
  const lv = await fetchPosting('https://jobs.lever.co/acme/abc', 'lever-api', { fetchImpl: f });
  assert.match(lv.text, /Requirements\n- 5\+ years/);
  const a1 = await fetchPosting('https://jobs.ashbyhq.com/acme/u-1', 'ashby-api', { fetchImpl: f });
  const a2 = await fetchPosting('https://jobs.ashbyhq.com/acme/u-2', 'ashby-api', { fetchImpl: f });
  assert.match(a1.text, /^FDE\nRemote/);
  assert.match(a2.text, /other$/);
  assert.equal(calls.filter((u) => u.includes('ashbyhq')).length, 1, 'one board request serves every posting of that company');
  const wd = await fetchPosting('https://acme.wd1.myworkdayjobs.com/en-US/Ext/job/Austin/Eng_R1', '', { fetchImpl: f });
  assert.equal(wd.source, 'workday');
});

test('an unknown board falls back to the page HTML', async () => {
  const f = fixture({ 'https://careers.example.test/jobs/9': `<html><head><title>x</title><style>p{}</style></head><body><h1>Data Engineer</h1><p>${LONG}</p></body></html>` });
  const r = await fetchPosting('https://careers.example.test/jobs/9', 'custom', { fetchImpl: f });
  assert.equal(r.source, 'html');
  assert.match(r.text, /^Data Engineer\nYou will build/);
});

test('a failing JSON endpoint falls back to the page; both failing throws', async () => {
  const ok = fixture({ 'https://job-boards.greenhouse.io/acme/jobs/2': `<main><h1>FDE</h1><p>${LONG}</p></main>` });
  assert.equal((await fetchPosting('https://job-boards.greenhouse.io/acme/jobs/2', 'greenhouse-api', { fetchImpl: ok })).source, 'html');
  await assert.rejects(fetchPosting('https://job-boards.greenhouse.io/acme/jobs/3', 'greenhouse-api', { fetchImpl: fixture({}) }), /greenhouse endpoint: HTTP 404; page: HTTP 404/);
});

test('failures throw: HTTP error, a closed Ashby posting, too little text, a timeout', async () => {
  await assert.rejects(fetchPosting('https://careers.example.test/gone', '', { fetchImpl: fixture({}) }), /HTTP 404/);
  const shell = fixture({
    'https://api.ashbyhq.com/posting-api/job-board/shellco': { jobs: [] },
    'https://jobs.ashbyhq.com/shellco/u-9': '<html><body><div id="root"></div><script>app()</script></body></html>',
  });
  await assert.rejects(fetchPosting('https://jobs.ashbyhq.com/shellco/u-9', 'ashby-api', { fetchImpl: shell }), /characters of text/);
  assert.ok(MIN_TEXT >= 200);
  const hang = fixture({
    'https://careers.example.test/slow': (init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(fetchPosting('https://careers.example.test/slow', '', { fetchImpl: hang, timeoutMs: 30 }), /timed out after 30 ms/);
  await assert.rejects(fetchPosting('javascript:alert(1)', '', { fetchImpl: fixture({}) }), /not an http/);
});
