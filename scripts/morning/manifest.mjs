#!/usr/bin/env node
// A file manifest taken around the Claude session's judging step, so the audit
// can show the session changed nothing but its verdict file.
//
//   node scripts/morning/manifest.mjs before --run-id X   (just before the session judges)
//   node scripts/morning/manifest.mjs after  --run-id X   (right after it writes the verdict file)
//
// `after` writes outreach/state/morning/writers-<run id>.json listing every file
// added, changed or removed in between.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'graphify-out', 'logs', '.backup', '__pycache__', '.venv']);
// Under career-ops only the user's data is watched; its code and browser caches are not ours to hash.
const CAREER_OPS_WATCHED = ['data', 'reports', 'output', 'batch', 'cv.md', 'config', 'portals.yml'];

export function walk(root, dir = root, out = {}) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name === '.DS_Store') continue;
    const path = join(dir, name);
    const rel = relative(root, path);
    if (rel === 'career-ops') {
      for (const w of CAREER_OPS_WATCHED) {
        const p = join(path, w);
        if (!existsSync(p)) continue;
        if (statSync(p).isDirectory()) walk(root, p, out);
        else out[relative(root, p)] = hash(p);
      }
      continue;
    }
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(root, path, out);
    else if (st.isFile()) out[rel] = hash(path);
  }
  return out;
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function diff(before, after) {
  const changed = [];
  for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(f in before)) changed.push({ file: f, change: 'added' });
    else if (!(f in after)) changed.push({ file: f, change: 'removed' });
    else if (before[f] !== after[f]) changed.push({ file: f, change: 'changed' });
  }
  return changed.sort((a, b) => a.file.localeCompare(b.file));
}

export function run(argv, { root = ROOT, now = () => new Date() } = {}) {
  const [cmd, flag, runId] = argv;
  if (!['before', 'after'].includes(cmd) || flag !== '--run-id' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId || '')) {
    console.error('usage: manifest.mjs before|after --run-id X');
    return 1;
  }
  const dir = join(root, 'outreach', 'state', 'morning');
  mkdirSync(dir, { recursive: true });
  const beforePath = join(dir, `manifest-before-${runId}.json`);
  const writersPath = join(dir, `writers-${runId}.json`);
  const mine = new Set([relative(root, beforePath), relative(root, writersPath)]);
  const files = walk(root);
  for (const f of mine) delete files[f];
  if (cmd === 'before') {
    writeFileSync(beforePath, JSON.stringify({ run_id: runId, taken_at: now().toISOString(), files }));
    console.log(`manifest before ${runId}: ${Object.keys(files).length} files`);
    return 0;
  }
  if (!existsSync(beforePath)) {
    console.error(`manifest after ${runId}: no "before" manifest; run "before" first`);
    return 1;
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const changed = diff(before.files, files);
  writeFileSync(writersPath, JSON.stringify({ run_id: runId, before_at: before.taken_at, after_at: now().toISOString(), changed }, null, 2));
  console.log(`manifest after ${runId}: ${changed.length} file(s) changed${changed.length ? ': ' + changed.map((c) => c.file).join(', ') : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = run(process.argv.slice(2));
