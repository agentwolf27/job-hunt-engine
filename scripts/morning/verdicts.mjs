// verdicts.mjs — checks the Claude session's ONLY output.
//
// File: <state dir>/verdicts-<run id>.json
//   {run_id, verdicts: [{fingerprint, verdict: "fit"|"no_fit", reason (<=300 chars),
//                        base?, bullets?}]}
// `base` (an existing resume spec key) and `bullets` (namespaced bullet IDs such
// as "acme.llm") are required for "fit" and forbidden for "no_fit".
//
// The WHOLE file is rejected on any one of:
//   - a file name that does not carry the run id, or a run_id that differs
//   - an unknown field anywhere
//   - an unknown bullet ID or base
//   - a fingerprint that is not at stage `survived` in the ledger
//     (knocked-out, unfetched, unknown, or already judged by another run)
//   - a duplicate fingerprint
// Nothing in the file is trusted beyond these checks: the session read untrusted
// posting text, so its output is treated as data to validate, not to obey.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const REASON_MAX = 300;
const TOP_KEYS = new Set(['run_id', 'verdicts']);
const VERDICT_KEYS = new Set(['fingerprint', 'verdict', 'reason', 'base', 'bullets']);

export function verdictFileName(runId) {
  return `verdicts-${runId}.json`;
}

export function verdictFilePath(stateDir, runId) {
  return join(stateDir, verdictFileName(runId));
}

/**
 * The pool of valid bullet IDs and spec keys, from the resume builder's own CLI.
 * Returns {bullets: Set<string>, specs: Set<string>}. Throws when the CLI is
 * missing or prints something else — an unreadable pool is never an empty pool.
 */
export function loadPool({ repoRoot = process.cwd(), script = 'outreach/resume/build_resume.py', python = 'python3' } = {}) {
  const path = join(repoRoot, script);
  if (!existsSync(path)) throw new Error(`bullet pool unavailable: ${script} does not exist`);
  const r = spawnSync(python, [path, '--list-bullets'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Error(`bullet pool unavailable: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`bullet pool unavailable: --list-bullets exited ${r.status}: ${(r.stderr || '').trim().slice(-300)}`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error('bullet pool unavailable: --list-bullets did not print JSON'); }
  return normalizePool(parsed);
}

export function normalizePool(pool) {
  if (!pool || typeof pool !== 'object') throw new Error('bullet pool is not an object');
  const b = pool.bullets;
  const s = pool.specs;
  const bullets = b instanceof Set ? b : new Set(Array.isArray(b) ? b : Object.keys(b ?? {}));
  const specs = s instanceof Set ? s : new Set(Array.isArray(s) ? s : Object.keys(s ?? {}));
  if (!bullets.size) throw new Error('bullet pool is empty');
  if (!specs.size) throw new Error('spec list is empty');
  return { bullets, specs };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate parsed verdict data. `records` is the fold of the ledger
 * (Map<fingerprint, record>); `alias` maps any fingerprint to its record's.
 * Returns {ok, errors: string[], verdicts}. ok is false if ANY error exists.
 */
export function validateVerdicts(data, { runId, pool, records, alias = new Map() }) {
  const errors = [];
  if (!isObj(data)) return { ok: false, errors: ['file is not a JSON object'], verdicts: [] };
  for (const k of Object.keys(data)) if (!TOP_KEYS.has(k)) errors.push(`unknown top-level field "${k}"`);
  if (data.run_id !== runId) errors.push(`run_id ${JSON.stringify(data.run_id)} is not this run (${runId})`);
  if (!Array.isArray(data.verdicts)) {
    errors.push('"verdicts" is not an array');
    return { ok: false, errors, verdicts: [] };
  }
  const seen = new Set();
  data.verdicts.forEach((v, i) => {
    const at = `verdicts[${i}]`;
    if (!isObj(v)) { errors.push(`${at} is not an object`); return; }
    for (const k of Object.keys(v)) if (!VERDICT_KEYS.has(k)) errors.push(`${at}: unknown field "${k}"`);
    const fp = v.fingerprint;
    if (typeof fp !== 'string' || !fp) { errors.push(`${at}: fingerprint missing`); return; }
    const canonical = alias.get(fp) ?? fp;
    if (seen.has(canonical)) errors.push(`${at}: duplicate fingerprint ${fp}`);
    seen.add(canonical);
    const rec = records.get(canonical);
    if (!rec) {
      errors.push(`${at}: fingerprint ${fp} is not in the ledger`);
    } else if (rec.stage === 'knocked_out') {
      errors.push(`${at}: fingerprint ${fp} was knocked out by code (${rec.rule}); a verdict cannot overrule it`);
    } else if (rec.stage !== 'survived') {
      // The one allowed exception is resuming THIS run: the same verdict, already recorded.
      const resumed = rec.judged_run === runId && rec.verdict === v.verdict
        && ['judged', 'built', 'tracked', 'failed'].includes(rec.stage)
        && (v.verdict !== 'fit' || (rec.base === v.base && JSON.stringify(rec.bullets) === JSON.stringify(v.bullets)));
      if (!resumed) errors.push(`${at}: fingerprint ${fp} is at stage "${rec.stage}", not "survived"`);
    }
    if (v.verdict !== 'fit' && v.verdict !== 'no_fit') errors.push(`${at}: verdict must be "fit" or "no_fit"`);
    if (typeof v.reason !== 'string' || !v.reason.trim()) errors.push(`${at}: reason missing`);
    else if (v.reason.length > REASON_MAX) errors.push(`${at}: reason is ${v.reason.length} chars, over ${REASON_MAX}`);
    if (v.verdict === 'fit') {
      if (typeof v.base !== 'string' || !v.base) errors.push(`${at}: a fit needs "base"`);
      else if (!pool.specs.has(v.base)) errors.push(`${at}: unknown base "${v.base}"`);
      if (!Array.isArray(v.bullets) || v.bullets.length === 0) errors.push(`${at}: a fit needs a non-empty "bullets" array`);
      else {
        const seenB = new Set();
        for (const b of v.bullets) {
          if (typeof b !== 'string') errors.push(`${at}: bullet ID is not a string`);
          else if (!pool.bullets.has(b)) errors.push(`${at}: unknown bullet ID "${b}"`);
          else if (seenB.has(b)) errors.push(`${at}: bullet ID "${b}" listed twice`);
          seenB.add(b);
        }
      }
    } else if (v.verdict === 'no_fit') {
      if ('base' in v) errors.push(`${at}: "base" is not allowed on a no_fit`);
      if ('bullets' in v) errors.push(`${at}: "bullets" is not allowed on a no_fit`);
    }
  });
  return { ok: errors.length === 0, errors, verdicts: errors.length === 0 ? data.verdicts : [] };
}

/**
 * Read and validate a verdict file. The file must be named verdicts-<run id>.json.
 * Returns {ok, errors, verdicts}; never throws for bad content.
 */
export function validateVerdictFile(file, { runId, pool, records, alias }) {
  if (!RUN_ID_RE.test(String(runId ?? ''))) return { ok: false, errors: [`bad run id ${JSON.stringify(runId)}`], verdicts: [] };
  if (basename(file) !== verdictFileName(runId)) {
    return { ok: false, errors: [`file name "${basename(file)}" does not carry the run id; expected "${verdictFileName(runId)}"`], verdicts: [] };
  }
  if (!existsSync(file)) return { ok: false, errors: [`${basename(file)} does not exist`], verdicts: [] };
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`${basename(file)} is not JSON: ${e.message}`], verdicts: [] };
  }
  return validateVerdicts(data, { runId, pool, records, alias });
}
