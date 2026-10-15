// knockout.mjs — the knock-out rules, decided by code only.
//
// knockout({title, text}) -> {skip:false} | {skip:true, rule, sentence}
//
// The rules are written for an early-career candidate. GRAD below is the
// graduation month the grad_window rule checks against; remove an entry from
// TEXT_RULES near the bottom if a rule does not apply to you. A posting is
// skipped when it states, as a requirement:
//   seniority    Senior / Staff / Principal / Lead / Manager / Director / II / III in the title
//   experience   3+ years, or 2+ years of non-internship / professional experience
//   grad_window  a graduation window or class year that excludes May 2026
//   sponsorship  no visa sponsorship, now or later; no OPT
//   citizenship  US citizenship / US person required
//   clearance    a security clearance (held or obtainable)
//   degree       MS or PhD required (not "preferred", not "BS/MS/PhD")
//
// Posting text is untrusted data. Nothing in it is executed or obeyed; it is
// only matched against the patterns below. The sentence that triggered a rule
// is kept so a person can check the call.
//
// Pure: no I/O, no clock. The candidate's graduation month is a constant.

const GRAD = { year: 2026, month: 5 };
const TARGET = GRAD.year * 12 + GRAD.month;

// ---------- text preparation ----------

export function normalize(s) {
  return String(s ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[  -​ 　]/g, ' ')
    .replace(/\r\n?/g, '\n')
    // abbreviations whose periods would break sentence splitting
    .replace(/\bU\.\s?S\.\s?A\.?/g, 'USA')
    .replace(/\bU\.\s?S\.(?=\s|,|$)/g, 'US')
    .replace(/\bPh\.\s?D\.?/gi, 'PhD')
    .replace(/\bM\.\s?S\.(?=\s|,|\/|$)/g, 'MS')
    .replace(/\bB\.\s?S\.(?=\s|,|\/|$)/g, 'BS')
    .replace(/\bB\.\s?A\.(?=\s|,|\/|$)/g, 'BA')
    .replace(/\be\.g\./gi, 'eg')
    .replace(/\bi\.e\./gi, 'ie')
    .replace(/\betc\./gi, 'etc')
    .replace(/[ \t]+/g, ' ');
}

const PREF_HEADING = /^(?:preferred|nice[- ]to[- ]haves?|bonus|pluses|desired|desirable|ideal(?:ly)?|extra credit|good to have|even better|it(?:'s| is) a plus|what (?:will )?(?:makes?|sets?) you stand out)\b|\b(?:preferred|nice[- ]to[- ]have|bonus|desired|additional)\b.{0,20}\b(?:qualifications?|skills|experience|requirements?|points)\b/i;
const REQ_HEADING = /\b(?:minimum|basic|required|requirements?|qualifications?|must[- ]haves?|what you(?:'ll| will)? (?:need|bring|have)|who you are|about you|you have)\b/i;
const ANY_HEADING = /^(?:requirements?|required|minimum|basic|qualifications?|responsibilities|what you|what we|who you|who we|about|benefits|perks|compensation|you will|you'll|you have|you are|the role|your|our|why|how|must|key|skills|experience|education|location|salary|pay|equal|eeo|additional|job|we offer|in this role|day to day|duties|overview|summary|description|preferred|nice|bonus)\b/i;

/** Split text into {sentence, preferred, required} units, tracking section headings. */
export function units(text) {
  const out = [];
  let preferred = false;
  let required = false;
  for (const rawLine of normalize(text).split('\n')) {
    const line = rawLine.replace(/^[\s>#*•·▪◦‣-]+(?=\S)/, '').replace(/^[*_]{1,3}|[*_]{1,3}(?=:?\s*$)/g, '').trim();
    if (!line) continue;
    const head = line.replace(/:\s*$/, '');
    const words = head.split(/\s+/).length;
    const looksHeading = words <= 8 && !/\d/.test(head) && !/[.!?;]$/.test(head) && !/:\s*\S/.test(line);
    if (looksHeading && (PREF_HEADING.test(head))) { preferred = true; required = false; continue; }
    if (looksHeading && (/:\s*$/.test(line) || (words <= 4 && ANY_HEADING.test(head)))) {
      preferred = false;
      required = REQ_HEADING.test(head);
      // a heading can still carry a rule ("US Citizenship Required:"), so fall through
    }
    for (const s of line.split(/(?<=[.!?;])\s+(?=[A-Z0-9("'\[])/)) {
      const sentence = s.trim();
      if (sentence) out.push({ sentence, preferred, required });
    }
  }
  return out;
}

// ---------- shared guards ----------

const PREF = /\b(?:prefer(?:s|red|ably|ence)?|nice[- ]to[- ]have|bonus|a plus|is a plus|as a plus|desired|desirable|ideally|optional|helpful|advantage(?:ous)?|not (?:be )?(?:required|needed|necessary|mandatory))\b/i;
const HARD = /\b(?:requir\w*|must|minimum|at least|mandatory|need(?:s|ed)? to)\b/i;
const NEG = /\bnot (?:be )?(?:required|needed|necessary|a requirement|mandatory)\b|\bno\b[^,;]{0,40}\b(?:required|needed|necessary|requirement)\b|\b(?:does not|doesn't|do not|don't|will not|won't) (?:require|need)\b|\bregardless of\b|\bwithout regard\b|\birrespective of\b/i;
const OTHER_SUBJECT = /\b(?:phd|doctorate|master'?s|degree|clearance|citizen\w*|certification)\b/i;

/** The comma/paren/"but"-delimited clause of `sentence` containing index `i`. */
function clauseAt(sentence, i) {
  const re = /[,;()]| but | however /gi;
  let start = 0;
  let end = sentence.length;
  let m;
  while ((m = re.exec(sentence))) {
    if (m.index < i) start = m.index + m[0].length;
    else { end = m.index; break; }
  }
  return sentence.slice(start, end);
}

/**
 * True when the requirement at index `i` is softened: negated in its own
 * clause, marked preferred in its own clause, or marked preferred elsewhere in
 * the sentence while its own clause has no hard word and the preferring clause
 * is not about a different subject ("5+ years of experience, PhD preferred").
 */
function softened(sentence, i) {
  const clause = clauseAt(sentence, i);
  if (NEG.test(clause)) return true;
  if (PREF.test(clause)) return true;
  if (HARD.test(clause)) return false;
  const p = sentence.search(PREF);
  if (p < 0) return false;
  const prefClause = clauseAt(sentence, p);
  if (prefClause !== clause && OTHER_SUBJECT.test(prefClause)) return false;
  return true;
}

// ---------- rules ----------

const SENIOR_TITLE = /\b(?:senior|sr\.?|staff|principal|lead|manager|director|distinguished|vp|vice president|head of)\b/i;
const LEVEL_TITLE = /\b(?:II|III|IV)\b|\bL[4-9]\b/; // case-sensitive
const LEVEL_TITLE_I = /\b(?:engineer|developer|scientist|analyst|sde|swe)[ -]?[2-9]\b/i;

function titleRule(title) {
  if (!title) return null;
  if (SENIOR_TITLE.test(title)) return 'seniority';
  if (LEVEL_TITLE.test(title) || LEVEL_TITLE_I.test(title)) return 'seniority';
  const years = [...title.matchAll(/\b(20[2-9]\d)\b/g)].map((m) => Number(m[1]));
  if (years.length && years.every((y) => y > GRAD.year)) return 'grad_window';
  if (/\bphd\b|\bdoctoral\b|\bpost[- ]?doc/i.test(title)) return 'degree';
  return null;
}

// --- sponsorship ---
const NO_SPONSOR = [
  // "will not provide immigration sponsorship", "does not sponsor", "unable to offer visa sponsorship",
  // "will not require employer sponsored work authorization", "not eligible for visa sponsorship"
  /(?:\bnot|n't|\bcannot|\bunable to|\bnever)\s+(?:[\w'-]+[ -]){0,6}?sponsor/i,
  // "sponsorship is not available", "sponsorship unavailable"
  /\bsponsor\w*\b[^,;.]{0,60}?\b(?:(?:is|are|will be)\s+)?(?:not|n't)\s+(?:be\s+)?(?:available|offered|provided|supported|possible|an option)\b/i,
  /\bsponsor\w*\b[^,;.]{0,30}?\bunavailable\b/i,
  // "no visa sponsorship", "no sponsorship"
  /\bno\s+(?:[\w-]+\s+){0,3}?sponsorship\b/i,
  // "without sponsorship now or in the future", "without the need for employer sponsorship"
  /\bwithout\s+(?:[\w'-]+\s+){0,6}?sponsor/i,
  // "Sponsorship: No"
  /\bsponsor\w*(?:\s+available)?\s*[:-]\s*no\b/i,
  // "permanent work authorization", "authorized to work ... on a permanent basis"
  /\b(?:permanent|unrestricted|indefinite)\s+(?:US\s+)?(?:work|employment)\s+authori[sz]ation\b/i,
  /\bauthori[sz]ed to work\b[^.;]{0,50}\b(?:permanent basis|permanently|indefinitely)\b/i,
];
// Case-sensitive on purpose: "OPT" the status, never "opt in".
const VISA_TOKEN = String.raw`(?:C2C|c2c|[Cc]orp[- ]?to[- ]?[Cc]orp|third[- ]part(?:y|ies)|3rd[- ]part(?:y|ies)|H-?1B|H1-?B|CPT|OPT|STEM|F-?1|EAD|TN|W2|1099|visas?|sponsorship|[Nn][Oo]|or|and|nor|on)`;
const NO_OPT = [
  // "no C2C / no OPT", "No OPT/CPT", "No H1B, OPT or CPT"
  new RegExp(String.raw`\b[Nn][Oo]\s+(?:${VISA_TOKEN}[\s/,&]+){0,6}?(?:OPT|CPT|H-?1B|H1-?B)\b`),
  /\b(?:OPT|CPT|H-?1B|H1-?B|F-?1)\b[^.;]{0,50}?(?:\bnot|n't|\bcannot)\s+(?:be\s+)?(?:accepted|considered|eligible|supported|sponsored|able)\b/,
  /(?:\bnot|n't|\bcannot|\bunable to)\s+(?:[\w'-]+\s+){0,5}?(?:OPT|CPT)\b/,
];

function sponsorshipRule(sentence) {
  if (/\?\s*$/.test(sentence)) return false; // an application question is not a policy
  return NO_SPONSOR.some((re) => re.test(sentence)) || NO_OPT.some((re) => re.test(sentence));
}

// --- citizenship / US person ---
const CITIZEN = /\b(?:US|USA|United States|American)\s+citizen(?:s|ship)?\b|\bcitizen(?:s|ship)? of the (?:US|USA|United States)\b|\bUS persons?\b|\bgreen card\b|\bpermanent residen\w+\b/i;
const CITIZEN_CUE = /\b(?:must|requir\w*|only|need(?:s|ed)? to be|eligib\w*|limited to|restricted|due to|because|ITAR|EAR|export[- ]control\w*|condition of|mandatory|have to be|open to)\b/i;
const WORK_AUTH_ALT = /\bor\b[^.]{0,60}\b(?:authorized to work|work authorization|work permit|visa|eligible to work|right to work)\b/i;

function citizenshipRule(sentence) {
  const m = CITIZEN.exec(sentence);
  if (!m) return false;
  if (!CITIZEN_CUE.test(sentence)) return false;
  if (WORK_AUTH_ALT.test(sentence)) return false;
  return !softened(sentence, m.index);
}

// --- clearance ---
const CLEARANCE = /\b(?<!customs |medical |trade |ground |height |credit |sales |tax )clearances?\b|\bTS\/?SCI\b|\btop[- ]secret\b|\bpolygraph\b/i;

function clearanceRule(sentence) {
  const m = CLEARANCE.exec(sentence);
  if (!m) return false;
  if (/\bno\s+(?:[\w/-]+\s+){0,3}?clearance\b/i.test(sentence)) return false;
  if (/\bwithout\s+(?:[\w/-]+\s+){0,3}?clearance\b/i.test(sentence)) return false;
  return !softened(sentence, m.index);
}

// --- graduation window ---
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const SEASONS = { spring: [1, 6], summer: [5, 9], fall: [8, 12], autumn: [8, 12], winter: [1, 12] };
const D = String.raw`(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(?:of\s+)?20\d\d|(?:spring|summer|fall|autumn|winter)\s+(?:of\s+)?20\d\d|20\d\d)`;
const DATE_RE = new RegExp(String.raw`\b(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(?:of\s+)?(20\d\d)|(spring|summer|fall|autumn|winter)\s+(?:of\s+)?(20\d\d)|(20\d\d))\b`, 'gi');
const WINDOW_RE = new RegExp(String.raw`\b(?:between|from)\s+(${D})\s*(?:and|&|to|through|thru|until|-)\s*(${D})\b|\b(${D})\s*(?:-|to|through|thru|until)\s*(${D})\b`, 'gi');
const GRAD_CTX = /graduat\w*|\bclass of\b|\bgrads?\b|\bdegree\b|\bmatriculat\w*|\bcomplet\w+ (?:your |their |a |an |the )?[\w' ]{0,30}(?:degree|program|studies)/i;
const NEAR_GRAD = new RegExp(String.raw`(?:graduat\w*|class of|degree|grads?\b|complet\w+)[^.;]{0,45}?${D}|${D}[^.;]{0,30}?(?:graduat\w*|\bgrads?\b|\bclass\b|degree)`, 'i');

const DATE_ONE = new RegExp(DATE_RE.source, 'i');

function span(text) {
  const m = DATE_ONE.exec(text);
  if (!m) return null;
  if (m[1]) { const k = Number(m[2]) * 12 + MONTHS[m[1].toLowerCase()]; return [k, k]; }
  if (m[3]) { const [a, b] = SEASONS[m[3].toLowerCase()]; return [Number(m[4]) * 12 + a, Number(m[4]) * 12 + b]; }
  return [Number(m[5]) * 12 + 1, Number(m[5]) * 12 + 12];
}

function gradWindowRule(sentence) {
  if (!GRAD_CTX.test(sentence)) return false;
  // 1. explicit windows: "between December 2026 and June 2027", "Dec 2026 - Jun 2027"
  const windows = [];
  WINDOW_RE.lastIndex = 0;
  let w;
  while ((w = WINDOW_RE.exec(sentence))) {
    const a = span(w[1] ?? w[3]);
    const b = span(w[2] ?? w[4]);
    if (a && b) windows.push([Math.min(a[0], b[0]), Math.max(a[1], b[1])]);
  }
  if (windows.length) return windows.every(([lo, hi]) => TARGET < lo || TARGET > hi);
  if (!NEAR_GRAD.test(sentence)) return false;
  // 2. one-sided bounds
  const after = new RegExp(String.raw`(?<!no )\b(?:after|on or after|no earlier than|not before)\s+(${D})`, 'i').exec(sentence);
  if (after) {
    const s = span(after[1]);
    if (s) return TARGET < s[0];
  }
  const before = new RegExp(String.raw`\b(?:by|before|no later than|prior to|on or before)\s+(${D})`, 'i').exec(sentence);
  if (before) {
    const s = span(before[1]);
    if (s) return TARGET > s[1];
  }
  // 3. a list of dates or a class year: skip only when every one is after May 2026
  const spans = [];
  DATE_RE.lastIndex = 0;
  let m;
  while ((m = DATE_RE.exec(sentence))) {
    const lead = sentence.slice(Math.max(0, m.index - 24), m.index);
    if (/\bstart(?:s|ing)?\b[\w ]{0,14}$/i.test(lead)) continue; // a start date is not a graduation date
    const s = span(m[0]);
    if (s) spans.push(s);
  }
  return spans.length > 0 && spans.every(([lo]) => lo > TARGET);
}

// --- years of experience ---
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };
const WORDNUM_RE = new RegExp(String.raw`\b(${Object.keys(WORDNUM).join('|')})\b(?=\s*(?:\(\d{1,2}\))?\s*(?:\+|plus|or more|to \w+|- ?\w+)?\s*-?\s*(?:years?|yrs?)\b)`, 'gi');
const YEARS_RE = /(?<![\d.$#/])(\d{1,2})(?:\s*\(\d{1,2}\))?\s*(?:\+|plus\b)?\s*(?:(?:-|to)\s*(\d{1,2})\s*\+?\s*)?(?:or more\s+)?-?\s*(?:years?|yrs?)\b(?!\s*[- ]?(?:old|of age|degree|college|university|program|vesting|cliff|anniversary|ago|warranty))/gi;
const EXP_CTX = /experienc\w*|\bexp\b|background|track record|professional|industry|hands[- ]on|\b(?:years?|yrs?)\s+(?:of|in|with|working|building|developing|writing|designing|shipping|as)\b/i;
const NOT_MIN = /(?:less than|fewer than|up to|no more than|under|within|maximum of|max\.?|at most|past|last|next|over the|for over|every|first)\s+(?:the\s+|a\s+)?$/i;
// "We have 10 years of experience building ..." describes the employer, not the applicant.
const COMPANY_SUBJECT = /\b(?:we|our|team|company|founders?)\b(?![^,;]*\b(?:requir|need|look|seek|want|expect|ask|prefer|hir)\w*)[^,;]*$/i;
const NON_INTERN = /non[- ]?intern\w*|professional|\bindustry\b|full[- ]time|post[- ]?(?:grad\w*|college|university|degree|bachelor\w*)|excluding intern\w*|not (?:including|counting) intern\w*|outside of (?:school|intern\w*)/i;

function experienceRule(sentence) {
  const s = sentence.replace(WORDNUM_RE, (w) => String(WORDNUM[w.toLowerCase()]));
  if (!EXP_CTX.test(s)) return false;
  YEARS_RE.lastIndex = 0;
  let m;
  while ((m = YEARS_RE.exec(s))) {
    const min = Number(m[1]);
    if (NOT_MIN.test(s.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (COMPANY_SUBJECT.test(s.slice(Math.max(0, m.index - 60), m.index))) continue;
    const own = clauseAt(s, m.index + m[0].length - 1);
    if (!EXP_CTX.test(own) || /\bvest\w*|\bcliff\b|\bwarranty\b|\blease\b/i.test(own)) continue; // the years must be about experience
    const need = min >= 3 || (min >= 2 && NON_INTERN.test(s));
    if (!need) continue;
    if (softened(s, m.index)) continue;
    return true;
  }
  return false;
}

// --- MS / PhD required ---
const ADVANCED = /\bMS\b(?!\s*(?:Office|SQL|Excel|Word|Teams|Azure|Access|Dynamics|365|Windows|Project|PowerPoint|Visio|Graph|Entra|Fabric))|\bM\.?Eng\b|\bMBA\b/g; // case-sensitive
const ADVANCED_I = /\bphd\b|\bdoctora(?:te|l)\b|\bmaster'?s\b|\bmaster (?:degree|of (?:science|engineering|arts))\b|\bmsc\b|\b(?:graduate|advanced|post[- ]?graduate)[- ]degrees?\b/gi;
const BACHELOR = /\bbachelor(?:'?s)?\b|\bundergraduate\b|\bundergrad\b|\b4[- ]year degree\b|\bcollege degree\b|\bB\.?Tech\b/i;
const BACHELOR_ABBR = /\bBS\b|\bBA\b|\bBSc\b|\bB\.?Eng\b|\bBE\b/; // case-sensitive
const DEGREE_CUE = /\b(?:requir\w*|must|minimum|degree|completed|pursuing|enrolled|earned|hold(?:s|ing)?|candidates?|graduat\w*)\b/i;
const EQUIV = /\bor equivalent\b|\bequivalent\b[^,.;]{0,25}\bexperience\b|\bor\b[^,.;]{0,12}\byears?\b/i;

function degreeRule(sentence, required) {
  if (BACHELOR.test(sentence) || BACHELOR_ABBR.test(sentence)) return false;
  if (EQUIV.test(sentence)) return false;
  const hits = [];
  for (const re of [ADVANCED, ADVANCED_I]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(sentence))) hits.push(m.index);
  }
  if (!hits.length) return false;
  const first = Math.min(...hits);
  const cued = DEGREE_CUE.test(sentence) || (required && first < 40);
  if (!cued) return false;
  return hits.some((i) => !softened(sentence, i));
}

// ---------- entry ----------

const TEXT_RULES = [
  ['sponsorship', (u) => sponsorshipRule(u.sentence)],
  ['citizenship', (u) => !u.preferred && citizenshipRule(u.sentence)],
  ['clearance', (u) => !u.preferred && clearanceRule(u.sentence)],
  ['grad_window', (u) => gradWindowRule(u.sentence)],
  ['experience', (u) => !u.preferred && experienceRule(u.sentence)],
  ['degree', (u) => !u.preferred && degreeRule(u.sentence, u.required)],
];

export const RULES = ['seniority', 'experience', 'grad_window', 'sponsorship', 'citizenship', 'clearance', 'degree'];

function clip(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 297)}...` : t;
}

export function knockout({ title = '', text = '' } = {}) {
  const t = normalize(title).replace(/\s+/g, ' ').trim();
  const tr = titleRule(t);
  if (tr) return { skip: true, rule: tr, sentence: clip(t) };
  const all = [{ sentence: t, preferred: false, required: false }, ...units(text)];
  for (const u of all) {
    if (!u.sentence) continue;
    for (const [rule, test] of TEXT_RULES) {
      if (test(u)) return { skip: true, rule, sentence: clip(u.sentence) };
    }
  }
  return { skip: false };
}
