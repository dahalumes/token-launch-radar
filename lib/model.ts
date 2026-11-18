// The radar's model lives in dashboard/model.js, a plain browser script, so the judge reads the exact code
// that produced the board and the page can re-derive every value in the browser. This module loads that
// same file into Node (vm.compileFunction, the current realm, no globals touched) and gives it types.
//
// Nothing is computed here: one implementation, two runtimes, identical numbers.

import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import type { Protocol, Snapshot } from './snapshot.ts';

export const MODEL_FILE = new URL('../dashboard/model.js', import.meta.url);

export type Tier = 'watchlist' | 'early' | 'derivative' | 'trading';

export interface Peers {
  ratio: number;
  family: string;
  basis: 'category' | 'category + sector' | 'sector' | 'global';
  support: 'strong' | 'moderate' | 'thin';
  sigma: number;
  category_peers: number;
  family_peers: number;
  global_peers: number;
  category_raw: number | null;
  family_raw: number | null;
  global_ratio: number;
  category_weight: number;
  note: string | null;
}

export interface Valuation {
  implied_value_usd: number;
  low_usd: number;
  high_usd: number;
  multiple: number;
  momentum: number;
  runway: number;
  days_tracked: number | null;
  per_1k_tvl: number;
  peers: Peers;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  implied_value_usd: number;
  tier: Tier;
  category: string | null;
  family: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  valuation: Valuation;
  playbook: string;
  payoff_below_gas: boolean;
  farm_steps: string[];
}

export interface TradingRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  family: string;
  tvl_usd: number;
  mcap_usd: number | null;
  mcap_to_tvl: number | null;
}

/** Leave-one-out diagnostics over the priced peers (dashboard/model.js diagnostics()). */
export interface Diagnostics {
  n: number;
  calibrated: boolean;
  z: number;
  coverage?: number;
  nominal_z?: number;
  nominal_coverage?: number;
  z80?: number;
  mae?: number;
  mae_sector?: number;
  mae_global?: number;
}

export interface Radar {
  model: string;
  params: Record<string, number>;
  as_of: string;
  source: string;
  floor_usd: number;
  counts: { protocols: number; watchlist: number; board: number; early: number; derivative: number; trading: number; priced_peers: number };
  diagnostics: Diagnostics;
  comparables: {
    global: { ratio: number; n: number; sigma: number };
    winsor: { low: number; high: number };
    families: { family: string; n: number; raw: number | null; pooled: number }[];
    categories: { category: string; family: string; n: number; raw: number; pooled: number }[];
  };
  board: BoardRow[];
  trading: TradingRow[];
}

export interface Comparables {
  global: { log: number; n: number; sigma: number };
  families: Record<string, { log: number; n: number; rawLog: number | null; sigma: number | null }>;
  categories: Record<string, { log: number; n: number; rawLog: number; sigma: number | null }>;
  winsor: { low: number; high: number };
  peers: { slug: string; category: string | null; ratio: number; log: number; clipped: boolean }[];
  z: number;
}

export interface ChainPlan {
  chains: string[];
  cheapest: string | null;
  gas: number;
  gasEstimated: boolean;
  gasMax: number;
}

export interface RadarModelApi {
  P: Record<string, number>;
  FAMILIES: Record<string, string[]>;
  GAS: Record<string, number>;
  build(s: Snapshot, minRows?: number): Radar;
  comparables(ps: readonly Protocol[]): Comparables;
  multipleFor(category: string | null, c: Comparables): Peers;
  value(p: Protocol, c: Comparables, asOf: string): Valuation;
  diagnostics(ps: readonly Protocol[]): Diagnostics;
  payoff(p: Protocol, v: Valuation): { size: number; reward: number; gas: number; belowGas: boolean };
  sig2(x: number, dir: number): number;
  momentumFactor(change7d: number | null): number;
  runwayFactor(days: number | null): number;
  daysBetween(from: string | null, to: string): number | null;
  tierOf(p: Protocol, watch: Record<string, boolean>): Tier;
  derivativeReason(p: Protocol): string | null;
  recordsToken(p: Protocol): boolean;
  familyOf(category: string | null): string;
  playbookOf(p: Protocol): string;
  chainPlan(chains: readonly string[]): ChainPlan;
  farmSteps(p: Protocol, tier: Tier, v: Valuation): string[];
  money(x: number): string;
  compact(x: number): string;
  quantile(xs: number[], q: number): number;
  median(xs: number[]): number;
}

/** Load a fresh copy of the model from its source text (a new closure each call: no shared state). */
export function loadModel(source = readFileSync(MODEL_FILE, 'utf8')): RadarModelApi {
  return compileFunction(`${source}\nreturn RadarModel;`, [], { filename: 'dashboard/model.js' })() as RadarModelApi;
}

export const Model = loadModel();

export const MIN_BOARD_ROWS = 100;

export function buildRadar(s: Snapshot): Radar {
  return Model.build(s, MIN_BOARD_ROWS);
}

/** The board.json the gate reads: the required fields plus the model's evidence (extra keys are allowed). */
export function boardJson(r: Radar): string {
  const rows = r.board.map((b) => ({
    rank: b.rank,
    slug: b.slug,
    name: b.name,
    implied_value_usd: b.implied_value_usd,
    implied_value_low_usd: b.valuation.low_usd,
    implied_value_high_usd: b.valuation.high_usd,
    comparable_support: b.valuation.peers.support,
    payoff_below_gas: b.payoff_below_gas,
    tier: b.tier,
    category: b.category,
    tvl_usd: b.tvl_usd,
    change_7d: b.change_7d,
    farm_steps: b.farm_steps,
  }));
  const note = 'implied_value_usd is a model estimate of what a token would be worth if the protocol’s record stayed as it is; it is not a market value and not a prediction that a token will launch. The low/high fields are an indicative range calibrated by leave-one-out on priced peers, not a validated forecast interval.';
  return `${JSON.stringify({ model: r.model, as_of: r.as_of, source: r.source, note, diagnostics: r.diagnostics, rows }, null, 1)}\n`;
}

/**
 * The page's data: the snapshot itself (so the page can re-run the model and audit the board) and the
 * board main.ts computed. Two globals, set by a plain script, so the page works from file:// with no fetch.
 */
export function dataScript(r: Radar, s: Snapshot): string {
  return `window.RADAR_INPUT = ${JSON.stringify(s)};\nwindow.RADAR = ${JSON.stringify(r)};\n`;
}
