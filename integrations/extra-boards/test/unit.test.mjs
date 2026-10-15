import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import plugin, { parseDoverJobs, parseJibeJobs, parsePcsxPositions, RETRY_WAITS_MS } from '../index.mjs';

RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 1, 1); // no real waiting in tests

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// Serves saved responses by URL substring; a string body is returned as-is (a block page).
function fakeCtx(routes) {
  const calls = [];
  return {
    calls,
    settings: { pcsx_pause_ms: 0 },
    log: () => {},
    fetch: async (url) => {
      calls.push(url);
      const hit = routes.find(([part]) => url.includes(part));
      if (!hit) throw new Error(`unexpected request ${url}`);
      return { text: async () => (typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1])) };
    },
  };
}

test('dover: Motorq job list maps to Job[] with the apply URL, and reports the board total', async () => {
  const ctx = fakeCtx([['careers-page-slug/motorq', fixture('dover-slug.json')], ['/jobs?', fixture('dover-jobs.json')]]);
  const jobs = await plugin.provider.fetch({ name: 'Motorq', board: 'dover', dover: { slug: 'motorq' } }, ctx);
  assert.equal(jobs.length, 7);
  assert.equal(jobs.boardTotal, 7);
  const fde = jobs.find((j) => j.title === 'Forward Deployed Engineer');
  assert.deepEqual(fde, {
    title: 'Forward Deployed Engineer',
    url: 'https://app.dover.com/apply/Motorq/61f7f2e7-ba90-477a-827f-33e047641070',
    company: 'Motorq',
    location: 'United States · San Francisco, CA',
  });
  assert.equal(ctx.calls[1], 'https://app.dover.com/api/v1/careers-page/9e8e642f-e978-454c-b55c-910215742ec7/jobs?limit=100&offset=0');
});

test('dover: unpublished and sample jobs are dropped; an empty board still parses with total 0', () => {
  const rows = [
    { id: 'a', title: 'Real', locations: [] },
    { id: 'b', title: 'Draft', is_published: false },
    { id: 'c', title: 'Sample', is_sample: true },
  ];
  assert.deepEqual(parseDoverJobs({ count: 3, results: rows }, { clientName: 'Acme Co', company: 'Acme' }).jobs.map((j) => j.url), ['https://app.dover.com/apply/Acme%20Co/a']);
  assert.deepEqual(parseDoverJobs({ count: 0, results: [] }, { clientName: 'x', company: 'x' }), { total: 0, jobs: [] });
});

test('jibe: AMD jobs map to Job[] with careers-home URLs, a posted date and the board total', async () => {
  const ctx = fakeCtx([['careers.amd.com/api/jobs', fixture('jibe-amd.json')]]);
  const entry = { name: 'AMD', careers_url: 'https://careers.amd.com/careers-home/jobs', board: 'jibe', jibe: { country: 'United States', job_path: 'careers-home/jobs', max_pages: 1 } };
  const jobs = await plugin.provider.fetch(entry, ctx);
  assert.equal(jobs.length, 5);
  assert.equal(jobs.boardTotal, 659);
  assert.equal(jobs[0].title, 'Forward Deployed AI Research Scientist');
  assert.match(jobs[0].url, /^https:\/\/careers\.amd\.com\/careers-home\/jobs\/\d+$/);
  assert.match(jobs[0].location, /United States$/);
  assert.equal(typeof jobs[0].postedAt, 'number');
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0], 'https://careers.amd.com/api/jobs?page=1&limit=100&sortBy=posted_date&descending=true&country=United+States');
});

test('pcsx: Qualcomm positions map to Job[]; each search adds its count; duplicates across searches collapse', async () => {
  const ctx = fakeCtx([['careers.qualcomm.com/api/pcsx/search', fixture('pcsx-qualcomm.json')]]);
  const entry = {
    name: 'Qualcomm', careers_url: 'https://careers.qualcomm.com/careers', board: 'pcsx',
    pcsx: { domain: 'qualcomm.com', location: 'United States', searches: [{ filters: { seniority: 'Entry' } }, { query: 'college graduate' }] },
  };
  const jobs = await plugin.provider.fetch(entry, ctx);
  assert.equal(jobs.length, 6);
  assert.equal(jobs.boardTotal, 12);
  const grad = jobs.find((j) => j.title === 'Machine Learning Engineer - College Graduate');
  assert.equal(grad.url, 'https://careers.qualcomm.com/careers/job/446717859953');
  assert.equal(grad.location, 'San Diego, California, United States of America');
  assert.equal(typeof grad.postedAt, 'number');
  assert.equal(ctx.calls.length, 2);
  assert.match(ctx.calls[0], /filter_seniority=Entry/);
  assert.match(ctx.calls[1], /query=college\+graduate/);
});

test('a block page, a refusal and a changed shape all throw instead of reading as zero jobs', async () => {
  const html = '<!doctype html><html><title>Just a moment...</title></html>';
  const amd = { name: 'AMD', careers_url: 'https://careers.amd.com/x', board: 'jibe' };
  await assert.rejects(plugin.provider.fetch(amd, fakeCtx([['api/jobs', html]])), /not JSON/);
  await assert.rejects(plugin.provider.fetch(amd, fakeCtx([['api/jobs', { positions: [] }]])), /no jobs\[\] and totalCount/);
  assert.throws(() => parsePcsxPositions({ message: 'Not authorized for PCSX' }, { origin: 'https://x', company: 'x' }), /Not authorized for PCSX/);
  assert.throws(() => parseDoverJobs({ detail: 'Not found.' }, { clientName: 'x', company: 'x' }), /no results\[\] and count/);
  assert.throws(() => parseJibeJobs(null, { origin: 'https://x', jobPath: 'jobs', company: 'x' }), /jibe/);
  await assert.rejects(plugin.provider.fetch({ name: 'Motorq', board: 'dover', dover: { slug: 'motorq' } }, fakeCtx([['careers-page-slug', { detail: 'Not found.' }]])), /no client id/);
  await assert.rejects(plugin.provider.fetch({ name: 'X', board: 'nope' }, fakeCtx([])), /expected one of dover, jibe, pcsx/);
});

test('a 429 is retried after a wait and then parsed; a 429 that never clears fails; a 404 is not retried', async () => {
  const entry = { name: 'Qualcomm', careers_url: 'https://careers.qualcomm.com/careers', board: 'pcsx', pcsx: { domain: 'qualcomm.com' } };
  const body = JSON.stringify(fixture('pcsx-qualcomm.json'));
  let n = 0;
  const flaky = { settings: {}, fetch: async () => { if (n++ === 0) throw new Error('HTTP 429: Please try again later'); return { text: async () => body }; } };
  assert.equal((await plugin.provider.fetch(entry, flaky)).length, 6);
  assert.equal(n, 2);
  let m = 0;
  await assert.rejects(plugin.provider.fetch(entry, { settings: {}, fetch: async () => { m++; throw new Error('HTTP 429: Please try again later'); } }), /HTTP 429/);
  assert.equal(m, 3);
  let k = 0;
  await assert.rejects(plugin.provider.fetch(entry, { settings: {}, fetch: async () => { k++; throw new Error('HTTP 404: Not found'); } }), /HTTP 404/);
  assert.equal(k, 1);
});
