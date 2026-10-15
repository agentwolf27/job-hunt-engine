// A morning run in its own process, so a test can kill it for real.
//
//   node killed-run.mjs <state dir> <out dir> [kill spec]
//
// kill spec: "fetch:N"        die (exit 137) on the Nth fetch, before it returns
//            "build:N:after"  die right after the Nth resume build wrote its file
//            "track:N:before" die on the Nth tracker step, before it writes
//            "track:N:after"  die right after the Nth tracker step wrote its TSV
// With no kill spec the run goes to the end (prepare, apply-verdicts, finish).
// Every fake step appends to <out dir>/calls.log so the parent can count work.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { main } from '../../morning/run.mjs';
import { POOL, fit, noFit, posting } from './helpers.mjs';

const [stateDir, outDir, killSpec = ''] = process.argv.slice(2);
const [killStep, killN, killWhen = 'before'] = killSpec.split(':');
const RUN = 'kill-run';
const FITS = ['k1', 'k2', 'k3'];
const ALL = [...FITS, 'k4', 'k5'];

mkdirSync(join(outDir, 'builds'), { recursive: true });
mkdirSync(join(outDir, 'tsv'), { recursive: true });
const counts = { fetch: 0, build: 0, track: 0 };
const note = (line) => appendFileSync(join(outDir, 'calls.log'), `${line}\n`);
function maybeDie(step, when) {
  if (killStep === step && Number(killN) === counts[step] && killWhen === when) process.exit(137);
}

const postings = ALL.map((fp) => ({ fingerprint: fp, url: `https://jobs.example.test/${fp}`, portal: 'fixture', title: 'Forward Deployed Engineer', company: `Kill ${fp}`, location: 'Boston, MA' }));
const postingsFile = join(outDir, 'postings.json');
writeFileSync(postingsFile, JSON.stringify(postings));

const deps = {
  log: () => {},
  loadPool: () => POOL,
  fetchPosting: async (url) => {
    counts.fetch += 1;
    maybeDie('fetch', 'before');
    note(`fetch ${url}`);
    return { text: posting(), source: 'fixture' };
  },
  buildResume: async (req) => {
    counts.build += 1;
    note(`build ${req.key}`);
    writeFileSync(join(outDir, 'builds', `${req.key}.json`), JSON.stringify(req));
    maybeDie('build', 'after');
    return { spec_path: `${req.key}.json` };
  },
  trackFit: async ({ record }) => {
    counts.track += 1;
    maybeDie('track', 'before');
    note(`track ${record.fingerprint}`);
    writeFileSync(join(outDir, 'tsv', `morning-${record.fingerprint}.tsv`), `${record.company}\n`);
    maybeDie('track', 'after');
    return { num: '901', tsv: `morning-${record.fingerprint}.tsv` };
  },
};

const common = ['--run-id', RUN, '--state-dir', stateDir, '--delay-ms', '0'];
let code = await main(['prepare', ...common, '--postings', postingsFile], deps);
if (code !== 0) process.exit(code);
const verdictFile = join(stateDir, `verdicts-${RUN}.json`);
if (!existsSync(verdictFile)) {
  writeFileSync(verdictFile, JSON.stringify({ run_id: RUN, verdicts: [...FITS.map((fp) => fit(fp)), noFit('k4'), noFit('k5')] }));
}
code = await main(['apply-verdicts', ...common], deps);
if (code !== 0) process.exit(code);
process.exit(await main(['finish', ...common], deps));
