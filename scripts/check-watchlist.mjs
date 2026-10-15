// Exit 0 only when every named company's search was fetched and PARSED today.
//
//   node scripts/check-watchlist.mjs             self-test first, then every named company
//   node scripts/check-watchlist.mjs --selftest  only the self-test: broken searches must be reported as failures
//
// Each company's entries are read from career-ops/portals.yml (the `watchlist:` key,
// set in config/portals.fde.yml) and run through the same provider code the daily
// scan uses: career-ops' provider registry plus its enabled provider plugins.
//
// A search passes when the provider returned postings of the expected shape. Zero
// postings pass only when the provider also reported the board's own total as 0;
// otherwise an empty answer cannot be told from a block page or a changed layout,
// and it fails. An HTTP error, an unparseable body or a thrown parser fails; a timeout
// is tried once more first.
//
// One line per company goes to outreach/state/morning/watchlist-<YYYY-MM-DD>.json:
//   { company, provider, ok, total, matched, checked_at, error }
// total   = postings the search returned (the board's own count when it reports one)
// matched = how many of those pass portals.yml's title and location filters
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const careerOps = path.join(root, 'career-ops');

// Every company the plan names. A company with no `watchlist:` entry in portals.yml fails.
export const NAMED = ['Qualcomm', 'WHOOP', 'Amazon', 'Applied Materials', 'Fidelity', 'Bloomberg', 'Motorq', 'AMD', 'Siemens'];

const PAUSE_MS = 1000; // between searches; these are other people's career sites
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fromCareerOps = (file) => import(pathToFileURL(path.join(careerOps, file)).href);

/**
 * Run one portals.yml entry through its provider and judge the answer.
 * @param {any} entry
 * @param {Map<string, any>} providers
 * @param {{ resolveProvider: Function, makeCtx: () => any, matches?: (job: any) => boolean, retryPauseMs?: number }} deps
 */
export async function checkEntry(entry, providers, deps) {
  const out = { provider: '', ok: false, total: 0, matched: 0, error: '', jobs: [] };
  const fail = (msg) => ({ ...out, error: String(msg).replace(/\s+/g, ' ').slice(0, 300) });
  const resolved = deps.resolveProvider(entry, providers);
  if (!resolved) return fail('no provider matched this entry');
  if (resolved.error) return fail(resolved.error);
  out.provider = resolved.provider.id;
  let jobs;
  try {
    jobs = await resolved.provider.fetch(entry, deps.makeCtx());
  } catch (first) {
    // One more try after a pause for a timeout or a dropped connection. A refusal (HTTP 4xx)
    // or a parser that threw on what it was given is an answer, and is not asked again.
    if (!/aborted|timeout|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(String(first?.message))) return fail(first?.message || first);
    await sleep(deps.retryPauseMs ?? 20_000);
    try {
      jobs = await resolved.provider.fetch(entry, deps.makeCtx());
    } catch (err) {
      return fail(`${err?.message || err} (tried twice)`);
    }
  }
  if (!Array.isArray(jobs)) return fail('provider did not return a list of postings');
  const reported = typeof jobs.boardTotal === 'number' ? jobs.boardTotal : null;
  const bad = jobs.find((j) => !j || typeof j.title !== 'string' || !j.title.trim() || !/^https?:\/\//.test(String(j.url || '')));
  if (bad) return fail(`a posting came back without a title or a link: ${JSON.stringify(bad).slice(0, 120)}`);
  if (jobs.length === 0 && reported !== 0) {
    return fail(reported === null
      ? 'no postings parsed and no total reported: an empty board cannot be told from a block page or a changed layout'
      : `the board reports ${reported} postings but none were parsed`);
  }
  out.jobs = jobs;
  out.total = reported ?? jobs.length;
  out.matched = deps.matches ? jobs.filter(deps.matches).length : 0;
  out.ok = true;
  return out;
}

/** The scan's own providers, plugins and filters, loaded from career-ops. */
async function loadScanner() {
  process.chdir(careerOps); // career-ops reads .env and config/ from its working directory
  const [{ loadProviders, resolveProvider }, { mergeProviderPlugins }, { makeHttpCtx }, { buildTitleFilter }, { buildLocationFilter }, yaml] = await Promise.all([
    fromCareerOps('providers/_registry.mjs'),
    fromCareerOps('plugins/_engine.mjs'),
    fromCareerOps('providers/_http.mjs'),
    fromCareerOps('title-keywords.mjs'),
    fromCareerOps('scan.mjs'),
    fromCareerOps('node_modules/js-yaml/dist/js-yaml.mjs'),
  ]);
  const providers = await loadProviders(path.join(careerOps, 'providers'));
  await mergeProviderPlugins(providers, { root: careerOps });
  const config = yaml.load(readFileSync(path.join(careerOps, 'portals.yml'), 'utf8')) || {};
  const titleOk = buildTitleFilter(config.title_filter);
  const locationOk = buildLocationFilter(config.location_filter);
  return {
    providers,
    config,
    deps: {
      resolveProvider,
      makeCtx: () => ({ ...makeHttpCtx(), includeUndated: true, locationHints: config.location_filter }),
      matches: (job) => titleOk(job.title) && locationOk(job.location, job.url, job.title),
    },
  };
}

/**
 * The checker must call a broken search broken. Runs checkEntry on searches that
 * are broken on purpose, and on one good fixture so "fails everything" cannot pass.
 * @returns {Promise<boolean>} true when every broken case failed and the good one passed
 */
export async function selfTest(scanner) {
  const { providers, deps } = scanner;
  const fake = (fetch) => ({ providers: new Map([['fake', { id: 'fake', fetch }]]), entry: { name: 'self-test', provider: 'fake' } });
  const good = [{ title: 'Software Engineer I', url: 'https://example.com/jobs/1', company: 'self-test', location: 'Boston, MA' }];
  const plugin = (await import(pathToFileURL(path.join(root, 'integrations/extra-boards/index.mjs')).href)).default;
  const blockPage = { fetch: async () => ({ text: async () => '<!doctype html><title>Just a moment...</title>' }) };
  const cases = [
    { name: 'good fixture', expectOk: true, ...fake(async () => good) },
    { name: 'empty answer with no total', expectOk: false, ...fake(async () => []) },
    { name: 'board reports 12, none parsed', expectOk: false, ...fake(async () => Object.defineProperty([], 'boardTotal', { value: 12 })) },
    { name: 'posting without a title', expectOk: false, ...fake(async () => [{ url: 'https://example.com/jobs/1' }]) },
    { name: 'block page instead of JSON (AMD parser)', expectOk: false, ...fake(() => plugin.provider.fetch({ name: 'AMD', careers_url: 'https://careers.amd.com/x', board: 'jibe' }, blockPage)) },
    { name: 'timeout on both tries', expectOk: false, ...fake(async () => { throw new Error('This operation was aborted'); }) },
    { name: 'unknown provider', expectOk: false, providers, entry: { name: 'self-test', provider: 'no-such-provider' } },
    // Two live requests to addresses that do not exist: a real HTTP failure through the real provider code.
    { name: 'live: Workday site that does not exist', expectOk: false, providers, entry: { name: 'self-test', careers_url: 'https://amat.wd1.myworkdayjobs.com/NoSuchSite-selftest' } },
    { name: 'live: Dover company that does not exist', expectOk: false, providers, entry: { name: 'self-test', provider: 'extra-boards', board: 'dover', dover: { slug: 'no-such-company-selftest' } } },
  ];
  let pass = true;
  for (const c of cases) {
    const r = await checkEntry(c.entry, c.providers, { ...deps, retryPauseMs: 0 });
    const right = r.ok === c.expectOk;
    if (!right) pass = false;
    console.log(`  ${right ? 'ok  ' : 'WRONG'} ${c.name}: checker said ${r.ok ? 'pass' : `fail (${r.error})`}`);
  }
  return pass;
}

async function main() {
  const scanner = await loadScanner();
  console.log('Self-test: broken searches must fail');
  const selfOk = await selfTest(scanner);
  console.log(selfOk ? 'Self-test passed.' : 'Self-test FAILED: the checker cannot be trusted.');
  if (process.argv.includes('--selftest') || !selfOk) process.exit(selfOk ? 0 : 1);

  const { providers, config, deps } = scanner;
  const entries = [...(config.tracked_companies || []), ...(config.job_boards || [])].filter((e) => e && e.enabled !== false && e.watchlist);
  const lines = [];
  console.log('\nNamed companies');
  for (const company of NAMED) {
    const mine = entries.filter((e) => e.watchlist === company);
    const line = { company, provider: '', ok: mine.length > 0, total: 0, matched: 0, checked_at: '', error: mine.length ? '' : 'no entry in portals.yml carries this watchlist name' };
    const seen = new Set();
    const ids = new Set();
    for (const entry of mine) {
      if (lines.length || seen.size || ids.size) await sleep(PAUSE_MS);
      const r = await checkEntry(entry, providers, deps);
      if (r.provider) ids.add(r.provider);
      line.total += r.total;
      // A posting found by two searches of the same company counts once.
      for (const j of r.jobs) if (deps.matches(j)) seen.add(j.url);
      if (!r.ok) {
        line.ok = false;
        line.error = line.error || `${entry.name}: ${r.error}`;
      }
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${entry.name} [${r.provider || '?'}] total ${r.total}, matched ${r.matched}${r.error ? ` — ${r.error}` : ''}`);
    }
    line.provider = [...ids].join('+');
    line.matched = seen.size;
    line.checked_at = new Date().toISOString();
    lines.push(line);
  }

  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dir = path.join(root, 'outreach/state/morning');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `watchlist-${day}.json`);
  writeFileSync(file, `[\n${lines.map((l) => JSON.stringify(l)).join(',\n')}\n]\n`);

  const failed = lines.filter((l) => !l.ok);
  console.log(`\n${lines.length - failed.length} of ${lines.length} named companies parsed today → ${path.relative(root, file)}`);
  for (const l of failed) console.log(`FAILED ${l.company}: ${l.error}`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('check-watchlist crashed:', err?.message || err);
    process.exit(1);
  });
}
