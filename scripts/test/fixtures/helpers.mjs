// Shared test helpers. No network, no career-ops: every step that would reach
// outside the temp directory is replaced by a fake that records its calls.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { foldLedger, readLedger } from '../../morning/ledger.mjs';
import { main } from '../../morning/run.mjs';

export const POOL = {
  bullets: {
    'acme.llm': 'Built an LLM pipeline.',
    'acme.jira': 'Shipped a JIRA insights tool.',
    'initech.npu': 'Ported a model to an NPU.',
    'globex.fde_rest': 'Built REST integrations for customers.',
  },
  specs: ['fde', 'qualcomm'],
};

const FILLER = [
  'About the role',
  'You will work directly with customers to design, build and deploy data and AI systems in production.',
  'You will write Python and TypeScript, own integrations end to end, and turn messy requirements into working software.',
  'What we offer',
  'Competitive salary, equity, health coverage and a team that ships.',
].join('\n');

/** A realistic posting body with `sentence` planted in the requirements. */
export function posting(sentence = '') {
  return `${FILLER}\nRequirements\n- Bachelor's degree in Computer Science or a related field\n- Strong programming skills in Python\n${sentence ? `- ${sentence}\n` : ''}- Clear written communication\n`;
}

export function tmp(prefix = 'morning-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** fetchPosting fake: looks the URL up in `pages`; a missing URL or an Error value fails. */
export function fakeFetch(pages, calls = []) {
  return async (url) => {
    calls.push(url);
    const v = pages[url];
    if (v === undefined) throw new Error('HTTP 404');
    if (v instanceof Error) throw v;
    return { text: v, source: 'fixture' };
  };
}

export function writePostings(dir, list, name = 'postings.json') {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(list, null, 2));
  return file;
}

/** Spies for the two side-effect steps; they write marker files under `outDir`. */
export function spies(outDir) {
  const calls = { build: [], track: [] };
  mkdirSync(join(outDir, 'builds'), { recursive: true });
  mkdirSync(join(outDir, 'tsv'), { recursive: true });
  return {
    calls,
    buildResume: async (req) => {
      calls.build.push(req);
      if (req.bullets.includes('__gate_fail__')) throw new Error('GATE FAILED: one page (got 2)');
      writeFileSync(join(outDir, 'builds', `${req.key}.json`), JSON.stringify(req));
      return { spec_path: join(outDir, 'builds', `${req.key}.json`) };
    },
    trackFit: async ({ record, specKey }) => {
      calls.track.push(record.fingerprint);
      const tsv = `morning-${record.fingerprint}.tsv`;
      writeFileSync(join(outDir, 'tsv', tsv), `${record.company}\t${record.title}\t${specKey}\n`);
      return { num: '900', report: `900-${record.fingerprint}.md`, tsv };
    },
  };
}

/** Run the morning entry point in-process. Returns {code, out}. */
export async function run(argv, deps = {}) {
  const out = [];
  const code = await main([...argv, '--delay-ms', '0'], { log: (m) => out.push(m), loadPool: () => POOL, ...deps });
  return { code, out: out.join('\n') };
}

export function state(stateDir) {
  return foldLedger(readLedger(stateDir));
}

export function ledgerBytes(stateDir) {
  const f = join(stateDir, 'ledger.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

export function toJudge(stateDir, runId) {
  return JSON.parse(readFileSync(join(stateDir, `to-judge-${runId}.json`), 'utf8'));
}

export function writeVerdicts(stateDir, runId, verdicts, { name = `verdicts-${runId}.json`, extra = {}, run_id = runId } = {}) {
  const file = join(stateDir, name);
  writeFileSync(file, JSON.stringify({ run_id, verdicts, ...extra }, null, 2));
  return file;
}

export function list(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

export const fit = (fingerprint, over = {}) => ({
  fingerprint, verdict: 'fit', reason: 'Strong match on Python, customer-facing integration work and LLM pipelines.',
  base: 'fde', bullets: ['acme.llm', 'initech.npu'], ...over,
});
export const noFit = (fingerprint, over = {}) => ({ fingerprint, verdict: 'no_fit', reason: 'Role is hardware verification; no overlap.', ...over });
