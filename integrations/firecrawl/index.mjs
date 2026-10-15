// @ts-check
// firecrawl — a career-ops plugin (plugins.local/firecrawl).
//
// search:   `node plugins.mjs run firecrawl search "forward deployed engineer hiring"`
//           Firecrawl /v2/search → Job[] (1 credit per result, no page scraping).
// provider: a portals.yml tracked_companies entry with `provider: firecrawl`
//           and a careers_url that no ATS provider can read. Firecrawl /v2/scrape
//           extracts the openings as JSON → Job[].
//
// Egress only through ctx.fetch (allowedHosts: api.firecrawl.dev). Free tier is
// 1,000 one-time credits, so every call logs its creditsUsed.

const API = 'https://api.firecrawl.dev/v2';

export const DEFAULT_EXCLUDED = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com'];

const JOBS_SCHEMA = {
  type: 'object',
  properties: {
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['title', 'url'],
      },
    },
  },
  required: ['jobs'],
};

/** @param {any} ctx @param {string} path @param {object} body */
async function post(ctx, path, body) {
  const key = ctx.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set in .env');
  const res = await ctx.fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data && data.success === false) throw new Error(`firecrawl ${path}: ${data.error || 'failed'}`);
  if (typeof data?.creditsUsed === 'number') ctx.log(`firecrawl ${path}: ${data.creditsUsed} credits used`);
  return data;
}

/** Best-effort company name from a result URL's host or ATS path. @param {string} url */
export function companyFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const atsHosts = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'wellfound.com'];
    if (atsHosts.some((h) => host.endsWith(h))) return u.pathname.split('/').filter(Boolean)[0] || '';
    return host.split('.').slice(-2, -1)[0] || '';
  } catch {
    return '';
  }
}

/** Whether a URL's host is one of the excluded domains or their subdomains. @param {string} url @param {string[]} domains */
export function isExcluded(url, domains) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return true;
  }
}

/** Resolve a possibly-relative job link against the page it came from. @param {string} href @param {string} base */
export function absoluteUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

/** @param {any} data → web results across the v2 (data.web) and v1 (data[]) shapes */
export function webResults(data) {
  if (Array.isArray(data?.data?.web)) return data.data.web;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

/** @param {any} data → extracted JSON across `json` and `answer` response shapes */
export function extracted(data) {
  return data?.data?.json ?? data?.data?.answer ?? data?.data?.extract ?? null;
}

export default {
  /** @param {string} query @param {any} ctx */
  async search(query, ctx) {
    const s = ctx.settings || {};
    const body = {
      query,
      limit: Number(s.limit) || 10,
      sources: ['web'],
      ...(s.tbs ? { tbs: s.tbs } : {}),
      ...(s.country ? { country: s.country } : {}),
      // LinkedIn is never read (terms of service); aggregator search pages aren't postings.
      excludeDomains: [...new Set([...DEFAULT_EXCLUDED, ...(Array.isArray(s.exclude_domains) ? s.exclude_domains : [])])],
    };
    if (ctx.dryRun) {
      ctx.log(`dry run: would search ${JSON.stringify(body)}`);
      return [];
    }
    const data = await post(ctx, '/search', body);
    return webResults(data)
      .filter((r) => r && r.url && (r.title || r.metadata?.title))
      .filter((r) => !isExcluded(r.url, body.excludeDomains))
      .map((r) => ({
        title: String(r.title || r.metadata?.title).trim(),
        url: r.url,
        company: companyFromUrl(r.url),
        location: '',
        ...(r.description ? { description: String(r.description) } : {}),
      }));
  },

  provider: {
    id: 'firecrawl',
    /** @param {any} entry a portals.yml tracked_companies entry @param {any} ctx */
    async fetch(entry, ctx) {
      const page = entry.api || entry.careers_url;
      if (!page) throw new Error(`firecrawl provider: ${entry.name} has no careers_url`);
      if (ctx.dryRun) {
        ctx.log(`dry run: would scrape ${page}`);
        return [];
      }
      const data = await post(ctx, '/scrape', {
        url: page,
        onlyMainContent: true,
        formats: [
          {
            type: 'json',
            schema: JOBS_SCHEMA,
            prompt: 'List every open job posting on this careers page: its title, the link to the posting, and its location.',
          },
        ],
      });
      const jobs = extracted(data)?.jobs;
      if (!Array.isArray(jobs)) return [];
      return jobs
        .map((j) => ({
          title: String(j.title || '').trim(),
          url: absoluteUrl(j.url, page),
          company: entry.name || '',
          location: String(j.location || ''),
        }))
        .filter((j) => j.title && j.url);
    },
  },
};
