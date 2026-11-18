// Token Launch Radar: the entrypoint the grader runs (Node 22.18+, standard library only, no network).
//
//   reads   /input/snapshot.json                (or --input <file|dir>)
//   writes  /output/board.json                  the ranked board the gate reads
//           /output/data.js                     the dashboard's data (window.RADAR), beside the page
//           /output/dashboard/                  the page, copied from this repository
//           /output/screenshots/                the three captures, copied from this repository
//           /output/dossier.json                written last, with vendor/makefun-board.ts's buildDossier
//
// Outside the grader, MAKEFUN_OUTPUT_DIR or --output stands in for /output:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
//
// Every run on the same snapshot writes the same bytes: the model reads no clock and no randomness.
// Before exiting the program re-checks its own output against the published gate rows (lib/gate.ts)
// and exits 1 if any fails, so a broken board never leaves this machine looking valid.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOSSIER_CAPS, runGate } from './lib/gate.ts';
import { boardJson, buildRadar, dataScript } from './lib/model.ts';
import { parseSnapshot, SnapshotError } from './lib/snapshot.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function argValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

/** Copy a directory's regular files (recursively, dot-names skipped) into `to`, in name order. */
function copyTree(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    const st = statSync(src);
    if (st.isDirectory()) n += copyTree(src, join(to, name));
    else if (st.isFile()) {
      copyFileSync(src, join(to, name));
      n++;
    }
  }
  return n;
}

function die(msg: string, code = 1): never {
  process.stderr.write(`token radar: ${msg}\n`);
  process.exit(code);
}

function main(argv: readonly string[]): void {
  const inputArg = argValue(argv, 'input') ?? '/input';
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) die(`no snapshot at ${inputFile}: pass --input <snapshot.json|dir> or mount /input`, 2);
  const out = argValue(argv, 'output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  // Writing into this repository would delete its own dashboard/ and screenshots/ before copying them.
  if (resolve(out) === resolve(HERE)) die('the output directory is this repository: choose another (the grader uses /output)', 2);

  let snapshot;
  try {
    snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  } catch (err) {
    if (err instanceof SnapshotError) die(err.message, 2);
    throw err;
  }
  const radar = buildRadar(snapshot);

  mkdirSync(out, { recursive: true });
  // Start the copied trees clean so a stale file from an earlier run cannot change the dossier.
  for (const d of ['dashboard', 'screenshots']) rmSync(join(out, d), { recursive: true, force: true });
  writeFileSync(join(out, 'board.json'), boardJson(radar));
  writeFileSync(join(out, 'data.js'), dataScript(radar, snapshot));
  const pages = copyTree(join(HERE, 'dashboard'), join(out, 'dashboard'));
  const shots = copyTree(join(HERE, 'screenshots'), join(out, 'screenshots'));

  // The dossier is written last: the scorer rebuilds it from this directory and compares bytes.
  try {
    writeFileSync(join(out, 'dossier.json'), buildDossier(out, DOSSIER_CAPS));
  } catch (err) {
    die(`cannot write the dossier: ${(err as Error).message}`);
  }

  const gate = runGate(out, snapshot, (dir) => buildDossier(dir, DOSSIER_CAPS));
  const failed = gate.filter((r) => !r.pass);
  const c = radar.counts;
  process.stdout.write(
    `token radar: ${c.protocols} protocols, ${c.watchlist} on the watchlist, ${c.board} ranked (${c.early} early, ${c.derivative} derivative set aside, ${c.trading} with a token)\n` +
      `token radar: wrote board.json, data.js, dashboard/ (${pages} files), screenshots/ (${shots}) and dossier.json to ${out}\n` +
      gate.map((r) => `  ${r.pass ? 'pass' : 'FAIL'} ${r.check}: ${r.detail}\n`).join(''),
  );
  if (failed.length > 0) die(`${failed.length} gate row(s) fail: ${failed.map((r) => r.check).join(', ')}`);
}

main(process.argv.slice(2));
