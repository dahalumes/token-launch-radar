// A deterministic synthetic snapshot in the sealed snapshot's exact shape, so the tests run without the
// kit's real input. Values come from a fixed-seed LCG: the same fixture every time.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Protocol, Snapshot } from '../lib/snapshot.ts';
import { Model } from '../lib/model.ts';

export const REPO = fileURLToPath(new URL('..', import.meta.url));

const CATEGORIES = ['Dexs', 'Lending', 'Yield', 'Risk Curators', 'RWA', 'Derivatives', 'CDP', 'Liquid Staking', 'Bridge', 'CEX', 'Chain', null];
const CHAINS = ['Ethereum', 'Solana', 'Base', 'Arbitrum', 'BSC', 'Sui', 'Hyperliquid L1', 'Polygon'];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function syntheticSnapshot(n = 320, seed = 7): Snapshot {
  const rnd = lcg(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const protocols: Protocol[] = [];
  for (let i = 0; i < n; i++) {
    const hasToken = rnd() < 0.5;
    const tvl = Math.floor(5_000_000 * Math.exp(rnd() * 7));
    const day = new Date(Date.UTC(2021, 0, 1) + Math.floor(rnd() * 2100) * 86_400_000).toISOString().slice(0, 10);
    const chains = [...new Set([pick(CHAINS), pick(CHAINS), pick(CHAINS)].slice(0, 1 + Math.floor(rnd() * 3)))];
    const slug = `proto-${String(i).padStart(3, '0')}`;
    protocols.push({
      slug,
      name: i % 41 === 0 ? `Proto ${i} V2` : `Proto ${i}`,
      category: pick(CATEGORIES),
      chains,
      tvl_usd: tvl,
      change_7d: rnd() < 0.05 ? null : Math.round((rnd() * 40 - 15) * 10_000) / 10_000,
      mcap_usd: hasToken ? Math.floor(tvl * (0.05 + rnd() * 3)) : null,
      listed_at: rnd() < 0.1 ? null : day,
      gecko_id: hasToken ? `gecko-${i}` : null,
      symbol: hasToken ? `P${i}` : null,
    });
  }
  const floor = 50_000_000;
  const watchlist = protocols
    .filter((p) => p.tvl_usd >= floor && p.gecko_id === null && p.symbol === null && Model.derivativeReason(p) === null)
    .map((p) => p.slug);
  return { as_of: '2026-11-14', source: 'synthetic fixture for tests', floor_usd: floor, protocols, watchlist };
}

/** The kit's real snapshot when it can be found (TOKEN_RADAR_SNAPSHOT, or the kit beside this repository). */
export function realSnapshotPath(): string | null {
  const candidates = [
    process.env.TOKEN_RADAR_SNAPSHOT,
    join(REPO, '..', 'makefun-kit', 'token-radar-01-kit', 'input', 'snapshot.json'),
  ];
  for (const c of candidates) if (c !== undefined && c !== '' && existsSync(c)) return c;
  return null;
}
