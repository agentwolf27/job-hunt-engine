// @ts-check
// extra-boards — a career-ops provider plugin (plugins.local/extra-boards).
//
// A portals.yml tracked_companies entry with `provider: extra-boards` and a
// `board:` naming one of the parsers below:
//
//   board: dover   Dover careers pages (Motorq).      dover: { slug }
//   board: jibe    iCIMS Jibe /api/jobs (AMD).        jibe:  { country, keywords?, job_path?, max_pages? }
//   board: pcsx    Eightfold /api/pcsx/search         pcsx:  { domain, location?, searches: [{ query?, filters? }], max_pages? }
//                  (Qualcomm; its /api/apply/v2/jobs, which career-ops' own
//                  eightfold provider reads, answers 403 "Not authorized for PCSX").
//
// Each parser throws when the response is not the shape it expects, so a block
// page or a changed API reads as a failure and never as "no jobs". The returned
// Job[] carries a non-enumerable `boardTotal`: the count the board itself
// reported, which is how a caller tells an understood empty answer from a broken one.
//
// Egress only through ctx.fetch (HTTPS, allowedHosts in manifest.json). No key,
// no paid service. One request at a time with a pause between requests.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAUSE_MS = 500;
const TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits before a second and a third try when a board answers "slow down" or a server error.
// Exported so tests can shorten it.
export const RETRY_WAITS_MS = [8_000, 20_000];

/** @param {any} ctx @param {string} url */
async function getJson(ctx, url) {
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await ctx.fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, timeoutMs: TIMEOUT_MS });
      break;
    } catch (err) {
      // career-ops' guarded fetch throws "HTTP <status>: <body>" for a non-2xx answer.
      if (attempt >= RETRY_WAITS_MS.length || !/^HTTP (429|5\d\d)\b/.test(String(err?.message))) throw err;
      await sleep(RETRY_WAITS_MS[attempt]);
    }
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).hostname}: response is not JSON (starts "${text.replace(/\s+/g, ' ').slice(0, 60)}")`);
  }
}

/** @param {any[]} jobs @param {number} total */
function withTotal(jobs, total) {
  Object.defineProperty(jobs, 'boardTotal', { value: total, enumerable: false });
  return jobs;
}

/** @param {any} entry */
function originOf(entry) {
  try {
    return new URL(entry.careers_url).origin;
  } catch {
    throw new Error(`extra-boards: ${entry.name} needs an absolute careers_url`);
  }
}

/** @param {unknown} v @param {number} dflt */
const pages = (v, dflt) => (Number.isInteger(v) && Number(v) > 0 ? Math.min(Number(v), 50) : dflt);

// ── Dover ──────────────────────────────────────────────────────────
// GET /api/v1/careers-page-slug/<slug>          → { id, name }
// GET /api/v1/careers-page/<id>/jobs?limit=&offset= → { count, next, results: [{ id, title, locations[], is_published, is_sample }] }

/** @param {any} json @param {{ clientName: string, company: string }} o */
export function parseDoverJobs(json, o) {
  if (!json || !Array.isArray(json.results) || typeof json.count !== 'number') {
    throw new Error('dover: job list has no results[] and count');
  }
  const jobs = [];
  for (const j of json.results) {
    if (!j || typeof j.id !== 'string' || typeof j.title !== 'string' || !j.title.trim()) continue;
    if (j.is_published === false || j.is_sample === true) continue;
    const places = Array.isArray(j.locations) ? j.locations.map((/** @type {any} */ l) => String(l?.name || '').trim()).filter(Boolean) : [];
    jobs.push({
      title: j.title.trim(),
      url: `https://app.dover.com/apply/${encodeURIComponent(o.clientName)}/${encodeURIComponent(j.id)}`,
      company: o.company,
      location: [...new Set(places)].join(' · '),
    });
  }
  return { total: json.count, jobs };
}

/** @param {any} entry @param {any} ctx */
async function fetchDover(entry, ctx) {
  const slug = String(entry.dover?.slug || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) throw new Error(`dover: ${entry.name} needs dover.slug`);
  const page = await getJson(ctx, `https://app.dover.com/api/v1/careers-page-slug/${slug}`);
  if (!page || typeof page.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(page.id)) throw new Error('dover: careers page has no client id');
  const all = [];
  let total = 0;
  for (let p = 0; p < pages(entry.dover?.max_pages, 5); p++) {
    await sleep(PAUSE_MS);
    const json = await getJson(ctx, `https://app.dover.com/api/v1/careers-page/${page.id}/jobs?limit=100&offset=${p * 100}`);
    const parsed = parseDoverJobs(json, { clientName: String(page.name || slug), company: entry.name });
    total = parsed.total;
    all.push(...parsed.jobs);
    if (!json.next || json.results.length === 0) break;
  }
  return withTotal(all, total);
}

// ── Jibe (iCIMS) ───────────────────────────────────────────────────
// GET <origin>/api/jobs?page=&limit=&country=&keywords=&sortBy=posted_date&descending=true
//   → { totalCount, jobs: [{ data: { slug, req_id, title, full_location, country, posted_date } }] }

/** @param {any} json @param {{ origin: string, jobPath: string, company: string }} o */
export function parseJibeJobs(json, o) {
  if (!json || !Array.isArray(json.jobs) || typeof json.totalCount !== 'number') {
    throw new Error('jibe: response has no jobs[] and totalCount');
  }
  const jobs = [];
  for (const row of json.jobs) {
    const d = row?.data;
    const id = String(d?.slug || d?.req_id || '').trim();
    const title = String(d?.title || '').trim();
    if (!id || !title) continue;
    const posted = Date.parse(String(d.posted_date || ''));
    jobs.push({
      title,
      url: `${o.origin}/${o.jobPath}/${encodeURIComponent(id)}`,
      company: o.company,
      location: [d.full_location || [d.city, d.state].filter(Boolean).join(', '), d.country].filter(Boolean).join(', '),
      ...(Number.isFinite(posted) ? { postedAt: posted } : {}),
    });
  }
  return { total: json.totalCount, jobs };
}

/** @param {any} entry @param {any} ctx */
async function fetchJibe(entry, ctx) {
  const cfg = entry.jibe || {};
  const origin = originOf(entry);
  const jobPath = String(cfg.job_path || 'jobs').replace(/^\/+|\/+$/g, '');
  const limit = 100;
  const seen = new Set();
  const all = [];
  let total = 0;
  for (let p = 1; p <= pages(cfg.max_pages, 10); p++) {
    if (p > 1) await sleep(PAUSE_MS);
    const q = new URLSearchParams({ page: String(p), limit: String(limit), sortBy: 'posted_date', descending: 'true' });
    if (cfg.country) q.set('country', String(cfg.country));
    if (cfg.keywords) q.set('keywords', String(cfg.keywords));
    const json = await getJson(ctx, `${origin}/api/jobs?${q}`);
    const parsed = parseJibeJobs(json, { origin, jobPath, company: entry.name });
    total = parsed.total;
    for (const j of parsed.jobs) {
      if (seen.has(j.url)) continue;
      seen.add(j.url);
      all.push(j);
    }
    if (json.jobs.length === 0 || p * limit >= total) break;
  }
  return withTotal(all, total);
}

// ── Eightfold PCSX ─────────────────────────────────────────────────
// GET <origin>/api/pcsx/search?domain=&query=&location=&filter_<name>=&start=&sort_by=timestamp
//   → { status: 200, data: { count, positions: [{ id, name, locations[], postedTs, positionUrl }] } }
// Ten positions a page, whatever is asked for.

const PCSX_PAGE = 10;
const PCSX_PAUSE_MS = 2_000; // Qualcomm answers 429 to quicker paging

/** @param {any} json @param {{ origin: string, company: string }} o */
export function parsePcsxPositions(json, o) {
  const data = json?.data;
  if (!data || !Array.isArray(data.positions) || typeof data.count !== 'number') {
    throw new Error(`pcsx: response has no data.positions[] and data.count${json?.message ? ` ("${String(json.message).slice(0, 80)}")` : ''}`);
  }
  const jobs = [];
  for (const p of data.positions) {
    const title = String(p?.name || '').trim();
    if (!title || p.id == null) continue;
    const posted = Number(p.postedTs) * 1000;
    jobs.push({
      title,
      url: `${o.origin}/careers/job/${encodeURIComponent(String(p.id))}`,
      company: o.company,
      location: (Array.isArray(p.locations) ? p.locations : []).filter((/** @type {unknown} */ l) => typeof l === 'string').join(' · '),
      ...(Number.isFinite(posted) && posted > 0 ? { postedAt: posted } : {}),
    });
  }
  return { total: data.count, jobs };
}

/** @param {any} entry @param {any} ctx */
async function fetchPcsx(entry, ctx) {
  const cfg = entry.pcsx || {};
  const origin = originOf(entry);
  if (!cfg.domain) throw new Error(`pcsx: ${entry.name} needs pcsx.domain`);
  const searches = Array.isArray(cfg.searches) && cfg.searches.length ? cfg.searches : [{}];
  const seen = new Set();
  const all = [];
  let total = 0;
  let first = true;
  for (const s of searches) {
    for (let p = 0; p < pages(cfg.max_pages, 3); p++) {
      if (!first) await sleep(ctx.settings?.pcsx_pause_ms ?? PCSX_PAUSE_MS);
      first = false;
      const q = new URLSearchParams({ domain: String(cfg.domain), query: String(s?.query || ''), start: String(p * PCSX_PAGE), sort_by: 'timestamp' });
      if (cfg.location) q.set('location', String(cfg.location));
      for (const [k, v] of Object.entries(s?.filters || {})) q.set(`filter_${k}`, String(v));
      const json = await getJson(ctx, `${origin}/api/pcsx/search?${q}`);
      const parsed = parsePcsxPositions(json, { origin, company: entry.name });
      if (p === 0) total += parsed.total;
      for (const j of parsed.jobs) {
        if (seen.has(j.url)) continue;
        seen.add(j.url);
        all.push(j);
      }
      if (json.data.positions.length < PCSX_PAGE || (p + 1) * PCSX_PAGE >= parsed.total) break;
    }
  }
  return withTotal(all, total);
}

const BOARDS = { dover: fetchDover, jibe: fetchJibe, pcsx: fetchPcsx };

export default {
  provider: {
    id: 'extra-boards',
    /** @param {any} entry a portals.yml tracked_companies entry @param {any} ctx */
    async fetch(entry, ctx) {
      const run = Object.hasOwn(BOARDS, entry.board) ? BOARDS[/** @type {keyof typeof BOARDS} */ (entry.board)] : null;
      if (!run) throw new Error(`extra-boards: ${entry.name} has board "${entry.board}"; expected one of ${Object.keys(BOARDS).join(', ')}`);
      return run(entry, ctx);
    },
  },
};
