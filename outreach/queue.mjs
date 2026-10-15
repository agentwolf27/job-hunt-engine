// @ts-check
// Daily outreach queue: who to contact today, why, and through whom.
// Pure functions only; build-queue.mjs does the file I/O. Nothing here sends anything.

export const DAILY_CAP = 20;
export const WEEKLY_CAP = 100;
export const PER_COMPANY_CAP = 2;
export const NOTE_LIMIT = 200; // LinkedIn connection-note limit on a free account (300 on Premium)

// Locations that rank higher in the daily list. Set JOBHUNT_PREFERRED_LOCATIONS to a comma-separated
// list of place names (for example "seattle,portland,remote") to use your own; the default is California.
const DEFAULT_PREFERRED = 'san francisco|bay area|\\bsf\\b|california|, ca\\b|palo alto|mountain view|menlo park|los angeles';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PREFERRED = new RegExp(
  process.env.JOBHUNT_PREFERRED_LOCATIONS
    ? process.env.JOBHUNT_PREFERRED_LOCATIONS.split(',').map((s) => s.trim()).filter(Boolean).map(escapeRe).join('|')
    : DEFAULT_PREFERRED,
  'i',
);
const FDE = /forward deployed|\bfde\b|deployed engineer|deployment strategist|applied ai/i;
const ENGINEERING = /engineer|developer|\bswe\b|deployment strategist/i;
const EARLY = /new grad|early career|entry level|university|associate|\b20(26|27)\b|\bi\b|\b1\b/i;
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|head|vp|architect)\b/i;

/**
 * How well an opening fits a new grad targeting FDE / AI engineering. Negative means skip:
 * senior-only, or not an engineering role. @param {string} title
 */
export function openingFit(title) {
  const t = String(title || '');
  if (!ENGINEERING.test(t)) return -10;
  let fit = 1;
  if (FDE.test(t)) fit += 3;
  if (EARLY.test(t)) fit += 4; // an explicitly early-career role is the most reachable door
  if (SENIOR.test(t)) fit -= 6;
  return fit;
}

/** Fold a company or person name to a comparison key. @param {string} s */
export const key = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Openings grouped by company key, best first (FDE title, preferred location).
 * @param {{company:string,title:string,url:string,location?:string}[]} openings
 */
export function openingsByCompany(openings) {
  /** @type {Map<string, any[]>} */
  const map = new Map();
  for (const o of openings) {
    if (!o.company || !o.title) continue;
    const k = key(o.company);
    if (!map.has(k)) map.set(k, []);
    const fit = openingFit(o.title);
    if (fit < 0) continue; // senior-only or non-engineering: not a door worth knocking on
    map.get(k).push({ ...o, fit, fde: FDE.test(o.title), preferred: PREFERRED.test(o.location || '') });
  }
  for (const [k, list] of map) {
    if (!list.length) map.delete(k);
    else list.sort((a, b) => (b.fit - a.fit) || (b.preferred - a.preferred));
  }
  return map;
}

/** How useful a contact's title is for a warm path into an FDE team. @param {string} title */
export function titleScore(title) {
  const t = String(title || '').toLowerCase();
  if (FDE.test(t)) return 5;
  if (/recruit|talent|sourc/.test(t)) return 4;
  if (/(engineering|eng) manager|head of|director|vp|lead/.test(t)) return 4;
  if (/engineer|developer|solutions|architect/.test(t)) return 3;
  return 1;
}

/** People contacted in the last 7 days, and everyone ever queued. @param {{date:string,linkedin?:string,name:string,company:string}[]} log @param {Date} today */
export function history(log, today) {
  const weekAgo = new Date(today.getTime() - 7 * 864e5).toISOString().slice(0, 10);
  const day = today.toISOString().slice(0, 10);
  const contacted = new Set(log.map((r) => r.linkedin || `${key(r.name)}::${key(r.company)}`));
  return {
    contacted,
    sentThisWeek: log.filter((r) => r.date >= weekAgo && r.date <= day).length,
    sentToday: log.filter((r) => r.date === day).length,
  };
}

/**
 * Build today's queue.
 * @param {object} input
 * @param {{name:string,linkedin?:string,company:string,title?:string,via?:string,note?:string}[]} input.seeds  people you named
 * @param {{company:string,connections:{name:string,title?:string,linkedin?:string}[]}[]} input.joined  linkedin-join targets
 * @param {{company:string,title:string,url:string,location?:string}[]} input.openings
 * @param {{date:string,linkedin?:string,name:string,company:string}[]} input.log
 * @param {Date} input.today
 */
export function buildQueue({ seeds = [], joined = [], contacts = [], openings = [], log = [], today }) {
  const byCompany = openingsByCompany(openings);
  const h = history(log, today);
  const room = Math.max(0, Math.min(DAILY_CAP - h.sentToday, WEEKLY_CAP - h.sentThisWeek));
  const id = (p) => p.linkedin || p.email || `${key(p.name)}::${key(p.company)}`;

  const candidates = [];
  for (const s of seeds) {
    const opening = byCompany.get(key(s.company))?.[0] || null;
    candidates.push({
      ...s,
      source: 'seed',
      // A named mutual means the ask goes to the mutual, not to the target. A seed who is
      // already a 1st-degree connection is a connector: ask them who they know at target companies.
      kind: s.via ? 'intro_request' : s.degree === '1st' ? 'network_ask' : 'connect_note',
      opening,
      score: 100 + titleScore(s.title || ''),
    });
  }
  for (const t of joined) {
    const list = byCompany.get(key(t.company));
    if (!list?.length) continue; // a connection only matters where there is an opening
    for (const c of t.connections) {
      candidates.push({
        name: c.name, linkedin: c.linkedin, title: c.title || '', company: t.company,
        source: 'connection',
        kind: 'referral_ask', // already 1st-degree: a message, not an invite
        opening: list[0],
        score: titleScore(c.title || '') * 10 + list[0].fit * 2 + (list[0].preferred ? 3 : 0),
      });
    }
  }

  // Referral contacts and recruiters you collected. They only count where there is an opening.
  for (const c of contacts) {
    if (!c.email && (!c.name || c.name.startsWith('('))) continue; // placeholder row with nobody to contact
    const list = byCompany.get(key(c.company)) || byCompany.get(key(c.alias || ''));
    if (!list?.length) continue;
    const isRecruiter = c.kind === 'recruiter';
    candidates.push({
      name: c.name || '', email: c.email || '', linkedin: c.linkedin || '', title: isRecruiter ? 'Recruiter' : '',
      company: c.company, note: c.note || '', source: c.source || 'contact',
      kind: isRecruiter ? (c.email ? 'recruiter_email' : 'connect_note') : 'referral_ask',
      opening: list[0],
      // A named referral beats a recruiter; an FDE opening and a preferred location add weight.
      score: (isRecruiter ? 40 : 60) + list[0].fit * 2 + (list[0].preferred ? 3 : 0) + (c.name ? 0 : -20),
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const perCompany = new Map();
  const seen = new Set();
  const queue = [];
  for (const c of candidates) {
    if (queue.length >= room) break;
    const pid = id(c);
    if (h.contacted.has(pid) || seen.has(pid)) continue;
    const ck = key(c.company);
    if ((perCompany.get(ck) || 0) >= PER_COMPANY_CAP) continue;
    perCompany.set(ck, (perCompany.get(ck) || 0) + 1);
    seen.add(pid);
    queue.push({ ...c, draft: '' });
  }
  return { queue, room, sentThisWeek: h.sentThisWeek };
}

const GENERIC = [/i came across your profile/i, /i('d| would) love to connect/i, /expand my network/i, /\[[^\]]+\]/, /\{[^}]+\}/, /lorem/i];

/**
 * Problems with a drafted note; empty means it can be sent.
 * @param {{kind:string,name:string,company:string,draft:string,via?:string}} item
 */
export function checkDraft(item) {
  const problems = [];
  const d = String(item.draft || '').trim();
  if (!d) return ['no draft yet'];
  if (item.kind === 'connect_note' && d.length > NOTE_LIMIT) problems.push(`${d.length} chars, over the ${NOTE_LIMIT}-char note limit`);
  for (const re of GENERIC) if (re.test(d)) problems.push(`generic or template text: ${re}`);
  const addressee = item.kind === 'intro_request' ? item.via : item.name;
  // An address-only recruiter has no name to check against.
  // First name, or a nickname given in parentheses: "Jordan (Jo) Rivera" may be addressed as Jo.
  const nameStr = String(addressee || '');
  const first = nameStr.split(/\s+/)[0];
  const nick = (nameStr.match(/\(([^)]+)\)/) || [])[1];
  const lower = d.toLowerCase();
  if (first && !lower.includes(first.toLowerCase()) && !(nick && lower.includes(nick.toLowerCase()))) problems.push(`doesn't address ${first} by name`);
  if (!d.toLowerCase().includes(String(item.company).toLowerCase().split(/\s+/)[0])) problems.push(`doesn't mention ${item.company}`);
  return problems;
}
