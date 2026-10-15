// Resume gates: a spec added to the specs folder is built and gated with no code edit; a two-page
// resume or an off-pool bullet fails the build. Run: node --test outreach/test/resume-gates.test.mjs
// Reads the private pool and specs (outreach/state/, gitignored) but writes only into a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GEN = join(root, 'outreach/resume/build_resume.py');
const BUILD_ALL = join(root, 'outreach/resume/build-all.sh');
const REAL_SPECS = join(root, 'outreach/state/specs');
const POOL = join(root, 'outreach/state/resume/pool.json');
const haveData = existsSync(POOL) && existsSync(REAL_SPECS);
const skip = haveData ? false : 'private resume data (outreach/state/) is not on this machine';

const tmp = mkdtempSync(join(tmpdir(), 'resume-gates-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// A sandbox is its own specs folder and output folder; nothing real is written.
function sandbox(name) {
  const specs = join(tmp, name, 'specs'), out = join(tmp, name, 'out');
  mkdirSync(specs, { recursive: true }); mkdirSync(out, { recursive: true });
  return { specs, out, env: { ...process.env, RESUME_SPECS_DIR: specs, RESUME_OUT_DIR: out } };
}
const gen = (args, opts = {}) => spawnSync('python3', [GEN, ...args], { encoding: 'utf8', ...opts });
const buildAll = (keys, env) => spawnSync('bash', [BUILD_ALL, ...keys], { encoding: 'utf8', env, timeout: 300_000 });
const realList = () => JSON.parse(gen(['--list-bullets']).stdout);
const handMade = () => realList().specs.filter(k => JSON.parse(readFileSync(join(REAL_SPECS, `${k}.json`), 'utf8')).hand_made);
const picked = dump => dump.sections.filter(s => ['Experience', 'Projects'].includes(s.heading))
  .flatMap(s => s.entries.flatMap(en => en.bullets.map(b => b.id)));

test('(d) bullet IDs are unique and every hand-made spec resolves', { skip }, () => {
  const { bullets, specs } = realList();
  const ids = Object.keys(bullets);
  const pool = JSON.parse(readFileSync(POOL, 'utf8'));
  const inPool = [...pool.jobs, ...pool.projects].reduce((n, o) => n + Object.keys(o.bullets).length, 0);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, inPool, 'two bullets share an ID');
  for (const id of ids) assert.match(id, /^[a-z0-9_]+\.[a-z0-9_]+$/);
  assert.equal(handMade().length, 7);
  for (const key of specs) {
    const r = gen(['--dump', key]);
    assert.equal(r.status, 0, `${key}: ${r.stderr}`);
    const d = JSON.parse(r.stdout);
    assert.deepEqual(d.sections.map(s => s.heading), ['Education', 'Experience', 'Projects', 'Technical Skills']);
    for (const id of picked(d)) assert.ok(bullets[id], `${key}: ${id}`);
    assert.equal(d.spec_hash, gen(['--spec-hash', key]).stdout.trim());
    assert.match(d.spec_hash, /^[0-9a-f]{64}$/);
  }
});

test('(a) a spec made with --make-spec is built and gated with no code edit', { skip }, () => {
  const sb = sandbox('a');
  const base = handMade()[0];
  cpSync(join(REAL_SPECS, `${base}.json`), join(sb.specs, `${base}.json`));
  const ids = picked(JSON.parse(gen(['--dump', base]).stdout));
  const req = { key: 'gate-test-newco', company: 'NewCo', role: 'Engineer', url: 'https://example.com/job', base, bullets: ids };
  const made = gen(['--make-spec'], { input: JSON.stringify(req), env: sb.env });
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout.trim(), join(sb.specs, 'gate-test-newco.json'));
  const spec = JSON.parse(readFileSync(made.stdout.trim(), 'utf8'));
  assert.equal(spec.pdf_name, 'gate_test_newco');
  assert.equal(spec.company, 'NewCo');

  const r = buildAll([], sb.env); // no key: it must find the new spec by looping the folder
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /== gate-test-newco\npages 1\n/);
  assert.match(r.stdout, /OK: 2 resume\(s\)/);
  const files = readdirSync(sb.out);
  const pdf = files.find(f => f.endsWith('_gate_test_newco.pdf'));
  assert.ok(pdf, `no PDF in ${files}`);
  assert.match(spawnSync('pdfinfo', [join(sb.out, pdf)], { encoding: 'utf8' }).stdout, /Pages:\s+1\n/);
  // Same bullets in the same order as the base, so the same words come out.
  const html = k => readFileSync(join(sb.out, files.find(f => f.endsWith(`-${k}.html`))), 'utf8');
  assert.equal(html('gate-test-newco'), html(base));
});

test('(b) a spec that runs to two pages fails the build', { skip }, () => {
  const sb = sandbox('b');
  const pool = JSON.parse(readFileSync(POOL, 'utf8'));
  const base = JSON.parse(readFileSync(join(REAL_SPECS, `${handMade()[0]}.json`), 'utf8'));
  const all = o => ({ bullets: Object.keys(o.bullets).map(n => `${o.id}.${n}`) });
  const spec = { ...base, key: 'gate-test-long', pdf_name: 'gate_test_long', hand_made: false,
    experience: pool.jobs.map(j => ({ job: j.id, ...all(j) })), projects: pool.projects.map(p => ({ project: p.id, ...all(p) })) };
  writeFileSync(join(sb.specs, 'gate-test-long.json'), JSON.stringify(spec));
  const r = buildAll(['gate-test-long'], sb.env);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /GATE FAILED: one page \(got [2-9]\) \(gate-test-long\)/);
});

test('(c) a spec naming an off-pool bullet fails the build, and --make-spec refuses bad requests', { skip }, () => {
  const sb = sandbox('c');
  const baseKey = handMade()[0];
  const base = JSON.parse(readFileSync(join(REAL_SPECS, `${baseKey}.json`), 'utf8'));
  cpSync(join(REAL_SPECS, `${baseKey}.json`), join(sb.specs, `${baseKey}.json`));
  const job = base.experience[0];
  const spec = { ...base, key: 'gate-test-offpool', pdf_name: 'gate_test_offpool', hand_made: false,
    experience: [{ job: job.job, bullets: [...job.bullets, `${job.job}.not_in_the_pool`] }, ...base.experience.slice(1)] };
  writeFileSync(join(sb.specs, 'gate-test-offpool.json'), JSON.stringify(spec));
  const r = buildAll(['gate-test-offpool'], sb.env);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /off-pool bullet/);
  assert.match(r.stdout, /GATE FAILED: spec \(gate-test-offpool\)/);
  assert.deepEqual(readdirSync(sb.out), [], 'nothing may be rendered for a refused spec');

  const ids = picked(JSON.parse(gen(['--dump', baseKey]).stdout));
  const make = req => gen(['--make-spec'], { input: JSON.stringify({ key: 'gate-test-x', company: '', role: '', url: '', base: baseKey, bullets: ids, ...req }), env: sb.env });
  const refused = (req, why) => { const m = make(req); assert.notEqual(m.status, 0, why); assert.match(m.stderr, why); };
  refused({ bullets: [...ids, 'nobody.nothing'] }, /unknown bullet ID/);
  refused({ base: 'no-such-base' }, /unknown base spec/);
  refused({ bullets: ids.filter(i => !i.startsWith(`${job.job}.`)) }, /at least one bullet/);
  refused({ key: baseKey }, /collides/);
  refused({ key: '../escape' }, /bad spec key/);
  assert.ok(!existsSync(join(sb.specs, 'gate-test-x.json')));
  assert.equal(make({}).status, 0);
});
