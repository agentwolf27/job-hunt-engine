// ledger.mjs — the morning run's append-only ledger, its lockfile, and the fold
// that turns the event log into one current record per posting.
//
// File: <state dir>/ledger.jsonl, one JSON object per line:
//   {ts, run_id, fingerprint, stage, ...}
// Stages: found, unfetched, knocked_out, survived, judged, built, tracked, failed.
//
// A posting is keyed by the scanner's fingerprint. A re-post — same normalized
// company + title + location under a new URL or fingerprint — is written as a
// `found` line carrying `alias_of: <first fingerprint>`; the fold keeps ONE
// record, which keeps its verdict and stage.
//
// Lines are only ever appended. Nothing here rewrites or truncates the ledger.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const STAGES = ['found', 'unfetched', 'knocked_out', 'survived', 'judged', 'built', 'tracked', 'failed'];
export const DEFAULT_STATE_DIR = 'outreach/state/morning';

const LEGAL = /\b(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pbc|sa|ag|holdings|technologies|technology|labs)\b/g;

function squash(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeCompany(s) {
  const t = squash(s);
  return t.replace(LEGAL, ' ').replace(/\s+/g, ' ').trim() || t;
}

/** The re-post key: normalized company + normalized title + normalized location. */
export function repostKey({ company, normalized_company, title, location }) {
  return [normalizeCompany(normalized_company || company), squash(title), squash(location)].join('|');
}

export function ledgerPath(dir) {
  return join(dir, 'ledger.jsonl');
}

/** Read every ledger line. A line that does not parse is an error, never skipped silently. */
export function readLedger(dir) {
  const file = ledgerPath(dir);
  if (!existsSync(file)) return [];
  const out = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated fragment is what a kill mid-write leaves: the event never
      // happened as far as the ledger is concerned, so its work is redone.
      // A complete-looking line that does not parse is corruption.
      if (!line.trimEnd().endsWith('}')) return;
      throw new Error(`ledger.jsonl line ${i + 1} is not JSON`);
    }
  });
  return out;
}

/** Append one event. Returns the event as written. */
export function appendEvent(dir, event, now = () => new Date()) {
  if (!event || !event.run_id || !event.fingerprint || !STAGES.includes(event.stage)) {
    throw new Error(`bad ledger event: ${JSON.stringify(event)}`);
  }
  mkdirSync(dir, { recursive: true });
  const file = ledgerPath(dir);
  const { run_id, fingerprint, stage, ...rest } = event;
  const line = { ts: now().toISOString(), run_id, fingerprint, stage, ...rest };
  // A torn last line (kill mid-write) must not swallow the next event.
  let lead = '';
  if (existsSync(file)) {
    const cur = readFileSync(file, 'utf8');
    if (cur.length && !cur.endsWith('\n')) lead = '\n';
  }
  appendFileSync(file, `${lead}${JSON.stringify(line)}\n`);
  return line;
}

/**
 * Fold events into current state.
 * Returns {records: Map<fingerprint, record>, alias: Map<fingerprint, canonical>, byKey: Map<key, canonical>}.
 * record: {fingerprint, aliases[], urls[], key, company, title, location, portal, url,
 *          stage, stages[], run_id, first_run, rule, sentence, error, attempts,
 *          verdict, reason, base, bullets, judged_run, spec_key, tracker, events}
 */
export function emptyState() {
  return { records: new Map(), alias: new Map(), byKey: new Map() };
}

/** Apply one event to a state in place. foldLedger is this over every line. */
export function applyEvent(state, e) {
  const { records, alias, byKey } = state;
  const canonical = e.alias_of ? (alias.get(e.alias_of) ?? e.alias_of) : (alias.get(e.fingerprint) ?? e.fingerprint);
  let r = records.get(canonical);
  if (e.alias_of) {
    // A re-post: remember the new fingerprint and URL, change nothing else.
    alias.set(e.fingerprint, canonical);
    if (r) {
      if (!r.aliases.includes(e.fingerprint) && e.fingerprint !== canonical) r.aliases.push(e.fingerprint);
      if (e.url && !r.urls.includes(e.url)) r.urls.push(e.url);
      r.events += 1;
    }
    return state;
  }
  if (!r) {
    r = { fingerprint: canonical, aliases: [], urls: [], stage: null, stages: [], attempts: 0, events: 0, first_run: e.run_id };
    records.set(canonical, r);
    alias.set(canonical, canonical);
  }
  r.events += 1;
  r.stage = e.stage;
  r.stages.push(e.stage);
  r.run_id = e.run_id;
  for (const k of ['company', 'normalized_company', 'title', 'location', 'portal', 'first_seen']) if (e[k] != null) r[k] = e[k];
  if (e.url) { r.url ??= e.url; if (!r.urls.includes(e.url)) r.urls.push(e.url); }
  if (e.stage === 'found') {
    r.key = e.key ?? null;
    if (r.key && !byKey.has(r.key)) byKey.set(r.key, canonical);
  }
  if (e.stage === 'unfetched') { r.attempts += 1; r.error = e.error; }
  if (e.stage === 'knocked_out') { r.rule = e.rule; r.sentence = e.sentence; }
  if (e.stage === 'judged') {
    r.verdict = e.verdict; r.reason = e.reason; r.judged_run = e.run_id;
    if (e.base != null) r.base = e.base;
    if (e.bullets != null) r.bullets = e.bullets;
  }
  if (e.stage === 'built') { r.spec_key = e.spec_key; r.spec_path = e.spec_path; }
  if (e.stage === 'tracked') r.tracker = e.tracker ?? null;
  if (e.stage === 'failed') { r.error = e.error; r.failed_step = e.step; }
  return state;
}

export function foldLedger(events) {
  const state = emptyState();
  for (const e of events) applyEvent(state, e);
  return state;
}

export function loadState(dir) {
  return foldLedger(readLedger(dir));
}

/** Count of records by current stage. */
export function stageTotals(records) {
  const t = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of records.values()) if (r.stage) t[r.stage] += 1;
  return t;
}

// ---------- lock ----------

export function lockPath(dir) {
  return join(dir, 'run.lock');
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Take the run lock. One lockfile, `run.lock`, holding {pid, run_id, started}.
 *  - no lock                      -> taken
 *  - lock held by a live pid      -> refused ({ok:false, holder}) unless it is this very pid and run
 *  - lock left by a dead pid      -> taken over ({ok:true, tookOver:holder})
 * A run is several processes (prepare, apply-verdicts, finish); the later ones
 * take the lock over from the earlier, dead, one and `finish` removes it.
 */
export function acquireLock(dir, runId, { pid = process.pid, isAlive = pidAlive, now = () => new Date() } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = lockPath(dir);
  const body = `${JSON.stringify({ pid, run_id: runId, started: now().toISOString() })}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, body);
      closeSync(fd);
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      holder = null; // unreadable or half-written: treated as held by nobody we can identify
    }
    if (holder && holder.pid === pid && holder.run_id === runId) return { ok: true, reentrant: true };
    if (holder && isAlive(holder.pid)) return { ok: false, holder };
    // Stale: replace atomically, then confirm we are the one who won.
    const tmp = `${file}.${pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
    try {
      const mine = JSON.parse(readFileSync(file, 'utf8'));
      if (mine.pid === pid && mine.run_id === runId) return { ok: true, tookOver: holder };
    } catch { /* lost the race; loop */ }
  }
  return { ok: false, holder: null };
}

/** Remove the lock if this run holds it. Returns true when a lock was removed. */
export function releaseLock(dir, runId) {
  const file = lockPath(dir);
  if (!existsSync(file)) return false;
  let holder = null;
  try { holder = JSON.parse(readFileSync(file, 'utf8')); } catch { /* fall through */ }
  if (holder && holder.run_id !== runId) return false;
  unlinkSync(file);
  return true;
}

export function readLock(dir) {
  try { return JSON.parse(readFileSync(lockPath(dir), 'utf8')); } catch { return null; }
}

// ---------- completed runs ----------

export function runsPath(dir) {
  return join(dir, 'runs.jsonl');
}

export function readRuns(dir) {
  const file = runsPath(dir);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function appendRun(dir, run) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(runsPath(dir), `${JSON.stringify(run)}\n`);
}
