// End to end: run main.ts as the grader does (a fresh process, an input file, an output directory) and
// check the files it must write, the gate over them, and that two runs write the same bytes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { DOSSIER_CAPS, runGate } from '../lib/gate.ts';
import { parseSnapshot } from '../lib/snapshot.ts';
import { buildDossier } from '../vendor/makefun-board.ts';
import { REPO, realSnapshotPath, syntheticSnapshot } from './fixture.ts';

const work = mkdtempSync(join(tmpdir(), 'radar-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

const synthetic = join(work, 'synthetic.json');
writeFileSync(synthetic, JSON.stringify(syntheticSnapshot()));

function run(input: string, out: string, cwd = REPO): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(REPO, 'main.ts'), '--input', input], {
    cwd,
    env: { ...process.env, MAKEFUN_OUTPUT_DIR: out },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every file under `dir`, relative path to bytes. */
function tree(dir: string): Map<string, Buffer> {
  const m = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else m.set(relative(dir, p), readFileSync(p));
    }
  };
  walk(dir);
  return m;
}

const REQUIRED = ['board.json', 'data.js', 'dossier.json', 'dashboard/index.html', 'dashboard/app.css', 'dashboard/app.js', 'dashboard/model.js', 'screenshots/1-board.png', 'screenshots/2-detail.png', 'screenshots/3-filtered.png', 'screenshots/4-method.png'];

const inputs: [string, string | null][] = [['synthetic', synthetic], ['real', realSnapshotPath()]];

for (const [label, input] of inputs) {
  test(`main.ts on the ${label} snapshot writes every required file and passes the gate`, { skip: input === null && 'real snapshot not found' }, () => {
    const out = join(work, `${label}-a`);
    const r = run(input!, out);
    assert.equal(r.status, 0, r.stderr);
    const files = tree(out);
    for (const f of REQUIRED) assert.ok(files.has(f), `missing ${f}`);
    const gate = runGate(out, parseSnapshot(readFileSync(input!, 'utf8')), (d) => buildDossier(d, DOSSIER_CAPS));
    assert.equal(gate.length, 7);
    for (const row of gate) assert.ok(row.pass, `${row.check}: ${row.detail}`);
    assert.ok(statSync(join(out, 'dossier.json')).size <= 1.5 * 1024 * 1024);
  });

  test(`main.ts on the ${label} snapshot is deterministic across runs and working directories`, { skip: input === null && 'real snapshot not found' }, () => {
    const a = join(work, `${label}-d1`);
    const b = join(work, `${label}-d2`);
    assert.equal(run(input!, a).status, 0);
    assert.equal(run(input!, b, tmpdir()).status, 0);
    const ta = tree(a);
    const tb = tree(b);
    assert.deepEqual([...ta.keys()], [...tb.keys()]);
    for (const [k, v] of ta) assert.ok(v.equals(tb.get(k)!), `${k} differs between runs`);
  });
}

test('main.ts accepts an input directory holding snapshot.json', () => {
  const dir = join(work, 'input-dir');
  const out = join(work, 'dir-out');
  rmSync(dir, { recursive: true, force: true });
  spawnSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 'snapshot.json'), readFileSync(synthetic));
  assert.equal(run(dir, out).status, 0);
});

test('main.ts exits 2 with a message when the snapshot is missing or malformed', () => {
  const missing = run(join(work, 'nope.json'), join(work, 'm-out'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no snapshot/);
  const badFile = join(work, 'bad.json');
  writeFileSync(badFile, '{"as_of":"x"}');
  const bad = run(badFile, join(work, 'b-out'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /as_of/);
});

test('a stale file in a previous output does not leak into the dossier', () => {
  const out = join(work, 'stale');
  assert.equal(run(synthetic, out).status, 0);
  const first = readFileSync(join(out, 'dossier.json'));
  writeFileSync(join(out, 'dashboard', 'stale.js'), '// left over\n');
  assert.equal(run(synthetic, out).status, 0);
  assert.ok(readFileSync(join(out, 'dossier.json')).equals(first));
});

test('the page’s own audit reproduces board.json: data.js + model.js, run as a browser runs them', () => {
  const out = join(work, 'audit');
  assert.equal(run(realSnapshotPath() ?? synthetic, out).status, 0);
  const window: Record<string, unknown> = {};
  const sandbox = createContext({ window });
  runInContext(readFileSync(join(out, 'data.js'), 'utf8'), sandbox);
  runInContext(`${readFileSync(join(out, 'dashboard', 'model.js'), 'utf8')}\nwindow.RadarModel = RadarModel;`, sandbox);
  const again = (window.RadarModel as { build(s: unknown): { board: { slug: string; rank: number; implied_value_usd: number }[] } }).build(window.RADAR_INPUT);
  const board = (JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')) as { rows: { slug: string; rank: number; implied_value_usd: number }[] }).rows;
  assert.equal(again.board.length, board.length);
  const byslug = new Map(again.board.map((r) => [r.slug, r]));
  for (const r of board) {
    assert.equal(byslug.get(r.slug)?.implied_value_usd, r.implied_value_usd, r.slug);
    assert.equal(byslug.get(r.slug)?.rank, r.rank, r.slug);
  }
});

test('the dossier shows the whole dashboard source, the model included, uncut', () => {
  const out = join(work, 'dossier');
  assert.equal(run(synthetic, out).status, 0);
  const d = JSON.parse(readFileSync(join(out, 'dossier.json'), 'utf8')) as { text: string; images: { name: string }[] };
  assert.doesNotMatch(d.text, /\[Cut at/);
  assert.ok(Buffer.byteLength(d.text) <= 65_536);
  for (const f of ['app.css', 'app.js', 'index.html', 'model.js']) assert.match(d.text, new RegExp(`### ${f.replace('.', '\\.')}\\n`));
  assert.match(d.text, /function value\(p, comps, asOf\)/);
  assert.deepEqual(d.images.map((i) => i.name), ['1-board.png', '2-detail.png', '3-filtered.png', '4-method.png']);
});

test('main.ts refuses to write its output into the repository itself', () => {
  const r = run(synthetic, REPO);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /output directory is this repository/);
  for (const f of ['index.html', 'app.css', 'app.js', 'model.js']) assert.ok(statSync(join(REPO, 'dashboard', f)).size > 0, f);
});
