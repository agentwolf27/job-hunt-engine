// Exit 0 only when career-ops reports the Firecrawl plugin as enabled with its key present.
// career-ops reads .env from its working directory, so plugins.mjs must run inside career-ops/.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const careerOps = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'career-ops');
const out = execFileSync(process.execPath, ['plugins.mjs', 'list'], { cwd: careerOps, encoding: 'utf8' });
const line = out.split('\n').find((l) => /^\s*firecrawl\b/.test(l)) || '(firecrawl not listed)';
console.log(line.trim());
process.exit(/enabled/.test(line) && !/missing env/.test(line) ? 0 : 1);
