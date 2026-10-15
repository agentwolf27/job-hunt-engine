#!/usr/bin/env node
// Passes only if the installed launchd agents say: scan at 05:45, audit at
// 07:00, nothing left at 08:00. It reads the installed plists and asks launchd
// whether each is loaded. It does not prove today's run happened; that is
// `node scripts/audit.mjs stamp`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), 'Library', 'LaunchAgents');
const want = { 'com.jobhunt.scan': [5, 45], 'com.jobhunt.audit': [7, 0] };
const problems = [];
const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();

const readPlist = (path) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }));
const times = (p) => [].concat(p.StartCalendarInterval || []).map((t) => [t.Hour, t.Minute ?? 0]);

for (const [label, [h, m]] of Object.entries(want)) {
  const path = join(dir, `${label}.plist`);
  if (!existsSync(path)) {
    problems.push(`${label}: not installed (${path} is missing)`);
    continue;
  }
  const t = times(readPlist(path));
  if (t.length !== 1 || t[0][0] !== h || t[0][1] !== m) problems.push(`${label}: scheduled at ${JSON.stringify(t)}, expected ${h}:${String(m).padStart(2, '0')}`);
  try {
    execFileSync('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'ignore' });
  } catch {
    problems.push(`${label}: installed but not loaded in launchd`);
  }
  console.log(`${label}: ${JSON.stringify(t)}`);
}
for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.startsWith('com.jobhunt.')) : []) {
  for (const [h, m] of times(readPlist(join(dir, f)))) if (h === 8 && m === 0) problems.push(`${f}: still has an 08:00 schedule`);
}
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log('OK: scan at 05:45, audit at 07:00, no 08:00 schedule');
