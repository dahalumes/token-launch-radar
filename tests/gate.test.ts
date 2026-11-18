import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkBoardFile, checkCoverage, checkFarmSteps, checkSorted, imageSize, networkIssue } from '../lib/gate.ts';
import { boardJson, buildRadar } from '../lib/model.ts';
import { REPO, syntheticSnapshot } from './fixture.ts';

const snap = syntheticSnapshot();
const text = boardJson(buildRadar(snap));
const rows = (JSON.parse(text) as { rows: { slug: string; rank: number; implied_value_usd: number; farm_steps: string[] }[] }).rows;
const withRows = (rs: unknown[]): string => JSON.stringify({ rows: rs });

test('a generated board passes board_file, sorted_by_value, coverage and farm_steps', () => {
  assert.equal(checkBoardFile(text, Buffer.byteLength(text), snap).pass, true);
  assert.equal(checkSorted(rows).pass, true);
  assert.equal(checkCoverage(rows, snap).pass, true);
  assert.equal(checkFarmSteps(rows).pass, true);
});

test('board_file accepts a bare array too', () => {
  const t = JSON.stringify(rows);
  assert.equal(checkBoardFile(t, Buffer.byteLength(t), snap).pass, true);
});

test('board_file refuses invented slugs, duplicates, bad values, too few rows and flat boards', () => {
  const check = (rs: unknown[]): boolean => checkBoardFile(withRows(rs), 0, snap).pass;
  assert.equal(check([...rows.slice(1), { ...rows[0]!, slug: 'not-a-protocol' }]), false);
  assert.equal(check([...rows, rows[0]]), false);
  assert.equal(check([{ ...rows[0]!, implied_value_usd: 1.5 }, ...rows.slice(1)]), false);
  assert.equal(check([{ ...rows[0]!, implied_value_usd: 0 }, ...rows.slice(1)]), false);
  assert.equal(check([{ ...rows[0]!, implied_value_usd: 1e15 }, ...rows.slice(1)]), false);
  assert.equal(check([{ ...rows[0]!, name: '' }, ...rows.slice(1)]), false);
  assert.equal(check(rows.slice(0, 99)), false);
  assert.equal(check(rows.map((r) => ({ ...r, implied_value_usd: 5 }))), false);
  assert.equal(checkBoardFile('not json', 8, snap).pass, false);
});

test('sorted_by_value refuses gaps in ranks and values that rise with rank', () => {
  assert.equal(checkSorted(rows.map((r) => ({ ...r, rank: r.rank + 1 }))).pass, false);
  const swapped = rows.map((r) => ({ ...r }));
  swapped[0]!.rank = 2;
  swapped[1]!.rank = 1;
  assert.equal(checkSorted(swapped).pass, rows[0]!.implied_value_usd === rows[1]!.implied_value_usd);
});

test('coverage refuses a board missing a watchlist slug', () => {
  const drop = new Set([snap.watchlist[0]]);
  assert.equal(checkCoverage(rows.filter((r) => !drop.has(r.slug)), snap).pass, false);
});

test('farm_steps refuses too few, too many, too short and too long steps', () => {
  const r0 = rows[0]!;
  const ok = 'x'.repeat(40);
  assert.equal(checkFarmSteps([{ ...r0, farm_steps: [ok, ok] }]).pass, false);
  assert.equal(checkFarmSteps([{ ...r0, farm_steps: Array(13).fill(ok) }]).pass, false);
  assert.equal(checkFarmSteps([{ ...r0, farm_steps: [ok, ok, '   short step        '] }]).pass, false);
  assert.equal(checkFarmSteps([{ ...r0, farm_steps: [ok, ok, 'y'.repeat(601)] }]).pass, false);
  assert.equal(checkFarmSteps([{ ...r0, farm_steps: [ok, ok, ok] }]).pass, true);
});

test('networkIssue flags addresses where the scorer refuses them and allows them in text', () => {
  assert.notEqual(networkIssue('index.html', '<link href="https://cdn.example/x.css">'), null);
  assert.notEqual(networkIssue('index.html', '<a href=http://x.y>z</a>'), null);
  assert.notEqual(networkIssue('index.html', '<style>@import "https://x/y.css";</style>'), null);
  assert.notEqual(networkIssue('index.html', '<script type="module">import x from "https://x/y.js"</script>'), null);
  assert.notEqual(networkIssue('app.css', 'body{background:url(https://x/y.png)}'), null);
  assert.notEqual(networkIssue('app.js', 'import("https://x/y.js")'), null);
  assert.notEqual(networkIssue('app.js', "export * from 'http://x/y.js'"), null);
  assert.equal(networkIssue('index.html', '<p>Source: https://api.llama.fi/protocols</p><!-- https://x -->'), null);
  assert.equal(networkIssue('app.js', "var s = 'DefiLlama https://api.llama.fi/protocols';"), null);
});

test('the shipped dashboard names no network address', () => {
  for (const f of ['index.html', 'app.css', 'app.js']) assert.equal(networkIssue(f, readFileSync(join(REPO, 'dashboard', f), 'utf8')), null, f);
});

test('imageSize reads PNG and JPEG dimensions and refuses cut-short files', () => {
  const png = readFileSync(join(REPO, 'screenshots', '1-board.png'));
  assert.deepEqual(imageSize(png), { type: 'png', width: 1440, height: 900 });
  assert.equal(imageSize(png.subarray(0, png.length - 12)), null);
  // A minimal JPEG: SOI, SOF0 of 1000x800, EOI.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x03, 0xe8, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  assert.deepEqual(imageSize(jpeg), { type: 'jpeg', width: 1000, height: 800 });
  assert.equal(imageSize(Buffer.from('GIF89a')), null);
});
