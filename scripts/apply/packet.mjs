#!/usr/bin/env node
// Builds the "apply packet" for one tracker row: everything a session needs to
// fill that application form, and the checks that must pass before it starts.
//
//   node scripts/apply/packet.mjs <row> [--unreviewed] [--no-fetch]
//
// It refuses (exit 2) unless the row is still Evaluated, has a one-page resume
// on disk that the candidate approved in its current wording, and the posting, fetched
// again now, is open and has no knock-out. --unreviewed skips only the Approve
// check, and only when the candidate has said so in chat for this role.
//
// Writes outreach/state/apply/row-<n>.md and prints it. It fills nothing and
// sends nothing; filling is the /apply skill, and it stops before Submit.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSnapshot, ROOT, MORNING } from '../page/snapshot.mjs';
import { readReviews } from '../page/drain.mjs';
import { fetchPosting } from '../morning/fetch-posting.mjs';
import { knockout } from '../morning/knockout.mjs';

const CLOSED_RE = /\b(?:no longer (?:accepting|available|open)|position (?:has been|is) (?:filled|closed)|job (?:not found|has expired|is closed|posting has expired)|this job is no longer)\b/i;

// Pure: decides whether filling may start. `posting` is {text} | {error} | null (not fetched).
export function gate({ row, approved, pdfOnDisk, pages, posting, unreviewed = false }) {
  const stop = [];
  const warn = [];
  if (!row) return { ok: false, stop: ['no such row in the tracker'], warn };
  if (row.status !== 'Evaluated') stop.push(`the tracker already says ${row.status} for this role`);
  if (!row.url) stop.push('the row has no posting URL');
  if (!row.resume) stop.push('no resume is attached to this row');
  else {
    if (!row.resume.spec_hash) stop.push('the resume is in the older layout and was never reviewed here; rebuild it in the current format first');
    if (!pdfOnDisk) stop.push(`${row.resume.pdf_name} is not on disk`);
    else if (pages !== 1) stop.push(`the resume PDF has ${pages ?? 'an unknown number of'} pages, not 1`);
    if (!approved) (unreviewed ? warn : stop).push('the resume has no Approve for its current wording (approve it on the page, or pass --unreviewed if the candidate says to go ahead)');
  }
  if (posting && posting.error) stop.push(`the posting could not be opened to re-check it (${posting.error})`);
  else if (posting) {
    if (CLOSED_RE.test(posting.text)) stop.push('the posting now reads as closed');
    const ko = knockout({ title: row.role, text: posting.text });
    if (ko.skip) stop.push(`the posting has a knock-out (${ko.rule}): "${ko.sentence}"`);
  } else warn.push('the posting was not re-fetched, so it is not known to be open');
  return { ok: stop.length === 0, stop, warn };
}

function profileValue(yaml, key) {
  const m = new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm').exec(yaml);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

export function readProfile(root = ROOT) {
  const yaml = readFileSync(join(root, 'career-ops', 'config', 'profile.yml'), 'utf8');
  const pool = JSON.parse(readFileSync(join(root, 'outreach', 'state', 'resume', 'pool.json'), 'utf8'));
  const v = (k) => profileValue(yaml, k);
  const unconfirmed = (s) => !s || /UNCONFIRMED/i.test(s);
  return {
    name: v('full_name'),
    email: v('email'),
    phone: v('phone'),
    location: v('location'),
    linkedin: `https://${v('linkedin').replace(/^https?:\/\//, '')}`,
    github: `https://${v('github').replace(/^https?:\/\//, '')}`,
    portfolio: v('portfolio_url'),
    school: pool.education?.school || '',
    degree: pool.education?.degree || '',
    graduated: pool.education?.date || '',
    visa: v('visa_status'),
    needsSponsorship: v('needs_sponsorship') === 'true',
    relocation: v('location_flexibility'),
    salary: unconfirmed(v('minimum')) ? null : v('minimum'),
  };
}

export function packetMarkdown({ row, profile, pdfPath, verdict, date }) {
  const lines = [
    `# Apply packet: row ${row.row}, ${row.company}, ${row.role}`,
    '',
    `Made ${date}. Form: ${row.url}`,
    `Resume to upload: \`${pdfPath}\``,
    '',
    ...(verdict.warn.length ? ['**Warnings**', ...verdict.warn.map((w) => `- ${w}`), ''] : []),
    '## Answers to fill',
    '',
    '| Field | Answer |',
    '|---|---|',
    `| Full name | ${profile.name} |`,
    `| Email | ${profile.email} (the address on the resume; if the form is pre-filled with another, stop and ask the candidate which one) |`,
    `| Phone | ${profile.phone} |`,
    `| Current location | ${profile.location} |`,
    `| LinkedIn | ${profile.linkedin} |`,
    `| GitHub | ${profile.github} |`,
    `| Website or portfolio | ${profile.portfolio} |`,
    `| School | ${profile.school} |`,
    `| Degree | ${profile.degree} |`,
    `| Graduation | ${profile.graduated} |`,
    '| Current company | from the profile; leave blank if optional and not set |',
    '| Legally authorized to work in the US? | from the profile; stop and ask the candidate if unsure |',
    `| Will you now or in the future require sponsorship? | ${profile.needsSponsorship ? 'Yes' : 'No'} (${profile.visa}). Answer truthfully even where it is a knock-out. |`,
    '| Earliest start date | ask the candidate if the profile does not say |',
    `| Willing to relocate? | ${profile.relocation || 'ask the candidate'} |`,
    `| Salary expectation | ${profile.salary || 'not set in the profile: leave blank if optional, otherwise stop and ask the candidate'} |`,
    '',
    '## Leave for the candidate (never fill these)',
    '',
    '- Signing in, creating an account, any password, any verification code.',
    '- CAPTCHAs and "I am not a robot" checks.',
    '- Gender, race or ethnicity, veteran status, disability: theirs to answer or decline.',
    '- Consent, attestation and e-signature boxes, and the terms and privacy checkboxes.',
    '- Any question this table does not answer. For free-text questions ("Why this company?"), draft the answer in chat from `career-ops/cv.md` facts only, and type it into the form only after the candidate approves the wording.',
    '- **Submit.** Stop on the last page with everything filled and tell the candidate it is ready. They click Submit.',
    '',
    '## After the candidate submits',
    '',
    `\`node career-ops/set-status.mjs --row ${row.row} Applied\` (or the candidate taps Applied on the page). Never mark it Applied before they say they submitted.`,
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const n = Number(args.find((a) => /^\d+$/.test(a)));
  if (!n) {
    console.error('usage: node scripts/apply/packet.mjs <tracker row> [--unreviewed] [--no-fetch]');
    process.exit(1);
  }
  const row = buildSnapshot().rows.find((r) => r.row === n);
  let pdfPath = '';
  let pages = null;
  let approved = false;
  if (row && row.resume) {
    pdfPath = join(ROOT, 'career-ops', 'output', row.resume.pdf_name);
    if (existsSync(pdfPath)) pages = Number((/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' })) || [])[1]) || null;
    approved = readReviews(join(MORNING, 'reviews.jsonl')).some((r) => r.key === row.resume.key && r.spec_hash === row.resume.spec_hash && r.decision === 'approve');
  }
  let posting = null;
  if (row && row.url && !args.includes('--no-fetch')) {
    try {
      posting = await fetchPosting(row.url, '');
    } catch (e) {
      posting = { error: e.message };
    }
  }
  const verdict = gate({ row, approved, pdfOnDisk: !!pdfPath && existsSync(pdfPath), pages, posting, unreviewed: args.includes('--unreviewed') });
  if (!verdict.ok) {
    console.error(`NOT READY: row ${n}${row ? ` (${row.company}, ${row.role})` : ''}`);
    for (const s of verdict.stop) console.error(`- ${s}`);
    process.exit(2);
  }
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const md = packetMarkdown({ row, profile: readProfile(), pdfPath, verdict, date });
  const dir = join(ROOT, 'outreach', 'state', 'apply');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `row-${n}.md`), md);
  console.log(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
