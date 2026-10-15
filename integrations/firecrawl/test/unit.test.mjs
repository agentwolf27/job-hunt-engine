import test from 'node:test';
import assert from 'node:assert/strict';
import plugin, { companyFromUrl, absoluteUrl, webResults, extracted } from '../index.mjs';

function fakeCtx(response, settings = {}) {
  const calls = [];
  return {
    calls,
    env: { FIRECRAWL_API_KEY: 'fc-test' },
    settings,
    dryRun: false,
    log: () => {},
    fetch: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
      return { json: async () => response };
    },
  };
}

test('search maps v2 web results to Job[] and sends the key as a bearer token', async () => {
  const ctx = fakeCtx({
    success: true,
    creditsUsed: 2,
    data: {
      web: [
        { title: 'Forward Deployed Engineer', url: 'https://jobs.ashbyhq.com/sierra/123', description: 'Build agents' },
        { title: 'We are hiring FDEs', url: 'https://www.example.com/blog/hiring' },
        { url: 'https://no-title.example.com' },
      ],
    },
  }, { limit: 5, tbs: 'qdr:w' });
  const jobs = await plugin.search('forward deployed engineer hiring', ctx);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    title: 'Forward Deployed Engineer',
    url: 'https://jobs.ashbyhq.com/sierra/123',
    company: 'sierra',
    location: '',
    description: 'Build agents',
  });
  assert.equal(jobs[1].company, 'example');
  assert.equal(ctx.calls[0].url, 'https://api.firecrawl.dev/v2/search');
  assert.equal(ctx.calls[0].auth, 'Bearer fc-test');
  assert.deepEqual(ctx.calls[0].body, {
    query: 'forward deployed engineer hiring', limit: 5, sources: ['web'], tbs: 'qdr:w',
    excludeDomains: ['linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com'],
  });
});

test('provider turns a scraped careers page into Job[] with absolute URLs and the company name', async () => {
  const ctx = fakeCtx({
    success: true,
    data: { json: { jobs: [
      { title: 'Forward Deployed Engineer', url: '/careers/fde', location: 'NYC' },
      { title: '', url: '/careers/blank' },
    ] } },
  });
  const jobs = await plugin.provider.fetch({ name: 'Acme AI', careers_url: 'https://acme.ai/careers' }, ctx);
  assert.deepEqual(jobs, [{ title: 'Forward Deployed Engineer', url: 'https://acme.ai/careers/fde', company: 'Acme AI', location: 'NYC' }]);
  assert.equal(ctx.calls[0].url, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(ctx.calls[0].body.formats[0].type, 'json');
});

test('provider reads the `answer` response shape too', async () => {
  const ctx = fakeCtx({ success: true, data: { answer: { jobs: [{ title: 'FDE', url: 'https://x.dev/j/1' }] } } });
  const jobs = await plugin.provider.fetch({ name: 'X', careers_url: 'https://x.dev/careers' }, ctx);
  assert.equal(jobs.length, 1);
});

test('dry run spends no credits', async () => {
  const ctx = { ...fakeCtx({}), dryRun: true };
  assert.deepEqual(await plugin.search('q', ctx), []);
  assert.deepEqual(await plugin.provider.fetch({ name: 'X', careers_url: 'https://x.dev' }, ctx), []);
  assert.equal(ctx.calls.length, 0);
});

test('a failed API call surfaces the error instead of returning nothing', async () => {
  const ctx = fakeCtx({ success: false, error: 'Insufficient credits' });
  await assert.rejects(plugin.search('q', ctx), /Insufficient credits/);
});

test('missing key fails loudly', async () => {
  const ctx = { ...fakeCtx({}), env: {} };
  await assert.rejects(plugin.search('q', ctx), /FIRECRAWL_API_KEY/);
});

test('helpers', () => {
  assert.equal(companyFromUrl('https://boards.greenhouse.io/anthropic/jobs/1'), 'anthropic');
  assert.equal(companyFromUrl('not a url'), '');
  assert.equal(absoluteUrl('/a', 'https://b.com/c'), 'https://b.com/a');
  assert.deepEqual(webResults({ data: [{ url: 'u' }] }), [{ url: 'u' }]);
  assert.equal(extracted({}), null);
});

test('search drops LinkedIn and aggregator results even if the API returns them', async () => {
  const ctx = fakeCtx({ success: true, data: { web: [
    { title: 'FDE at Fin', url: 'https://www.linkedin.com/jobs/view/1' },
    { title: '800 FDE jobs', url: 'https://www.indeed.com/q-fde.html' },
    { title: 'FDE', url: 'https://careers.example.com/fde' },
  ] } }, { exclude_domains: ['example.org'] });
  const jobs = await plugin.search('q', ctx);
  assert.deepEqual(jobs.map((j) => j.url), ['https://careers.example.com/fde']);
  assert.ok(ctx.calls[0].body.excludeDomains.includes('example.org'));
});
