#!/usr/bin/env node
// Keeps track of which resume PDFs are attached to the page.
//
//   node scripts/page/assets.mjs pending              PDFs the page shows that are new or changed since upload
//   node scripts/page/assets.mjs record <file> <id>   after the session uploads one (id is the 32-hex asset id)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildSnapshot, MORNING, ROOT } from './snapshot.mjs';

const path = join(MORNING, 'assets.json');
const assets = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const out = join(ROOT, 'career-ops', 'output');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const [cmd, file, id] = process.argv.slice(2);

if (cmd === 'pending') {
  // A rebuilt PDF differs byte for byte even when its words are the same, so a
  // resume built from a spec is compared by its contents hash, not the file's.
  const names = new Map(buildSnapshot().rows.filter((r) => r.resume && r.resume.pdf_name).map((r) => [r.resume.pdf_name, r.resume.spec_hash]));
  let n = 0;
  for (const [name, specHash] of names) {
    const f = join(out, name);
    if (!existsSync(f)) continue;
    if (assets[name] && assets[name].content === (specHash || sha(f))) continue;
    n += 1;
    console.log(`${f}${assets[name] ? `\treplaces ${assets[name].id}` : ''}`);
  }
  if (!n) console.log('none');
} else if (cmd === 'record' && file && /^[0-9a-f]{32}$/.test(id || '')) {
  const name = basename(file);
  const row = buildSnapshot().rows.find((r) => r.resume && r.resume.pdf_name === name);
  assets[name] = { id, url: `/_blob/${id}`, content: (row && row.resume.spec_hash) || sha(join(out, name)) };
  writeFileSync(path, JSON.stringify(assets, null, 1));
  console.log(`recorded ${name} -> ${id}`);
} else {
  console.error('usage: assets.mjs pending | record <file> <asset id>');
  process.exit(1);
}
