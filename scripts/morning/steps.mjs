// steps.mjs — the two real side-effect steps of `apply-verdicts`, kept apart from
// run.mjs so tests inject fakes and never touch career-ops or the resume builder.
//
//   buildResume({key, company, role, url, base, bullets}, ctx) -> {spec_path}
//       pipes the request to `build_resume.py --make-spec`, then runs
//       `build-all.sh <key>`. Any non-zero exit throws: a gate failure.
//
//   trackFit({record, verdict, runId, specKey, date}, ctx) -> {num, report, tsv}
//       reserves a report number with career-ops' own allocator, writes a stub
//       report and a tracker TSV, runs career-ops' merge-tracker.mjs, and
//       confirms the TSV was merged. Idempotent per fingerprint: a second call
//       reuses the same number, report and TSV name.
//
// Tracker rows are added only through merge-tracker.mjs. Nothing here edits
// career-ops/data/applications.md directly, and nothing sends anything.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function tail(s, n = 400) {
  const t = String(s ?? '').trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
}

export function slug(s, max = 40) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

/** Deterministic spec key for a posting: same posting, same key, every run. */
export function specKeyFor(record) {
  const fp = slug(record.fingerprint, 12).replace(/-/g, '') || 'x';
  return [slug(record.company, 20), slug(record.title, 28), fp.slice(0, 10)].filter(Boolean).join('-');
}

const COMPANY_NOISE = new Set(['inc', 'llc', 'corp', 'corporation', 'ltd', 'co', 'company', 'us', 'services', 'development', 'center', 'interactive', 'holdings', 'group', 'com', 'the']);

/**
 * A clean file name for the PDF a recruiter will see: Company_Role_Words, e.g.
 * "Amazon_Front_End_Engineer_2026". Legal suffixes, site codes ("- B13") and
 * bracketed notes are dropped; nothing machine-made is added.
 */
export function pdfNameFor(record) {
  const words = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\([^)]*\)/g, ' ').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const company = words(String(record.company ?? '').split(/\s+-\s+/)[0].replace(/\bU\.S\./g, ' ')).filter((w) => !COMPANY_NOISE.has(w.toLowerCase())).slice(0, 2);
  const role = [];
  for (const w of words(record.title)) {
    if ([...company, ...role, w].join('_').length > 56 || role.length === 6) break;
    role.push(w);
  }
  return [...company, ...role].join('_') || 'Resume';
}

export function buildResume(req, { repoRoot, python = 'python3', env = process.env } = {}) {
  const gen = join(repoRoot, 'outreach/resume/build_resume.py');
  const all = join(repoRoot, 'outreach/resume/build-all.sh');
  if (!existsSync(gen) || !existsSync(all)) throw new Error('resume builder not found under outreach/resume/');
  // Two postings can clean down to the same name (two "Software Engineer I" at one
  // company); the generator refuses a name another spec owns, so try _2, _3.
  let made;
  for (const suffix of req.pdf_name ? ['', '_2', '_3', '_4'] : ['']) {
    const body = req.pdf_name ? { ...req, pdf_name: `${req.pdf_name}${suffix}` } : req;
    made = spawnSync(python, [gen, '--make-spec'], { cwd: repoRoot, input: JSON.stringify(body), encoding: 'utf8', env });
    if (made.error) throw new Error(`make-spec: ${made.error.message}`);
    if (made.status === 0 || !/same PDF|no spec owns it/.test(made.stderr || made.stdout)) break;
  }
  if (made.status !== 0) throw new Error(`make-spec refused: ${tail(made.stderr || made.stdout)}`);
  const specPath = made.stdout.trim().split('\n').pop();
  const built = spawnSync('bash', [all, req.key], { cwd: repoRoot, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 });
  if (built.error) throw new Error(`build-all.sh: ${built.error.message}`);
  if (built.status !== 0) {
    const gates = `${built.stdout}\n${built.stderr}`.split('\n').filter((l) => /GATE FAILED/.test(l)).map((l) => l.trim());
    throw new Error(gates.length ? gates.join('; ') : `build-all.sh exited ${built.status}: ${tail(`${built.stdout}\n${built.stderr}`)}`);
  }
  return { spec_path: specPath };
}

/** The posting's own id as it appears in its URL: a long number, a UUID or a Workday R-number. */
export function postingIds(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const host = u.hostname.replace(/^www\./, '');
  const ids = decodeURIComponent(u.pathname).match(/(?<![A-Za-z0-9])(?:\d{5,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|R-?\d{4,})(?![A-Za-z0-9])/gi) || [];
  return ids.map((id) => `${host}|${id.toLowerCase()}`);
}

/** A tracker row that is already this posting (added by hand before the morning run saw it). */
export function existingRow(record, stateDir) {
  const file = join(stateDir, 'row-urls.json');
  if (!existsSync(file)) return null;
  const mine = new Set([record.url, ...(record.urls || [])].flatMap(postingIds));
  if (!mine.size) return null;
  for (const [row, url] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
    if (postingIds(url).some((id) => mine.has(id))) return row;
  }
  return null;
}

const cellSafe = (s) => String(s ?? '').replace(/[\t\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * ctx: {repoRoot, stateDir, careerOpsDir (code), dataRoot (data; defaults to
 * careerOpsDir — set it to a scratch copy to exercise this without touching the
 * real tracker)}.
 */
export function trackFit({ record, verdict, runId, specKey, date }, { repoRoot, stateDir, careerOpsDir = join(repoRoot, 'career-ops'), dataRoot = careerOpsDir } = {}) {
  const env = dataRoot === careerOpsDir ? process.env : { ...process.env, CAREER_OPS_ROOT: dataRoot };
  const node = process.execPath;
  // No second row for a posting the tracker already has; the resume attaches to that row.
  const have = existingRow(record, stateDir);
  if (have) return { num: have, report: null, tsv: null, existing: true };
  const sideDir = join(stateDir, 'tracker');
  mkdirSync(sideDir, { recursive: true });
  const sideFile = join(sideDir, `${slug(record.fingerprint, 64)}.json`);
  let side = existsSync(sideFile) ? JSON.parse(readFileSync(sideFile, 'utf8')) : null;
  if (!side) {
    const r = spawnSync(node, [join(careerOpsDir, 'reserve-report-num.mjs')], { cwd: careerOpsDir, encoding: 'utf8', env });
    const m = r.status === 0 ? /\b(\d{3,})\b/.exec(r.stdout) : null;
    if (!m) throw new Error(`could not reserve a report number: ${tail(r.stderr || r.stdout || r.error?.message)}`);
    const num = m[1];
    side = {
      num,
      report: `${num}-${slug(record.company, 30) || 'company'}-${date}.md`,
      tsv: `morning-${slug(record.fingerprint, 64)}.tsv`,
      fingerprint: record.fingerprint,
      run_id: runId,
    };
    writeFileSync(sideFile, `${JSON.stringify(side, null, 2)}\n`);
  }
  const reportsDir = join(dataRoot, 'reports');
  const addDir = join(dataRoot, 'batch/tracker-additions');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(addDir, { recursive: true });
  const reportFile = join(reportsDir, side.report);
  if (!existsSync(reportFile)) {
    writeFileSync(reportFile, [
      `# Evaluation: ${cellSafe(record.company)} — ${cellSafe(record.title)}`,
      '',
      `**Date:** ${date}`,
      '**Archetype:** not assessed (morning-run stub)',
      '**Score:** N/A',
      '**Legitimacy:** not assessed',
      `**URL:** ${record.url}`,
      `**PDF:** tailored resume built by the morning run, spec \`${specKey}\` — needs your review`,
      `**Fingerprint:** ${record.fingerprint}`,
      `**Morning run:** ${runId}`,
      '',
      '---',
      '',
      '## Stub report',
      '',
      'Written by `scripts/morning/run.mjs` so the tracker row has a report to link to.',
      'This is not a full career-ops evaluation: the role passed the code knock-out rules and the',
      'morning session judged the skills match a good fit.',
      '',
      `- Location: ${cellSafe(record.location) || 'not stated'}`,
      `- Verdict: fit`,
      `- Reason given: ${cellSafe(verdict.reason)}`,
      `- Resume base: ${verdict.base}`,
      `- Bullets: ${verdict.bullets.join(', ')}`,
      '',
    ].join('\n'));
  }
  // The real report now holds the number; drop career-ops' reservation sentinel
  // through its own CLI. Best effort: a leftover sentinel is garbage-collected.
  if (existsSync(join(reportsDir, `${side.num}-RESERVED.md`))) {
    spawnSync(node, [join(careerOpsDir, 'reserve-report-num.mjs'), '--release', side.num], { cwd: careerOpsDir, encoding: 'utf8', env });
  }
  const merged = join(addDir, 'merged', side.tsv);
  if (!existsSync(merged)) {
    const notes = cellSafe(`Morning run ${runId}: good fit, resume needs your review (spec ${specKey}); fp:${record.fingerprint}; ${verdict.reason}`);
    const row = [side.num, date, cellSafe(record.company), cellSafe(record.title), 'Evaluated', 'N/A', '❌', `[${side.num}](reports/${side.report})`, notes, record.url];
    writeFileSync(join(addDir, side.tsv), `num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl\n${row.join('\t')}\n`);
    const r = spawnSync(node, [join(careerOpsDir, 'merge-tracker.mjs')], { cwd: careerOpsDir, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`merge-tracker exited ${r.status}: ${tail(r.stderr || r.stdout)}`);
    if (!existsSync(merged)) throw new Error(`merge-tracker did not merge ${side.tsv}: ${tail(r.stdout || r.stderr)}`);
  }
  return { num: side.num, report: side.report, tsv: side.tsv };
}
