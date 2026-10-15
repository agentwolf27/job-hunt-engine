// fetch-posting.mjs — get one posting's text.
//
// fetchPosting(url, portal, {fetchImpl, timeoutMs}) -> {text, source}
//
// Uses the public JSON endpoint for Greenhouse, Ashby, Lever and Workday when
// the URL gives enough to build it; otherwise fetches the page and strips the
// HTML. Every request has a 20 s timeout. Any failure, and any result too short
// to be a job description, THROWS — the caller records the posting as
// `unfetched`. A posting that could not be read is never treated as a pass.
//
// The returned text is untrusted data from the open web.

export const TIMEOUT_MS = 20_000;
export const MIN_TEXT = 200;
const UA = 'jobhunt-morning/1.0 (personal job search; one request per posting)';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', bull: '•', hellip: '...', middot: '·', copy: '(c)', reg: '(R)', trade: '(TM)' };

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&([a-z]{2,8});/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function safeCodePoint(n) {
  try { return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; } catch { return ''; }
}

/** HTML -> plain text, one block per line. */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer|table|blockquote)\s*>/gi, '\n')
      .replace(/<(?:p|div|h[1-6]|tr|section|article)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function get(url, { fetchImpl, timeoutMs, accept }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timed out after ${timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts) {
  const body = await get(url, { ...opts, accept: 'application/json' });
  try { return JSON.parse(body); } catch { throw new Error('response was not JSON'); }
}

/** Which public endpoint, if any, serves this posting. Exported for tests. */
export function endpointFor(url, portal = '') {
  let u;
  try { u = new URL(url); } catch { return { kind: 'invalid' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'invalid' };
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const j = parts.indexOf('jobs');
    if (j >= 1 && /^\d+$/.test(parts[j + 1] ?? '')) {
      const api = host.includes('.eu.') ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io';
      return { kind: 'greenhouse', api: `https://${api}/v1/boards/${encodeURIComponent(parts[j - 1])}/jobs/${parts[j + 1]}` };
    }
  }
  if (host === 'jobs.ashbyhq.com' && parts.length >= 2) {
    return { kind: 'ashby', org: parts[0], id: parts[1], api: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(parts[0])}` };
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && parts.length >= 2) {
    const api = host.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co';
    return { kind: 'lever', api: `https://${api}/v0/postings/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}` };
  }
  if (/\.myworkdayjobs\.com$/.test(host)) {
    const tenant = host.split('.')[0];
    const p = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? '') ? parts.slice(1) : parts;
    const j = p.indexOf('job');
    if (j >= 1) return { kind: 'workday', api: `https://${host}/wday/cxs/${tenant}/${p[0]}/${p.slice(j).map(encodeURIComponent).join('/')}` };
  }
  // Jibe career sites (AMD): the page is a JavaScript shell, the list API has the text.
  const cj = parts.indexOf('careers-home');
  if (cj >= 0 && parts[cj + 1] === 'jobs' && /^\d+$/.test(parts[cj + 2] ?? '')) {
    return { kind: 'jibe', id: parts[cj + 2], api: `https://${host}/api/jobs?keywords=${parts[cj + 2]}&limit=10` };
  }
  return { kind: 'html', hint: portal };
}

const ashbyBoards = new Map(); // one board fetch per org per process

async function viaEndpoint(ep, opts) {
  if (ep.kind === 'greenhouse') {
    const j = await getJson(ep.api, opts);
    return [j.title, j.location?.name, htmlToText(decodeEntities(j.content))].filter(Boolean).join('\n');
  }
  if (ep.kind === 'ashby') {
    if (!ashbyBoards.has(ep.api)) ashbyBoards.set(ep.api, getJson(ep.api, opts).catch((e) => { ashbyBoards.delete(ep.api); throw e; }));
    const board = await ashbyBoards.get(ep.api);
    const job = (board.jobs ?? []).find((x) => x.id === ep.id || String(x.jobUrl ?? '').includes(ep.id));
    if (!job) throw new Error('posting not on the Ashby board (closed?)');
    return [job.title, job.location, job.descriptionPlain || htmlToText(job.descriptionHtml)].filter(Boolean).join('\n');
  }
  if (ep.kind === 'lever') {
    const j = await getJson(ep.api, opts);
    const lists = (j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join('\n');
    return [j.text, j.categories?.location, j.descriptionPlain || htmlToText(j.description), lists, j.additionalPlain || htmlToText(j.additional)].filter(Boolean).join('\n');
  }
  if (ep.kind === 'workday') {
    const j = await getJson(ep.api, opts);
    const i = j.jobPostingInfo ?? {};
    return [i.title, i.location, htmlToText(i.jobDescription)].filter(Boolean).join('\n');
  }
  if (ep.kind === 'jibe') {
    const j = await getJson(ep.api, opts);
    const job = (j.jobs ?? []).map((x) => x.data ?? {}).find((d) => String(d.req_id) === ep.id || String(d.slug) === ep.id);
    if (!job) throw new Error('posting not in the Jibe job list (closed?)');
    return [job.title, job.location_name, htmlToText(job.description), htmlToText(job.qualifications), htmlToText(job.responsibilities)].filter(Boolean).join('\n');
  }
  throw new Error(`no endpoint for ${ep.kind}`);
}

export async function fetchPosting(url, portal = '', { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ep = endpointFor(url, portal);
  if (ep.kind === 'invalid') throw new Error('not an http(s) URL');
  const opts = { fetchImpl, timeoutMs };
  let text = '';
  let source = ep.kind;
  let apiError = null;
  if (ep.kind !== 'html') {
    try { text = await viaEndpoint(ep, opts); } catch (e) { apiError = e; }
  }
  if (text.trim().length < MIN_TEXT) {
    // Fall back to the page itself.
    source = 'html';
    try {
      text = htmlToText(await get(url, { ...opts, accept: 'text/html,application/xhtml+xml' }));
    } catch (e) {
      throw new Error(apiError ? `${ep.kind} endpoint: ${apiError.message}; page: ${e.message}` : e.message);
    }
  }
  text = text.trim();
  if (text.length < MIN_TEXT) throw new Error(`only ${text.length} characters of text (page needs a browser, or the posting is gone)`);
  return { text, source };
}
