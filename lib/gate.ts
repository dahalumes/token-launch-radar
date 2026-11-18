// A local re-statement of the competition's seven gate rows (RULES.txt, "The gate"), written from the
// published rules so a run can refuse its own output before the sealed scorer does. It is our reading of
// the rules, not the scorer: passing it is necessary, not proof.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from './snapshot.ts';

export const LIMITS = {
  rows_min: 100,
  rows_max: 4000,
  board_max_bytes: 8 * 1024 * 1024,
  value_max: 100_000_000_000_000,
  steps_min: 3,
  steps_max: 12,
  step_min_chars: 20,
  step_max_chars: 600,
  dash_max_files: 400,
  dash_max_bytes: 4 * 1024 * 1024,
  shots_min: 3,
  shots_max: 4,
  shot_max_bytes: 512 * 1024,
  shot_long_max: 1440,
  shot_short_min: 800,
  dossier_max_bytes: 1.5 * 1024 * 1024,
  slug_max: 128,
} as const;

export const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The dossier exactly as the scorer rebuilds it: only text_max_bytes shapes the bytes, the rest only refuse. */
export const DOSSIER_CAPS = {
  text_max_bytes: 65_536,
  screenshots: { max: LIMITS.shots_max, max_bytes: LIMITS.shot_max_bytes },
  dashboard: { max_files: LIMITS.dash_max_files, max_bytes: LIMITS.dash_max_bytes },
};

export interface GateRow {
  check: string;
  pass: boolean;
  detail: string;
}

const ok = (check: string, detail = 'ok'): GateRow => ({ check, pass: true, detail });
const bad = (check: string, detail: string): GateRow => ({ check, pass: false, detail });

// ---------------------------------------------------------------- board rows

/** Rows from board.json text: an object's `rows`, or a bare array. null when neither. */
export function boardRows(text: string): unknown[] | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && v !== null && Array.isArray((v as { rows?: unknown }).rows)) return (v as { rows: unknown[] }).rows;
  return null;
}

const isWhole = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x);

export function checkBoardFile(text: string, bytes: number, snap: Snapshot): GateRow {
  const C = 'board_file';
  if (bytes > LIMITS.board_max_bytes) return bad(C, `board.json is ${bytes} bytes, over ${LIMITS.board_max_bytes}`);
  const rows = boardRows(text);
  if (rows === null) return bad(C, 'board.json is not a JSON object with a rows array, nor a bare array');
  if (rows.length < LIMITS.rows_min || rows.length > LIMITS.rows_max) return bad(C, `${rows.length} rows; the board holds ${LIMITS.rows_min} to ${LIMITS.rows_max}`);
  const known = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const invented: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown> | null;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return bad(C, `row ${i} is not an object`);
    const slug = r.slug;
    if (typeof slug !== 'string' || slug.length < 1 || slug.length > LIMITS.slug_max || /\s/.test(slug)) return bad(C, `row ${i}: slug must be 1-${LIMITS.slug_max} characters with no whitespace`);
    if (seen.has(slug)) return bad(C, `slug ${slug} appears more than once`);
    seen.add(slug);
    if (!known.has(slug)) invented.push(slug);
    if (typeof r.name !== 'string' || r.name.length === 0) return bad(C, `row ${slug}: name must be a non-empty string`);
    if (!isWhole(r.rank) || r.rank < 1) return bad(C, `row ${slug}: rank must be a positive whole number`);
    const v = r.implied_value_usd;
    if (!isWhole(v) || v < 1 || v > LIMITS.value_max) return bad(C, `row ${slug}: implied_value_usd must be a whole number from 1 to ${LIMITS.value_max}`);
    if (!Array.isArray(r.farm_steps)) return bad(C, `row ${slug}: farm_steps must be an array`);
  }
  if (invented.length > 0) return bad(C, `slugs the snapshot does not list: ${invented.slice(0, 5).join(', ')}`);
  const values = new Set(rows.map((r) => (r as { implied_value_usd: number }).implied_value_usd));
  if (rows.length >= 2 && values.size === 1) return bad(C, 'every row has the same implied value: that ranks nothing');
  return ok(C, `${rows.length} rows`);
}

export function checkSorted(rows: readonly { rank: number; implied_value_usd: number }[]): GateRow {
  const C = 'sorted_by_value';
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return bad(C, `ranks are not exactly 1..${rows.length}: expected ${i + 1}, found ${byRank[i]!.rank}`);
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return bad(C, `rank ${i + 1} is worth more than rank ${i}`);
  }
  if (rows.length >= 2 && new Set(rows.map((r) => r.implied_value_usd)).size === 1) return bad(C, 'every row has the same implied value');
  return ok(C);
}

export function checkCoverage(rows: readonly { slug: string }[], snap: Snapshot): GateRow {
  const C = 'coverage';
  const have = new Set(rows.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !have.has(s));
  return missing.length === 0 ? ok(C, `all ${snap.watchlist.length} watchlist slugs`) : bad(C, `missing ${missing.length}: ${missing.slice(0, 5).join(', ')}`);
}

export function checkFarmSteps(rows: readonly { slug: string; farm_steps: unknown }[]): GateRow {
  const C = 'farm_steps';
  for (const r of rows) {
    const s = r.farm_steps;
    if (!Array.isArray(s) || s.length < LIMITS.steps_min || s.length > LIMITS.steps_max) return bad(C, `${r.slug}: ${LIMITS.steps_min} to ${LIMITS.steps_max} steps`);
    for (const step of s) {
      if (typeof step !== 'string') return bad(C, `${r.slug}: a step is not a string`);
      const n = step.trim().length;
      if (n < LIMITS.step_min_chars || n > LIMITS.step_max_chars) return bad(C, `${r.slug}: a step of ${n} characters (${LIMITS.step_min_chars}-${LIMITS.step_max_chars})`);
    }
  }
  return ok(C);
}

// ---------------------------------------------------------------- dashboard files

/** Network addresses the page must not name: in HTML attribute values, <style> bodies, CSS, JS module specifiers. */
const URL = /https?:\/\//i;
const HTML_ATTR = /\s[\w:-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
const STYLE_BODY = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_BODY = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const JS_SPECIFIERS = [
  /\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?["'`]([^"'`]+)["'`]/g,
  /\bexport\s*[\w*{}\s,$]*\s*from\s*["'`]([^"'`]+)["'`]/g,
  /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
];

function jsNamesUrl(src: string): boolean {
  for (const re of JS_SPECIFIERS) for (const m of src.matchAll(re)) if (URL.test(m[1]!)) return true;
  return false;
}

/** Why a dashboard file names a network address the scorer refuses, or null. */
export function networkIssue(path: string, text: string): string | null {
  if (path.endsWith('.css')) return URL.test(text) ? 'a CSS file names an http(s) address' : null;
  if (path.endsWith('.js') || path.endsWith('.mjs')) return jsNamesUrl(text) ? 'a JavaScript import names an http(s) address' : null;
  if (path.endsWith('.html')) {
    const noComments = text.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of noComments.match(/<[a-zA-Z][^>]*>/g) ?? []) for (const m of tag.matchAll(HTML_ATTR)) if (URL.test(m[1]!)) return 'an HTML attribute names an http(s) address';
    for (const m of noComments.matchAll(STYLE_BODY)) if (URL.test(m[1]!)) return 'a <style> body names an http(s) address';
    for (const m of noComments.matchAll(SCRIPT_BODY)) if (jsNamesUrl(m[1]!)) return 'an inline script import names an http(s) address';
  }
  return null;
}

export function checkDashboard(dir: string): GateRow {
  const C = 'dashboard_files';
  const files: { path: string; size: number }[] = [];
  const walk = (rel: string): string | null => {
    for (const e of readdirSync(rel === '' ? dir : join(dir, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) return `${p} is a dot-directory`;
        const sub = walk(p);
        if (sub !== null) return sub;
      } else if (e.isFile()) {
        if (!PLAIN_NAME.test(e.name)) return `${p}: name is not letters, digits and ._-`;
        files.push({ path: p, size: lstatSync(join(dir, p)).size });
      } else return `${p} is not a regular file`;
    }
    return null;
  };
  try {
    if (!lstatSync(dir).isDirectory()) return bad(C, 'dashboard is not a directory');
  } catch {
    return bad(C, 'no dashboard/ directory');
  }
  const why = walk('');
  if (why !== null) return bad(C, why);
  if (!files.some((f) => f.path === 'index.html')) return bad(C, 'no index.html');
  if (!files.some((f) => f.path.endsWith('.css'))) return bad(C, 'no .css file');
  if (!files.some((f) => f.path.endsWith('.js'))) return bad(C, 'no .js file');
  if (files.length > LIMITS.dash_max_files) return bad(C, `${files.length} files, over ${LIMITS.dash_max_files}`);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > LIMITS.dash_max_bytes) return bad(C, `${total} bytes, over ${LIMITS.dash_max_bytes}`);
  for (const f of files.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const issue = networkIssue(f.path, readFileSync(join(dir, f.path), 'utf8'));
    if (issue !== null) return bad(C, `${f.path}: ${issue}`);
  }
  return ok(C, `${files.length} files, ${total} bytes`);
}

// ---------------------------------------------------------------- screenshots

/** Width and height of a whole PNG or JPEG, or null when the bytes are neither (or are cut short). */
export function imageSize(b: Uint8Array): { type: 'png' | 'jpeg'; width: number; height: number } | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 33 && png.every((x, i) => b[i] === x)) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // A whole PNG ends with its IEND chunk.
    const tail = Buffer.from(b.subarray(b.length - 8, b.length - 4)).toString('latin1');
    if (tail !== 'IEND') return null;
    return { type: 'png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { type: 'jpeg', height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
      i += 2 + len;
    }
  }
  return null;
}

export function checkScreenshots(dir: string): GateRow {
  const C = 'screenshots';
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  } catch {
    return bad(C, 'no screenshots/ directory');
  }
  if (names.length < LIMITS.shots_min || names.length > LIMITS.shots_max) return bad(C, `${names.length} images; hand in ${LIMITS.shots_min} to ${LIMITS.shots_max}`);
  for (const n of names) {
    if (!PLAIN_NAME.test(n)) return bad(C, `${n}: name is not letters, digits and ._-`);
    const st = lstatSync(join(dir, n));
    if (!st.isFile()) return bad(C, `${n} is not a regular file`);
    if (st.size > LIMITS.shot_max_bytes) return bad(C, `${n} is ${st.size} bytes, over ${LIMITS.shot_max_bytes}`);
    const size = imageSize(readFileSync(join(dir, n)));
    if (size === null) return bad(C, `${n} is not a whole PNG or JPEG`);
    const long = Math.max(size.width, size.height);
    const short = Math.min(size.width, size.height);
    if (long > LIMITS.shot_long_max || short < LIMITS.shot_short_min) return bad(C, `${n} is ${size.width}x${size.height}: long side at most ${LIMITS.shot_long_max}, short side at least ${LIMITS.shot_short_min}`);
  }
  return ok(C, `${names.length} images`);
}

// ---------------------------------------------------------------- the whole gate

/**
 * All seven rows over an output directory. `dossierFor` rebuilds the dossier (buildDossier from the
 * vendored library) so the dossier_matches row compares bytes as the scorer does.
 */
export function runGate(out: string, snap: Snapshot, dossierFor: (dir: string) => Uint8Array): GateRow[] {
  const result: GateRow[] = [checkDashboard(join(out, 'dashboard'))];
  let rows: { slug: string; rank: number; implied_value_usd: number; farm_steps: unknown }[] = [];
  try {
    const buf = readFileSync(join(out, 'board.json'));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    const row = checkBoardFile(text, buf.length, snap);
    result.push(row);
    if (row.pass) rows = boardRows(text) as typeof rows;
  } catch {
    result.push(bad('board_file', 'board.json is missing or not UTF-8'));
  }
  const noBoard = (c: string): GateRow => bad(c, 'no valid board to check');
  result.push(rows.length > 0 ? checkSorted(rows) : noBoard('sorted_by_value'));
  result.push(rows.length > 0 ? checkCoverage(rows, snap) : noBoard('coverage'));
  result.push(rows.length > 0 ? checkFarmSteps(rows) : noBoard('farm_steps'));
  result.push(checkScreenshots(join(out, 'screenshots')));
  try {
    const written = readFileSync(join(out, 'dossier.json'));
    const rebuilt = Buffer.from(dossierFor(out));
    if (written.length > LIMITS.dossier_max_bytes) result.push(bad('dossier_matches', `dossier.json is ${written.length} bytes, over ${LIMITS.dossier_max_bytes}`));
    else result.push(written.equals(rebuilt) ? ok('dossier_matches', `${written.length} bytes`) : bad('dossier_matches', 'dossier.json differs from what buildDossier writes'));
  } catch (err) {
    result.push(bad('dossier_matches', `cannot rebuild the dossier: ${(err as Error).message}`));
  }
  return result;
}
