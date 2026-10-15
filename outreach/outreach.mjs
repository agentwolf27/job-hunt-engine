#!/usr/bin/env node
// @ts-check
// Outreach CLI. Builds the day's list, checks drafted notes, and logs what you sent.
// It never sends anything: you send each note yourself (or confirms Claude in Chrome pasting it).
//
//   node outreach/outreach.mjs build            → outreach/state/queue-<today>.{json,md}
//   node outreach/outreach.mjs check [date]     → exit 1 if any draft is missing, too long or generic
//   node outreach/outreach.mjs mark <n> <sent|accepted|replied|declined> [date]
//
// Inputs (all in outreach/state/, gitignored because they hold other people's details):
//   seeds.tsv  name, linkedin, company, title, degree, via, note   (people you name)
//   contacts.tsv company, name, email, kind (referral|recruiter), source, note
//   log.tsv    date, name, linkedin, company, kind, status  (written by `mark`)
// plus career-ops/data/scan-history.tsv (openings) and career-ops/data/Connections.csv (via linkedin-join).

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQueue, checkDraft } from './queue.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const state = path.join(here, 'state');
const careerOps = path.join(root, 'career-ops');
mkdirSync(state, { recursive: true });

/** @param {string} file */
function readTsv(file) {
  if (!existsSync(file)) return [];
  const [head, ...rows] = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const cols = head.split('\t');
  return rows.map((r) => Object.fromEntries(r.split('\t').map((v, i) => [cols[i], v ?? ''])));
}

function openings() {
  return readTsv(path.join(careerOps, 'data', 'scan-history.tsv'))
    .filter((r) => r.status === 'added')
    .map((r) => ({ company: r.company, title: r.title, url: r.url, location: r.location }));
}

function joined() {
  if (!existsSync(path.join(careerOps, 'data', 'Connections.csv'))) return [];
  const out = execFileSync(process.execPath, ['linkedin-join.mjs'], { cwd: careerOps, encoding: 'utf8' });
  return JSON.parse(out).targets || [];
}

const LOG = path.join(state, 'log.tsv');
const LOG_COLS = ['date', 'name', 'linkedin', 'company', 'kind', 'status'];
const today = new Date();
const day = (d = today) => d.toISOString().slice(0, 10);
const queueFile = (d, ext) => path.join(state, `queue-${d}.${ext}`);

const KIND_LABEL = {
  referral_ask: 'Message (already connected): ask about the team / a referral',
  intro_request: 'Message the mutual connection: ask for an intro',
  connect_note: 'Connection request with a note (≤300 characters)',
  network_ask: 'Message (already connected): ask who they know at the target companies',
  recruiter_email: 'Email the recruiter (send from your Gmail)',
};

function render(d, items) {
  const lines = [`# Outreach for ${d}`, '', `${items.length} people. Send each one yourself, then log it: \`node outreach/outreach.mjs mark <n> sent\`.`, ''];
  items.forEach((it, i) => {
    lines.push(`## ${i + 1}. ${it.name || it.email} — ${it.company}`);
    if (it.title) lines.push(`- **Their role:** ${it.title}`);
    if (it.linkedin) lines.push(`- **Profile:** ${it.linkedin}`);
    if (it.email) lines.push(`- **Email:** ${it.email}`);
    lines.push(`- **How:** ${KIND_LABEL[it.kind]}${it.via ? ` (via ${it.via})` : ''}`);
    if (it.opening) lines.push(`- **Opening:** [${it.opening.title}](${it.opening.url})${it.opening.location ? ` · ${it.opening.location}` : ''}`);
    if (it.note) lines.push(`- **Your note:** ${it.note}`);
    lines.push('', '**Draft:**', '', it.draft ? `> ${it.draft}` : '_not drafted yet_', '');
  });
  return lines.join('\n');
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'build') {
  const { queue, room, sentThisWeek } = buildQueue({
    seeds: readTsv(path.join(state, 'seeds.tsv')),
    joined: joined(),
    contacts: readTsv(path.join(state, 'contacts.tsv')),
    openings: openings(),
    log: readTsv(LOG),
    today,
  });
  writeFileSync(queueFile(day(), 'json'), JSON.stringify(queue, null, 2));
  writeFileSync(queueFile(day(), 'md'), render(day(), queue));
  console.log(`${queue.length} people queued (room today: ${room}, sent this week: ${sentThisWeek}) → outreach/state/queue-${day()}.md`);
} else if (cmd === 'check') {
  const d = args[0] || day();
  const items = JSON.parse(readFileSync(queueFile(d, 'json'), 'utf8'));
  let bad = 0;
  items.forEach((it, i) => {
    const p = checkDraft(it);
    if (p.length) { bad++; console.log(`✗ ${i + 1}. ${it.name} (${it.company}): ${p.join('; ')}`); }
    else console.log(`✓ ${i + 1}. ${it.name} (${it.company})`);
  });
  writeFileSync(queueFile(d, 'md'), render(d, items));
  process.exit(bad ? 1 : 0);
} else if (cmd === 'mark') {
  const [n, status, d = day()] = args;
  const items = JSON.parse(readFileSync(queueFile(d, 'json'), 'utf8'));
  const it = items[Number(n) - 1];
  if (!it || !['sent', 'accepted', 'replied', 'declined'].includes(status)) {
    console.error('usage: mark <n> <sent|accepted|replied|declined> [date]');
    process.exit(1);
  }
  if (!existsSync(LOG)) writeFileSync(LOG, LOG_COLS.join('\t') + '\n');
  appendFileSync(LOG, [day(), it.name, it.linkedin || it.email || '', it.company, it.kind, status].join('\t') + '\n');
  console.log(`logged: ${it.name} (${it.company}) → ${status}`);
} else {
  console.log('usage: node outreach/outreach.mjs build | check [date] | mark <n> <status> [date]');
  process.exit(cmd ? 1 : 0);
}
