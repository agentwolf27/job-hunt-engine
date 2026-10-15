// Read-only view of career-ops' tracker. Writes go through set-status.mjs and
// merge-tracker.mjs only; nothing here edits the file.
import { readFileSync, existsSync } from 'node:fs';

export function parseTracker(markdown) {
  const rows = [];
  let cols = null;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!cols) {
      cols = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const get = (name) => cells[cols.indexOf(name)] ?? '';
    const num = Number(get('#'));
    if (!Number.isInteger(num)) continue;
    const report = /\[(\d+)\]\(([^)]+)\)/.exec(get('report'));
    rows.push({
      row: num,
      date: get('date'),
      company: get('company'),
      role: get('role'),
      score: get('score'),
      status: get('status'),
      has_pdf: get('pdf').includes('✅'),
      report: report ? report[2] : '',
      url: get('url'),
      notes: get('notes'),
    });
  }
  return rows;
}

export function readTracker(path) {
  if (!existsSync(path)) throw new Error(`tracker not found: ${path}`);
  return parseTracker(readFileSync(path, 'utf8'));
}
