// Reads one resume spec through the generator's CLI.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A review is tied to the exact words on the resume, so the hash covers the
// rendered sections, not only the list of bullet IDs: editing a bullet's wording
// in the pool changes it too.
export function dumpSpec(key) {
  try {
    const dump = JSON.parse(execFileSync('python3', ['outreach/resume/build_resume.py', '--dump', key], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    dump.spec_hash = createHash('sha256').update(JSON.stringify(dump.sections)).digest('hex');
    return dump;
  } catch {
    return null;
  }
}
