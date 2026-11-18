// Dashboard UI tests with no browser and no dependencies: static checks on the page source (accessibility,
// responsiveness, budget) and a smoke run of data.js + model.js + app.js against a minimal DOM stub, driving
// every route and reading what each view renders.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { REPO, realSnapshotPath, syntheticSnapshot } from './fixture.ts';

const DASH = join(REPO, 'dashboard');
const app = readFileSync(join(DASH, 'app.js'), 'utf8');
const css = readFileSync(join(DASH, 'app.css'), 'utf8');
const html = readFileSync(join(DASH, 'index.html'), 'utf8');

// ------------------------------------------------------------------ static checks

test('the dashboard source stays inside the dossier budget with a safety margin', () => {
  const total = readdirSync(DASH).reduce((n, f) => n + statSync(join(DASH, f)).size, 0);
  assert.ok(total <= 62_800, `dashboard source is ${total} bytes; keep it at most 62,800 (the dossier shows 65,536)`);
});

test('controls are keyboard reachable and labelled', () => {
  assert.match(app, /<th scope="col"[^']*' \+[^]*?<button data-key=/, 'sortable headers are buttons');
  assert.match(app, /aria-sort=/);
  assert.match(app, /<select data-f="' \+ f\[0\] \+ '" aria-label="' \+ f\[1\]/, 'every filter select is labelled');
  assert.match(app, /type="search" id="f-q" aria-label=/);
  assert.match(app, /aria-live="polite"/, 'the result count is announced');
  assert.match(app, /aria-current/, 'the active tab is marked');
  assert.match(app, /<caption class="sr">/, 'tables carry a caption');
  assert.match(app, /aria-label="Remove filter/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /class="skip"/, 'skip link');
  assert.match(html, /<main id="view" tabindex="-1">/, 'main can take focus after navigation');
  assert.match(css, /:focus-visible \{ outline: 2px solid/);
  assert.doesNotMatch(app + html, /\son[a-z]+="/, 'no inline event handlers');
});

test('the layout adapts to narrow screens', () => {
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /\.wrap \{ overflow-x: auto;/, 'wide tables scroll inside their frame');
  assert.match(css, /\.opt \{ display: none; \}/, 'secondary columns drop on narrow screens');
  assert.match(css, /\.cards, \.detail, \.grid2 \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
});

// ------------------------------------------------------------------ rendering smoke run

const work = mkdtempSync(join(tmpdir(), 'radar-ui-'));
after(() => rmSync(work, { recursive: true, force: true }));
const input = realSnapshotPath() ?? join(work, 'synthetic.json');
if (realSnapshotPath() === null) writeFileSync(input, JSON.stringify(syntheticSnapshot()));
const out = join(work, 'out');
const run = spawnSync(process.execPath, [join(REPO, 'main.ts'), '--input', input, '--output', out], { encoding: 'utf8' });

/** Load the page into a sandbox with a minimal DOM; returns a function rendering a hash to HTML. */
function page(): (hash: string) => string {
  const els = new Map<string, { innerHTML: string; textContent: string; addEventListener(): void; focus(): void; querySelectorAll(): never[] }>();
  const el = (id: string) => {
    if (!els.has(id)) els.set(id, { innerHTML: '', textContent: '', addEventListener() {}, focus() {}, querySelectorAll: () => [] });
    return els.get(id)!;
  };
  const listeners: Record<string, () => void> = {};
  const ctx: Record<string, unknown> = {
    document: { getElementById: el, querySelectorAll: () => [] },
    location: { hash: '' },
    addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn; },
    scrollTo() {},
  };
  ctx.window = ctx;
  createContext(ctx);
  for (const f of [join(out, 'data.js'), join(DASH, 'model.js'), join(DASH, 'app.js')]) runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
  return (hash) => {
    (ctx.location as { hash: string }).hash = hash;
    listeners.hashchange!();
    return el('view').innerHTML;
  };
}

test('every route renders: board, detail, filtered, method, already trading and both empty states', () => {
  assert.equal(run.status, 0, run.stderr);
  const render = page();
  const board = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')) as { rows: { slug: string; name: string; payoff_below_gas: boolean }[] };

  const home = render('#/');
  assert.match(home, /Top opportunities by implied value/);
  assert.equal((home.match(/<a class="card"/g) ?? []).length, 3);
  assert.equal((home.match(/<tr data-slug=/g) ?? []).length, board.rows.length);
  assert.match(home, /✓ Consistency check:<\/b> all \d+ of \d+ implied values and ranks/);
  assert.match(home, /not to say they are accurate/);
  assert.equal((home.match(/class="range"/g) ?? []).length, 3 + board.rows.length, 'a range bar on every card and row');
  assert.equal((home.match(/tag-low">below gas/g) ?? []).length, board.rows.filter((r) => r.payoff_below_gas).length);

  const top = board.rows[0]!;
  const detail = render(`#/p/${encodeURIComponent(top.slug)}`);
  assert.match(detail, /Model estimate · rank #1 of/);
  assert.match(detail, /Risks to weigh/);
  assert.match(detail, /Snapshot facts/);
  assert.match(detail, /<span class="ct"><span>Cost: /, 'cost and time chips under each step');
  assert.match(detail, /indicative range ±/);

  const filtered = render('#/?tier=early&sort=change_7d&dir=desc');
  assert.doesNotMatch(filtered, /Top opportunities/, 'cards give way to the filtered board');
  assert.match(filtered, /data-drop="tier"[^>]*>Tier: early ×/);
  assert.match(filtered, /aria-sort="descending"><button data-key="change_7d">/);

  const none = render('#/?cat=No%20Such%20Category');
  assert.match(none, /No protocol matches these filters/);
  assert.match(none, /data-reset>Clear all filters/);

  const missing = render('#/p/not-a-protocol');
  assert.match(missing, /No protocol “not-a-protocol” on this board/);
  assert.match(missing, /Back to the radar/);

  const method = render('#/method');
  assert.match(method, /How an implied value is built/);
  if (realSnapshotPath() !== null) {
    assert.match(method, /Held-out diagnostics/);
    assert.equal((method.match(/<div><b>/g) ?? []).length, 4, 'four diagnostic tiles');
  }

  assert.match(render('#/trading'), /Market cap \(fact\)/);
});

test('rendered text is escaped: a hostile protocol name cannot inject markup', () => {
  const s = syntheticSnapshot();
  s.protocols[0]!.name = '<img src=x onerror=alert(1)>';
  const evil = join(work, 'evil.json');
  writeFileSync(evil, JSON.stringify(s));
  const r = spawnSync(process.execPath, [join(REPO, 'main.ts'), '--input', evil, '--output', join(work, 'evil-out')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const data = readFileSync(join(work, 'evil-out', 'data.js'), 'utf8');
  const ctx: Record<string, unknown> = {};
  ctx.window = ctx;
  createContext(ctx);
  runInContext(data, ctx);
  const slug = s.protocols[0]!.slug;
  const onBoard = (ctx.RADAR as { board: { slug: string }[] }).board.some((b) => b.slug === slug);
  if (!onBoard) return; // the fixture's first protocol may trade a token; then nothing renders it
  const viewEl = { innerHTML: '' };
  const listeners: Record<string, () => void> = {};
  Object.assign(ctx, {
    document: { getElementById: (id: string) => (id === 'view' ? Object.assign(viewEl, { focus() {}, querySelectorAll: () => [] }) : { innerHTML: '', textContent: '', addEventListener() {} }), querySelectorAll: () => [] },
    location: { hash: `#/p/${slug}` },
    addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn; },
    scrollTo() {},
  });
  runInContext(readFileSync(join(DASH, 'model.js'), 'utf8'), ctx);
  runInContext(app, ctx);
  assert.doesNotMatch(viewEl.innerHTML, /<img src=x/);
  assert.match(viewEl.innerHTML, /&#60;img src=x/);
});
