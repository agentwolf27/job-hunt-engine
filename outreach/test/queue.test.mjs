import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, checkDraft, titleScore, openingFit, DAILY_CAP, NOTE_LIMIT } from '../queue.mjs';

const today = new Date('2026-10-01T12:00:00Z');
const opening = (company, title = 'Forward Deployed Engineer', location = 'San Francisco, CA') =>
  ({ company, title, url: `https://jobs.example/${company}`, location });
const conn = (name, title = 'Software Engineer') => ({ name, title, linkedin: `https://linkedin.com/in/${name.replace(/\s/g, '')}` });

test('caps the day at 20 people even with far more candidates', () => {
  const openings = [], joined = [];
  for (let i = 0; i < 40; i++) {
    openings.push(opening(`Co${i}`));
    joined.push({ company: `Co${i}`, connections: [conn(`Person ${i}`)] });
  }
  const { queue } = buildQueue({ joined, openings, today });
  assert.equal(queue.length, DAILY_CAP);
});

test('weekly cap: 95 sent this week leaves room for 5', () => {
  const log = Array.from({ length: 95 }, (_, i) => ({ date: '2026-09-28', name: `Old ${i}`, company: 'X', linkedin: `old${i}` }));
  const joined = Array.from({ length: 10 }, (_, i) => ({ company: `Co${i}`, connections: [conn(`New ${i}`)] }));
  const openings = joined.map((j) => opening(j.company));
  assert.equal(buildQueue({ joined, openings, log, today }).queue.length, 5);
});

test('connections only count at companies with an opening', () => {
  const { queue } = buildQueue({
    joined: [{ company: 'Hiring Co', connections: [conn('A B')] }, { company: 'Quiet Co', connections: [conn('C D')] }],
    openings: [opening('Hiring Co')],
    today,
  });
  assert.deepEqual(queue.map((q) => q.name), ['A B']);
  assert.equal(queue[0].kind, 'referral_ask');
});

test('nobody already in the log is queued again', () => {
  const c = conn('Ada Lovelace');
  const { queue } = buildQueue({
    joined: [{ company: 'Anthropic', connections: [c] }],
    openings: [opening('Anthropic')],
    log: [{ date: '2026-08-01', name: 'Ada Lovelace', company: 'Anthropic', linkedin: c.linkedin }],
    today,
  });
  assert.equal(queue.length, 0);
});

test('at most 2 people per company', () => {
  const { queue } = buildQueue({
    joined: [{ company: 'OpenAI', connections: [conn('P1'), conn('P2'), conn('P3')] }],
    openings: [opening('OpenAI')],
    today,
  });
  assert.equal(queue.length, 2);
});

test('seeds come first; a named mutual turns it into an intro request', () => {
  const { queue } = buildQueue({
    seeds: [{ name: 'Hiring Manager', company: 'Sierra', via: 'Sam Mutual' }, { name: 'Cold Target', company: 'Decagon' }],
    joined: [{ company: 'Anthropic', connections: [conn('Fde Person', 'Forward Deployed Engineer')] }],
    openings: [opening('Anthropic'), opening('Sierra')],
    today,
  });
  assert.equal(queue[0].source, 'seed');
  assert.equal(queue.find((q) => q.name === 'Hiring Manager').kind, 'intro_request');
  assert.equal(queue.find((q) => q.name === 'Cold Target').kind, 'connect_note');
  assert.equal(queue.find((q) => q.name === 'Hiring Manager').opening.company, 'Sierra');
});

test('FDE people and preferred locations rank above the rest', () => {
  const { queue } = buildQueue({
    joined: [
      { company: 'NYC Co', connections: [conn('Ops Person', 'Operations')] },
      { company: 'SF Co', connections: [conn('Fde Person', 'Forward Deployed Engineer')] },
    ],
    openings: [opening('NYC Co', 'Forward Deployed Engineer', 'New York, NY'), opening('SF Co')],
    today,
  });
  assert.equal(queue[0].name, 'Fde Person');
  assert.ok(titleScore('Technical Recruiter') > titleScore('Operations'));
});

test('connection notes over 300 characters are rejected', () => {
  const item = { kind: 'connect_note', name: 'Jane Doe', company: 'Sierra', draft: `Hi Jane, Sierra ${'x'.repeat(NOTE_LIMIT)}` };
  assert.match(checkDraft(item).join(), new RegExp(`over the ${NOTE_LIMIT}-char`));
});

test('generic and template notes are rejected', () => {
  const base = { kind: 'connect_note', name: 'Jane Doe', company: 'Sierra' };
  assert.ok(checkDraft({ ...base, draft: 'Hi Jane, I came across your profile at Sierra.' }).length);
  assert.ok(checkDraft({ ...base, draft: 'Hi [Name], loved Sierra.' }).length);
  assert.deepEqual(checkDraft({ ...base, draft: '' }), ['no draft yet']);
});

test('an intro request must address the mutual, and every note names the company', () => {
  const item = { kind: 'intro_request', name: 'Target Person', via: 'Sam Mutual', company: 'Sierra' };
  assert.match(checkDraft({ ...item, draft: 'Hi Target, could you intro me at Sierra?' }).join(), /doesn't address Sam/);
  assert.match(checkDraft({ ...item, draft: 'Hi Sam, could you intro me?' }).join(), /doesn't mention Sierra/);
  assert.deepEqual(checkDraft({ ...item, draft: 'Hi Sam, would you be open to introducing me to Target on the Sierra FDE team? Happy to send a blurb.' }), []);
});

test('a 1st-degree seed with no mutual is a network ask, not a cold connection request', () => {
  const { queue } = buildQueue({ seeds: [{ name: 'Old Friend', company: 'Example University', degree: '1st' }], today });
  assert.equal(queue[0].kind, 'network_ask');
});

test('recruiters with an email become recruiter emails; referral contacts become referral asks; both need an opening', () => {
  const { queue } = buildQueue({
    contacts: [
      { company: 'Databricks', name: 'Kelly Recruiter', email: 'kelly@databricks.example', kind: 'recruiter' },
      { company: 'Rippling', name: 'Kim Friend', kind: 'referral' },
      { company: 'Valve', name: 'No Opening', email: 'x@valve.example', kind: 'recruiter' },
    ],
    openings: [opening('Databricks'), opening('Rippling')],
    today,
  });
  assert.deepEqual(queue.map((q) => [q.name, q.kind]), [['Kim Friend', 'referral_ask'], ['Kelly Recruiter', 'recruiter_email']]);
});

test('an email-only recruiter is not queued twice and is logged by address', () => {
  const contacts = [{ company: 'Rippling', name: '', email: 'recruiting@rippling.example', kind: 'recruiter' }];
  const log = [{ date: '2026-09-30', name: '', company: 'Rippling', linkedin: 'recruiting@rippling.example' }];
  assert.equal(buildQueue({ contacts, openings: [opening('Rippling')], log, today }).queue.length, 0);
});

test('openings are picked for a new grad: early-career engineering beats senior, design and management', () => {
  assert.ok(openingFit('[2027] Software Engineer, Early Career') > openingFit('Forward Deployed Engineer'));
  assert.ok(openingFit('Forward Deployed Engineer') > openingFit('Software Engineer'));
  assert.ok(openingFit('Sr Staff Forward Deployed Engineer') < 0);
  assert.ok(openingFit('Manager, Forward Deployed Engineering') < 0);
  assert.ok(openingFit('[2027] Associate Product Designer, Early Career') < 0);
  const { queue } = buildQueue({
    contacts: [{ company: 'Roblox', name: 'Dana Example', email: 'dana@roblox.example', kind: 'recruiter' },
               { company: 'SoFi', name: 'Casey Example', email: 'casey@sofi.example', kind: 'recruiter' }],
    openings: [opening('Roblox', '[2027] Associate Product Designer, Early Career'), opening('Roblox', '[2027] Software Engineer, Early Career'),
               opening('SoFi', 'Sr Staff Forward Deployed Engineer, Enterprise AI')],
    today,
  });
  assert.deepEqual(queue.map((q) => [q.company, q.opening.title]), [['Roblox', '[2027] Software Engineer, Early Career']]);
});

test('placeholder contacts with no name and no email are skipped', () => {
  const { queue } = buildQueue({ contacts: [{ company: 'IBM', name: '(name cut off in screenshot)', kind: 'referral' }], openings: [opening('IBM', 'Entry Level Software Developer')], today });
  assert.equal(queue.length, 0);
});

test('a nickname in parentheses counts as addressing the person', () => {
  assert.deepEqual(checkDraft({ kind: 'connect_note', name: 'Jordan (Jo) Rivera', company: 'Acme', draft: 'Hi Jo, I applied to Acme.' }), []);
});
