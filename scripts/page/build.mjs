#!/usr/bin/env node
// Writes the page and its snapshot. A Claude session publishes page.html as the
// private Artifact; this script never touches the network.
//
//   node scripts/page/build.mjs            → outreach/state/morning/page.html + page-snapshot.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, MORNING } from './snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function pageHTML(snapshot) {
  const core = readFileSync(join(HERE, 'core.mjs'), 'utf8').replace(/^export /gm, '');
  const json = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  const template = readFileSync(join(HERE, 'template.html'), 'utf8');
  return template.replace('/*__CORE__*/', () => core).replace('__SNAPSHOT__', () => json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = buildSnapshot();
  mkdirSync(MORNING, { recursive: true });
  writeFileSync(join(MORNING, 'page-snapshot.json'), JSON.stringify(snapshot, null, 2));
  writeFileSync(join(MORNING, 'page.html'), pageHTML(snapshot));
  const withResume = snapshot.rows.filter((r) => r.resume).length;
  console.log(`snapshot: ${snapshot.rows.length} rows, ${withResume} with a resume, run ${snapshot.run.id || 'none'}, ${snapshot.skipped.length} ruled out, ${snapshot.watchlist.length} named companies`);
  console.log(join(MORNING, 'page.html'));
}
