// Pure logic for the morning page. No DOM, no Node APIs: this file is unit-tested
// under node:test and inlined into the published page (build.mjs strips the
// `export` keywords), so the browser and the tests run the same code.

export const LIFECYCLE = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer'];
export const CLOSED = ['Rejected', 'Discarded', 'SKIP'];
export const PAGE_STATUSES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded'];
export const LIST_CAP = 60;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function safeUrl(u) {
  return /^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : '';
}

function dayNumber(ms) {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

function clock(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function longDate(ms) {
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

// The page states its own age: the snapshot only knows when it was built, so
// the comparison with "now" has to happen in whoever is looking at it.
export function ageBanner(snapshot, nowMs) {
  const built = Date.parse(snapshot.built_at);
  if (!Number.isFinite(built)) return { kind: 'failed', text: 'This page has no build time, so its age is unknown.' };
  const days = dayNumber(nowMs) - dayNumber(built);
  const run = snapshot.run || { status: 'none' };
  if (days >= 1) {
    const ago = days === 1 ? 'yesterday' : `${days} days ago`;
    return {
      kind: 'stale',
      text: `Last built ${ago} (${longDate(built)}, ${clock(built)}).`,
      detail: 'Nothing below is newer than that. The page is rebuilt when Claude runs on the Mac.',
    };
  }
  if (run.status === 'failed') {
    return {
      kind: 'failed',
      text: `This morning's run failed: ${run.error || 'no reason recorded'}.`,
      detail: `Built today at ${clock(built)} from what was already known.`,
    };
  }
  if (run.status === 'ok') return { kind: 'ok', text: `Built today at ${clock(built)}.` };
  return { kind: 'info', text: `Built today at ${clock(built)} from the tracker.`, detail: 'No morning run has finished yet today.' };
}

export function statusDocId(row) {
  return `status-row-${row}`;
}

export function reviewDocId(key) {
  return `review-${String(key).replace(/[^A-Za-z0-9_.~:@+-]/g, '_')}`;
}

export function makeStatusChange(row, to, nowIso) {
  return {
    id: statusDocId(row.row),
    doc: { kind: 'status', row: row.row, company: row.company, role: row.role, from: row.status, to, at: nowIso, state: 'queued' },
  };
}

export function makeReview(resume, decision, note, nowIso) {
  return {
    id: reviewDocId(resume.key),
    doc: { kind: 'review', key: resume.key, spec_hash: resume.spec_hash, decision, note: String(note || '').slice(0, 500), at: nowIso, state: 'queued' },
  };
}

// The page database, reduced to what the page does with it: one document per
// id, so a second tap on the same control replaces the first and Undo deletes.
export function applyOp(queue, op) {
  const next = { ...queue };
  if (op.type === 'delete') delete next[op.id];
  else next[op.id] = op.doc;
  return next;
}

function scoreNumber(score) {
  const m = /^([\d.]+)\s*\/\s*5/.exec(String(score || ''));
  return m ? Number(m[1]) : -1;
}

function reviewState(resume, queue) {
  if (!resume || !resume.spec_hash) return { state: 'none' };
  const q = queue[reviewDocId(resume.key)];
  if (q && q.kind === 'review') {
    if (q.spec_hash !== resume.spec_hash) return { state: 'stale', note: 'This resume changed after your review, so the review no longer counts.' };
    if (q.state === 'refused') return { state: 'refused', decision: q.decision, note: q.reason || 'refused' };
    return { state: 'queued', decision: q.decision, note: q.note || '' };
  }
  const r = resume.review;
  if (r && r.spec_hash === resume.spec_hash) return { state: 'saved', decision: r.decision, note: r.note || '' };
  return { state: 'none' };
}

export function viewModel(snapshot, queue, nowMs) {
  queue = queue || {};
  const cards = (snapshot.rows || []).map((row) => {
    const q = queue[statusDocId(row.row)];
    let status = row.status;
    let pending = null;
    let refusal = null;
    if (q && q.kind === 'status') {
      if (q.state === 'refused') refusal = { to: q.to, reason: q.reason || 'the tracker refused it' };
      else if (q.to !== row.status) {
        pending = { to: q.to, from: q.from };
        status = q.to;
      }
    }
    const review = reviewState(row.resume, queue);
    const approved = review.decision === 'approve' && (review.state === 'saved' || review.state === 'queued');
    const reviewable = !!(row.resume && row.resume.spec_hash);
    const needsReview = reviewable && row.status === 'Evaluated' && !pending && !approved;
    return { ...row, status, trackerStatus: row.status, pending, refusal, review, approved, reviewable, needsReview, isNew: !!(row.fit && row.fit.new) };
  });

  const todo = cards.filter((c) => c.needsReview || (c.isNew && c.status === 'Evaluated'));
  const todoRows = new Set(todo.map((c) => c.row));
  const rest = cards.filter((c) => !todoRows.has(c.row));
  const active = rest.filter((c) => LIFECYCLE.indexOf(c.status) >= 1);
  active.sort((a, b) => LIFECYCLE.indexOf(b.status) - LIFECYCLE.indexOf(a.status) || String(b.date).localeCompare(String(a.date)));
  const toApply = rest.filter((c) => c.status === 'Evaluated');
  toApply.sort((a, b) => scoreNumber(b.score) - scoreNumber(a.score));
  const closed = rest.filter((c) => CLOSED.includes(c.status));

  const counts = {};
  for (const s of [...LIFECYCLE, ...CLOSED]) counts[s] = 0;
  for (const c of cards) counts[c.status] = (counts[c.status] || 0) + 1;

  const watch = snapshot.watchlist || [];
  const unchecked = watch.filter((w) => !w.ok);
  const run = snapshot.run || { status: 'none' };
  return {
    banner: ageBanner(snapshot, nowMs),
    run,
    counts,
    todo,
    active,
    toApply,
    closed,
    skipped: snapshot.skipped || [],
    passed: snapshot.passed || [],
    unfetched: snapshot.unfetched || [],
    watch,
    unchecked,
    audit: snapshot.audit || null,
    waiting: cards.filter((c) => c.pending).length + cards.filter((c) => c.review.state === 'queued').length,
  };
}

function statusPill(c) {
  if (c.pending) return `<span class="pill pending">${esc(c.pending.to)} · waiting for Mac</span>`;
  return `<span class="pill s-${esc(String(c.status).toLowerCase())}">${esc(c.status)}</span>`;
}

function statusControls(c, writable) {
  const dis = writable ? '' : ' disabled';
  if (c.pending) return `<button class="btn quiet" data-act="undo-status" data-row="${esc(c.row)}"${dis}>Undo</button>`;
  const opts = PAGE_STATUSES.filter((s) => s !== c.status)
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join('');
  const primary = c.status === 'Evaluated' ? `<button class="btn primary" data-act="status" data-row="${esc(c.row)}" data-to="Applied"${dis}>Applied</button>` : '';
  const skip = c.status === 'Evaluated' ? `<button class="btn" data-act="status" data-row="${esc(c.row)}" data-to="Discarded"${dis}>Skip</button>` : '';
  return `${primary}${skip}<label class="sel"><span class="vh">Change status of ${esc(c.company)}</span><select id="sel-${esc(c.row)}" data-act="status-select" data-row="${esc(c.row)}"${dis}><option value="">Change status…</option>${opts}</select></label>`;
}

function resumeBlock(c, ui, writable) {
  const r = c.resume;
  if (!r) return '';
  const dis = writable ? '' : ' disabled';
  const pdf = safeUrl(r.pdf_url) || (/^\/_blob\/[0-9a-f]+$/.test(r.pdf_url || '') ? r.pdf_url : '');
  const pdfLink = pdf ? `<a class="link" href="${esc(pdf)}" target="_blank" rel="noopener">Open the PDF</a>` : '<span class="muted">PDF is on the Mac only</span>';
  if (!r.sections) {
    return `<div class="resume"><div class="resume-head"><span class="label">Resume</span> ${esc(r.pdf_name || '')}${r.old_format ? ' <span class="muted">(older layout, not reviewed here)</span>' : ''} · ${pdfLink}</div></div>`;
  }
  const rv = c.review;
  let verdict = '';
  if (rv.state === 'queued') verdict = `<p class="notice wait">${rv.decision === 'approve' ? 'Approved' : 'Change requested'} · waiting for Mac${rv.note ? `: “${esc(rv.note)}”` : ''} <button class="btn quiet" data-act="undo-review" data-row="${esc(c.row)}"${dis}>Undo</button></p>`;
  else if (rv.state === 'saved') verdict = `<p class="notice ${rv.decision === 'approve' ? 'good' : 'wait'}">${rv.decision === 'approve' ? 'You approved this resume.' : `You asked for a change${rv.note ? `: “${esc(rv.note)}”` : '.'}`}</p>`;
  else if (rv.state === 'stale' || rv.state === 'refused') verdict = `<p class="notice bad">${rv.state === 'stale' ? esc(rv.note) : `Review not saved: ${esc(rv.note)}`} <button class="btn quiet" data-act="undo-review" data-row="${esc(c.row)}"${dis}>Dismiss</button></p>`;
  const canReview = rv.state === 'none' || rv.state === 'stale' || (rv.state === 'saved' && rv.decision !== 'approve');
  const noteOpen = ui.noteOpen && ui.noteOpen[c.row];
  const buttons = canReview
    ? `<div class="actions"><button class="btn primary" data-act="approve" data-row="${esc(c.row)}"${dis}>Approve resume</button><button class="btn" data-act="needs" data-row="${esc(c.row)}"${dis}>Needs change</button></div>${
        noteOpen
          ? `<div class="note"><label for="note-${esc(c.row)}">What should change?</label><input id="note-${esc(c.row)}" type="text" maxlength="500" value="${esc((ui.notes && ui.notes[c.row]) || '')}" placeholder="One line, for example: lead with the Jira pipeline"><button class="btn primary" data-act="send-note" data-row="${esc(c.row)}"${dis}>Send</button></div>`
          : ''
      }`
    : '';
  const sections = r.sections
    .filter((s) => (s.entries || []).some((e) => (e.bullets || []).length))
    .map(
      (s) =>
        `<div class="rsec"><h4>${esc(s.heading)}</h4>${s.entries
          .map((e) => `<div class="rentry"><p class="rtitle">${esc(e.title)}${e.dates ? ` <span class="muted">${esc(e.dates)}</span>` : ''}</p><ul>${(e.bullets || []).map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul></div>`)
          .join('')}</div>`,
    )
    .join('');
  const open = c.needsReview || (ui.open && ui.open[`resume-${c.row}`]);
  return `<div class="resume">${verdict}<details data-key="resume-${esc(c.row)}"${open ? ' open' : ''}><summary><span class="label">Resume</span> ${esc(r.pdf_name || r.key)} · read the bullets</summary>${sections}<p class="pdf">${pdfLink}</p></details>${buttons}</div>`;
}

// The page cannot start Claude. Once the resume is approved it says what to type.
function applyHint(c) {
  if (c.trackerStatus !== 'Evaluated' || c.pending || !c.reviewable || !c.approved) return '';
  return `<p class="notice good">Ready to apply. In Claude on the Mac, say: <b>apply to row ${esc(c.row)}</b>. It fills the form and stops before Submit.</p>`;
}

export function cardHTML(c, ui, writable) {
  const url = safeUrl(c.url);
  const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(c.role)}</a>` : esc(c.role);
  const refusal = c.refusal ? `<p class="notice bad">Not changed to ${esc(c.refusal.to)}: ${esc(c.refusal.reason)}. <button class="btn quiet" data-act="undo-status" data-row="${esc(c.row)}"${writable ? '' : ' disabled'}>Dismiss</button></p>` : '';
  const why = c.fit && c.fit.reason ? `<p class="why"><span class="label">Why it fits</span> ${esc(c.fit.reason)}</p>` : '';
  const notes = c.notes ? `<details class="notes" data-key="notes-${esc(c.row)}"${ui.open && ui.open[`notes-${c.row}`] ? ' open' : ''}><summary>Notes</summary><p>${esc(c.notes)}</p></details>` : '';
  const score = c.score && c.score !== 'N/A' ? `<span class="score">${esc(c.score)}</span>` : '';
  return `<article class="card${c.pending ? ' is-pending' : ''}" id="row-${esc(c.row)}"><header><div class="who"><p class="company">${esc(c.company)}${c.isNew ? ' <span class="pill new">New today</span>' : ''}</p><h3>${title}</h3></div><div class="state">${score}${statusPill(c)}</div></header>${refusal}${why}${resumeBlock(c, ui, writable)}${applyHint(c)}${notes}<footer class="actions">${statusControls(c, writable)}</footer></article>`;
}

function capped(items, render, what) {
  const shown = items.slice(0, LIST_CAP).map(render).join('');
  const more = items.length > LIST_CAP ? `<p class="muted more">${items.length - LIST_CAP} more ${what} not shown. The full list is in the run ledger on the Mac.</p>` : '';
  return shown + more;
}

function lineItem(p, extra) {
  const url = safeUrl(p.url);
  return `<li><span class="li-main">${esc(p.company)} · ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</span>${extra}</li>`;
}

function group(key, title, count, body, ui, openByDefault) {
  const open = ui.open && key in ui.open ? ui.open[key] : openByDefault;
  return `<details class="group" data-key="${esc(key)}"${open ? ' open' : ''}><summary><h2>${esc(title)}</h2><span class="count">${count}</span></summary>${body}</details>`;
}

export function renderHTML(vm, ui, writable) {
  ui = ui || {};
  const b = vm.banner;
  const out = [];
  out.push(`<div class="banner ${esc(b.kind)}" role="status"><p class="banner-text">${esc(b.text)}</p>${b.detail ? `<p class="banner-detail">${esc(b.detail)}</p>` : ''}</div>`);
  if (!writable) out.push('<p class="notice wait">Buttons are off in this view. Open the page signed in to claude.ai to change a status or review a resume.</p>');

  if (vm.unchecked.length || vm.unfetched.length) {
    const rows = vm.unchecked.map((w) => `<li><span class="li-main">${esc(w.company)}</span><span class="li-sub">search failed: ${esc(w.error || 'no reason recorded')}</span></li>`).join('');
    const posts = capped(vm.unfetched, (p) => lineItem(p, `<span class="li-sub">could not be read: ${esc(p.error || 'no reason recorded')}</span>`), 'postings');
    out.push(`<section class="alert"><h2>Not checked today</h2><p class="muted">These were not searched or could not be read, so a role here may have been missed.</p><ul class="lines">${rows}${posts}</ul></section>`);
  }

  if (vm.audit && !vm.audit.ok) {
    const items = vm.audit.problems.map((p) => `<li><span class="li-main">${esc(p)}</span></li>`).join('');
    out.push(`<section class="alert"><h2>The ${esc(vm.audit.date)} audit found problems</h2><p class="muted">The 7 AM check re-reads what this page published. Treat the items below as unverified until it passes.</p><ul class="lines">${items}</ul>${vm.audit.more ? `<p class="muted">${vm.audit.more} more in the audit file on the Mac.</p>` : ''}</section>`);
  } else if (vm.audit) out.push(`<p class="muted">The ${esc(vm.audit.date)} audit passed.</p>`);

  const c = vm.counts;
  const strip = [...LIFECYCLE, 'Rejected'].map((s) => `<div class="stat"><span class="n">${c[s] || 0}</span><span class="k">${esc(s)}</span></div>`).join('');
  out.push(`<section class="strip" aria-label="Applications by status">${strip}</section>`);
  if (vm.waiting) out.push(`<p class="notice wait">${vm.waiting} change${vm.waiting === 1 ? '' : 's'} waiting for the Mac. They are written into the tracker the next time Claude runs there.</p>`);

  const r = vm.run;
  const found = r.counts ? `${r.counts.found || 0} new posting${r.counts.found === 1 ? '' : 's'} found, ${vm.skipped.length} ruled out, ${vm.passed.length} read and passed over, ${r.counts.fits || 0} good fit${r.counts.fits === 1 ? '' : 's'}.` : '';
  const todoBody = vm.todo.length
    ? vm.todo.map((x) => cardHTML(x, ui, writable)).join('')
    : `<p class="empty">${r.status === 'ok' ? 'No new good fits this morning, and no resume is waiting for your review.' : 'No resume is waiting for your review.'}</p>`;
  out.push(`<section class="todo"><div class="sec-head"><h2>For you this morning</h2><span class="count">${vm.todo.length}</span></div>${found ? `<p class="muted">${esc(found)}</p>` : ''}${todoBody}</section>`);

  if (vm.active.length) out.push(group('active', 'In progress', vm.active.length, vm.active.map((x) => cardHTML(x, ui, writable)).join(''), ui, true));
  if (vm.toApply.length) out.push(group('toapply', 'Evaluated, not applied', vm.toApply.length, capped(vm.toApply, (x) => cardHTML(x, ui, writable), 'roles'), ui, false));
  if (vm.skipped.length)
    out.push(group('skipped', 'Ruled out today', vm.skipped.length, `<ul class="lines">${capped(vm.skipped, (p) => lineItem(p, `<span class="li-sub"><b>${esc(p.rule)}</b> “${esc(p.sentence)}”</span>`), 'postings')}</ul>`, ui, false));
  if (vm.passed.length)
    out.push(group('passed', 'Read and passed over', vm.passed.length, `<ul class="lines">${capped(vm.passed, (p) => lineItem(p, `<span class="li-sub">${esc(p.reason || '')}</span>`), 'postings')}</ul>`, ui, false));
  if (vm.closed.length) out.push(group('closed', 'Closed', vm.closed.length, capped(vm.closed, (x) => cardHTML(x, ui, writable), 'roles'), ui, false));
  if (vm.watch.length) {
    const rows = vm.watch
      .map((w) => `<li><span class="li-main">${esc(w.company)}</span><span class="li-sub ${w.ok ? '' : 'bad-text'}">${w.ok ? `checked ${esc(String(w.checked_at || '').slice(0, 10))} · ${esc(w.matched ?? 0)} matching of ${esc(w.total ?? '?')}` : `failed: ${esc(w.error || '')}`}</span></li>`)
      .join('');
    out.push(group('watch', 'Named companies', vm.watch.length, `<ul class="lines">${rows}</ul>`, ui, false));
  }
  return out.join('\n');
}
