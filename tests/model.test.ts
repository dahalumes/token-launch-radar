import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCoverage, checkFarmSteps, checkSorted } from '../lib/gate.ts';
import { boardJson, buildRadar, loadModel, Model as M } from '../lib/model.ts';
import { parseSnapshot, SnapshotError, type Protocol, type Snapshot } from '../lib/snapshot.ts';
import { REPO, realSnapshotPath, syntheticSnapshot } from './fixture.ts';

const base: Protocol = {
  slug: 'x', name: 'X', category: 'Lending', chains: ['Ethereum'], tvl_usd: 100_000_000, change_7d: 0,
  mcap_usd: null, listed_at: '2025-01-01', gecko_id: null, symbol: null,
};
/** A protocol whose token trades at `ratio` x its TVL. */
const peer = (slug: string, category: string | null, ratio: number): Protocol => ({ ...base, slug, category, symbol: slug.toUpperCase(), mcap_usd: Math.round(100_000_000 * ratio) });

const real = realSnapshotPath();
const realSnap: Snapshot | null = real === null ? null : parseSnapshot(readFileSync(real, 'utf8'));

// ------------------------------------------------------------------ factors

test('momentum is monotone in growth, bounded, and neutral when unknown', () => {
  assert.equal(M.momentumFactor(null), 1);
  assert.equal(M.momentumFactor(0), 1);
  assert.ok(M.momentumFactor(10) > 1 && M.momentumFactor(-10) < 1);
  assert.equal(M.momentumFactor(10_000), Math.sqrt(2));
  assert.equal(M.momentumFactor(-100), Math.sqrt(0.5));
});

test('runway rises, plateaus, then fades, within bounds', () => {
  assert.ok(M.runwayFactor(30) < M.runwayFactor(200));
  assert.equal(M.runwayFactor(400), 1);
  assert.ok(M.runwayFactor(1500) < 1);
  assert.equal(M.runwayFactor(100_000), 0.65);
  assert.equal(M.runwayFactor(null), 0.8);
  assert.equal(M.daysBetween('2025-11-14', '2026-11-14'), 365);
  assert.equal(M.daysBetween(null, '2026-11-14'), null);
});

test('classification separates watchlist, early, derivative and trading', () => {
  const watch = { w: true };
  assert.equal(M.tierOf({ ...base, slug: 'w' }, watch), 'watchlist');
  assert.equal(M.tierOf(base, watch), 'early');
  assert.equal(M.tierOf({ ...base, symbol: 'X' }, watch), 'trading');
  assert.equal(M.tierOf({ ...base, gecko_id: 'x' }, watch), 'trading');
  assert.equal(M.tierOf({ ...base, category: 'Liquid Staking' }, watch), 'derivative');
  for (const name of ['Foo V3', 'Wrapped Foo', 'Foo Staking', 'Binance Earn']) assert.notEqual(M.derivativeReason({ ...base, name }), null, name);
  assert.equal(M.derivativeReason({ ...base, name: 'Unstakedness' }), null);
});

// ------------------------------------------------------------------ comparables: sparse data and outliers

const sectorPeers = [peer('a', 'Yield', 0.1), peer('b', 'Yield', 0.2), peer('c', 'Basis Trading', 0.3), peer('d', 'Yield Aggregator', 0.15), peer('e', 'Farm', 0.25), peer('f', 'Dexs', 1), peer('g', 'Dexs', 2)];

test('a category with no priced peer takes its sector multiple, flagged as such', () => {
  const c = M.comparables(sectorPeers);
  const m = M.multipleFor('Leveraged Farming', c);
  assert.equal(m.category_peers, 0);
  assert.equal(m.basis, 'sector');
  assert.equal(m.family, 'Vaults & yield');
  assert.ok(Math.abs(Math.log(m.ratio) - c.families['Vaults & yield']!.log) < 1e-12);
  assert.equal(m.support, 'moderate'); // 5 sector peers
});

test('a sector with no priced peer falls back to the global multiple', () => {
  const c = M.comparables(sectorPeers);
  const m = M.multipleFor('Insurance', c);
  assert.equal(m.family_peers, 0);
  assert.equal(m.basis, 'global');
  assert.equal(m.support, 'thin');
  assert.ok(Math.abs(m.ratio - m.global_ratio) < 1e-12);
  // An unknown category and a null one are handled the same way.
  assert.equal(M.multipleFor('Some New Category', c).basis, 'global');
  assert.equal(M.multipleFor(null, c).family, 'Other');
});

test('one peer moves a category only part way from its sector (partial pooling)', () => {
  const c = M.comparables([...sectorPeers, peer('h', 'Liquidity Manager', 3)]);
  const m = M.multipleFor('Liquidity Manager', c);
  const fam = Math.exp(c.families['Vaults & yield']!.log);
  assert.equal(m.basis, 'category + sector');
  assert.ok(m.ratio > fam && m.ratio < 3, `${m.ratio} should lie between ${fam} and 3`);
  assert.equal(M.P.kCategory, 15);
  assert.ok(Math.abs(m.category_weight - 1 / (1 + M.P.kCategory)) < 1e-12);
});

test('with five or more peers a category is mostly its own evidence and support is strong', () => {
  const many = [1, 2, 3, 4, 5, 6].map((i) => peer(`l${i}`, 'Lending', 0.1 * i));
  const m = M.multipleFor('Lending', M.comparables([...many, ...sectorPeers]));
  assert.equal(m.support, 'strong');
  assert.equal(m.basis, 'category');
  assert.ok(Math.abs(m.category_weight - 6 / (6 + M.P.kCategory)) < 1e-12);
});

test('an extreme outlier is clipped and cannot dominate its category or the global median', () => {
  // 25 ordinary peers, so the 95th percentile sits below a lone extreme (as with the snapshot's 128).
  const calm = [...sectorPeers, ...Array.from({ length: 18 }, (_, i) => peer(`p${i}`, i < 5 ? 'Prediction Market' : 'Lending', 0.2 + 0.05 * i))];
  const wild = [...calm, peer('z', 'Prediction Market', 400)];
  const a = M.comparables(calm);
  const b = M.comparables(wild);
  const clipped = b.peers.find((p) => p.slug === 'z')!;
  assert.equal(clipped.clipped, true);
  assert.ok(Math.exp(clipped.log) <= b.winsor.high + 1e-9);
  const before = M.multipleFor('Prediction Market', a).ratio;
  const after = M.multipleFor('Prediction Market', b).ratio;
  assert.ok(after / before < 1.5, `one 400x peer moved the multiple ${before} -> ${after}`);
  assert.ok(Math.abs(Math.exp(b.global.log) / Math.exp(a.global.log) - 1) < 0.5);
});

test('peers come only from protocols recording a token with a positive market cap', () => {
  const c = M.comparables([...sectorPeers, { ...base, slug: 'n1', mcap_usd: 5e9 }, { ...peer('n2', 'Yield', 1), mcap_usd: 0 }, { ...peer('n3', 'Yield', 1), mcap_usd: null }]);
  assert.equal(c.global.n, sectorPeers.length);
});

test('an empty peer set still values protocols, at a documented default, with thin support', () => {
  const v = M.value(base, M.comparables([]), '2026-11-14');
  assert.ok(v.implied_value_usd > 0);
  assert.equal(v.peers.support, 'thin');
});

// ------------------------------------------------------------------ valuation and uncertainty

test('implied value is TVL x multiple x momentum x runway, inside its range', () => {
  const c = M.comparables(sectorPeers);
  const p: Protocol = { ...base, category: 'Yield', change_7d: 21, listed_at: '2025-06-01' };
  const v = M.value(p, c, '2026-11-14');
  const expected = p.tvl_usd * M.multipleFor('Yield', c).ratio * M.momentumFactor(21) * M.runwayFactor(v.days_tracked);
  assert.equal(v.implied_value_usd, Math.round(expected));
  assert.ok(v.low_usd < v.implied_value_usd && v.implied_value_usd < v.high_usd);
  // Twice the TVL, twice the value (all else equal).
  assert.ok(Math.abs(M.value({ ...p, tvl_usd: 2 * p.tvl_usd }, c, '2026-11-14').implied_value_usd / v.implied_value_usd - 2) < 1e-6);
});

test('every board row states a value inside its 50% range', { skip: realSnap === null }, () => {
  for (const r of buildRadar(realSnap!).board) {
    const v = r.valuation;
    assert.ok(v.low_usd <= v.implied_value_usd && v.implied_value_usd <= v.high_usd, r.slug);
    assert.ok(['strong', 'moderate', 'thin'].includes(v.peers.support));
  }
});

// ------------------------------------------------------------------ farm plans: chains and actions

/** Every chain name the snapshot knows, plus the model's gas table. */
const chainUniverse = new Set<string>([...Object.keys(M.GAS), ...syntheticSnapshot().protocols.flatMap((p) => p.chains), ...(realSnap?.protocols.flatMap((p) => p.chains) ?? [])]);

/** Chains a plan names that the protocol's own record does not list. */
function strayChains(p: { name: string; slug: string; chains: string[] }, steps: string[]): string[] {
  let text = steps.join('\n').split(p.name).join(' ').split(p.slug).join(' ');
  // Blank the listed chains first (longest first), so 'Plume' inside a listed 'Plume Mainnet' is not a stray.
  for (const c of [...p.chains].sort((a, b) => b.length - a.length)) text = text.split(c).join(' ');
  return [...chainUniverse].filter((c) => !p.chains.includes(c) && new RegExp(`(^|[^\\w])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(text));
}

test('farm plans name only chains in the protocol’s own record', () => {
  const snaps = [syntheticSnapshot(), ...(realSnap ? [realSnap] : [])];
  for (const s of snaps) for (const r of buildRadar(s).board) assert.deepEqual(strayChains(r, r.farm_steps), [], r.slug);
});

test('the cheapest-chain pick is always one the record lists, with an honest estimate for unknown gas', () => {
  assert.equal(M.chainPlan(['Ethereum', 'Base']).cheapest, 'Base');
  const odd = M.chainPlan(['Obscurechain']);
  assert.equal(odd.cheapest, 'Obscurechain');
  assert.equal(odd.gasEstimated, true);
  assert.equal(M.chainPlan(['Obscurechain', 'Ethereum']).cheapest, 'Ethereum');
  const c = M.comparables(sectorPeers);
  const steps = M.farmSteps({ ...base, chains: ['Obscurechain'] }, 'early', M.value({ ...base, chains: ['Obscurechain'] }, c, '2026-11-14'));
  assert.ok(steps.some((s) => /estimated: this model has no gas reference for Obscurechain/.test(s)));
  const none = M.farmSteps({ ...base, chains: [] }, 'early', M.value({ ...base, chains: [] }, c, '2026-11-14'));
  assert.ok(none.some((s) => s.includes('the chain its app names')));
  assert.deepEqual(strayChains({ ...base, chains: [] }, none), []);
});

test('a cross-chain bridge with one listed chain does not get a two-chain plan', () => {
  assert.equal(M.playbookOf({ ...base, category: 'Cross Chain Bridge', chains: ['Base'] }), 'general');
  assert.equal(M.playbookOf({ ...base, category: 'Cross Chain Bridge', chains: ['Base', 'Ethereum'] }), 'bridge');
});

test('each playbook only proposes actions its category supports', () => {
  const c = M.comparables(sectorPeers);
  const plan = (category: string | null): string => {
    const p = { ...base, category, chains: ['Base', 'Ethereum'] };
    return M.farmSteps(p, 'early', M.value(p, c, '2026-11-14')).join(' ');
  };
  for (const cat of ['Risk Curators', 'Yield', 'Basis Trading', 'Dexs', 'RWA', 'Chain', 'Staking Pool', 'Payments', null]) assert.doesNotMatch(plan(cat), /\bborrow/i, `${cat} should not suggest borrowing`);
  assert.match(plan('Lending'), /Only if that market allows borrowing/);
  assert.match(plan('Uncollateralized Lending'), /farm as a lender only/);
  for (const cat of ['Lending', 'Risk Curators', 'RWA', 'CDP']) assert.doesNotMatch(plan(cat), /\b(swap|leverage|liquidity to a major pair)\b/i, `${cat} should not suggest DEX or perps actions`);
  assert.match(plan('Dexs'), /liquidity to a major pair/);
  assert.match(plan('Derivatives'), /2x leverage at most/);
  assert.match(plan('CDP'), /mint its stablecoin/);
});

test('every farm step fits the gate and states its cost and its time, on every playbook', () => {
  const c = M.comparables(sectorPeers);
  const cats = [...Object.values(M.FAMILIES).flat(), null, 'Unknown Category'];
  for (const category of cats) for (const chains of [[], ['Base'], ['Ethereum', 'Base', 'Solana', 'Monad', 'Arc', 'Katana', 'Polygon', 'Unichain', 'Corn']]) {
    const p = { ...base, category, chains };
    const tier = M.derivativeReason(p) === null ? 'early' : 'derivative';
    const steps = M.farmSteps(p, tier, M.value(p, c, '2026-11-14'));
    assert.ok(steps.length >= 3 && steps.length <= 12, `${category}`);
    for (const s of steps) {
      assert.ok(s.trim().length >= 20 && s.trim().length <= 600, `${category}: step of ${s.length} chars`);
      assert.match(s, /Cost: .+Time: /, `${category}: ${s}`);
    }
  }
});

// ------------------------------------------------------------------ wording

const OVERCLAIM = /\b(has|have|with) no token\b(?! recorded)|\bwithout a token\b|\btokenless\b|\bno token yet\b|\bhas not launched\b/i;

test('nothing claims a protocol has no token: only that its record shows none', () => {
  for (const f of ['model.js', 'app.js', 'index.html']) assert.doesNotMatch(readFileSync(join(REPO, 'dashboard', f), 'utf8'), OVERCLAIM, f);
  const r = buildRadar(realSnap ?? syntheticSnapshot());
  for (const row of r.board) for (const s of row.farm_steps) assert.doesNotMatch(s, OVERCLAIM, row.slug);
  assert.doesNotMatch(boardJson(r), OVERCLAIM);
  assert.match(boardJson(r), /model estimate/);
});

test('the model names no protocol: no watchlist slug or name appears in model.js', { skip: realSnap === null }, () => {
  const src = readFileSync(join(REPO, 'dashboard', 'model.js'), 'utf8').toLowerCase();
  const named = realSnap!.protocols.filter((p) => realSnap!.watchlist.includes(p.slug) || p.slug.includes('-'));
  for (const p of named) {
    const word = (t: string): RegExp => new RegExp(`(^|[^a-z0-9])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    assert.doesNotMatch(src, word(p.slug), `slug ${p.slug} appears in model.js`);
    if (p.name.length >= 6) assert.doesNotMatch(src, word(p.name), `name ${p.name} appears in model.js`);
  }
});

// ------------------------------------------------------------------ the board

test('buildRadar on a synthetic snapshot meets the board rules', () => {
  const s = syntheticSnapshot();
  const r = buildRadar(s);
  assert.ok(r.board.length >= 100 && r.board.length <= 4000);
  assert.ok(checkSorted(r.board).pass);
  assert.ok(checkCoverage(r.board, s).pass);
  assert.ok(checkFarmSteps(r.board).pass);
  assert.ok(r.board.every((b) => b.tier !== 'trading'), 'no token-trading protocol is ranked as pre-token');
  assert.ok(new Set(r.board.map((b) => b.implied_value_usd)).size > 1);
});

test('a snapshot with too few early protocols is filled to 100 rows with flagged derivatives', () => {
  const s = syntheticSnapshot();
  const keep = new Set(s.protocols.filter((p) => M.tierOf(p, Object.fromEntries(s.watchlist.map((w) => [w, true]))) === 'early').slice(0, 20).map((p) => p.slug));
  const thin: Snapshot = { ...s, protocols: s.protocols.filter((p) => keep.has(p.slug) || s.watchlist.includes(p.slug) || M.recordsToken(p) || M.derivativeReason(p) !== null) };
  const r = buildRadar(thin);
  assert.equal(r.board.length, 100);
  assert.ok(r.board.some((b) => b.tier === 'derivative'));
  assert.ok(r.board.filter((b) => b.tier === 'derivative').every((b) => b.farm_steps.some((x) => x.startsWith('Caution'))));
  assert.ok(checkSorted(r.board).pass && checkCoverage(r.board, thin).pass);
});

test('buildRadar is a pure function of the snapshot, whatever the input order or model instance', () => {
  const a = boardJson(buildRadar(syntheticSnapshot()));
  assert.equal(boardJson(buildRadar(syntheticSnapshot())), a);
  const shuffled = syntheticSnapshot();
  shuffled.protocols.reverse();
  assert.equal(boardJson(buildRadar(shuffled)), a);
  assert.equal(JSON.stringify(loadModel().build(syntheticSnapshot(), 100).board), JSON.stringify(buildRadar(syntheticSnapshot()).board));
});

test('parseSnapshot refuses malformed input with a named field', () => {
  const good = syntheticSnapshot(5);
  assert.throws(() => parseSnapshot('{'), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ ...good, as_of: '2026-13-40' })), /as_of/);
  assert.throws(() => parseSnapshot(JSON.stringify({ ...good, protocols: [...good.protocols, good.protocols[0]] })), /appears twice/);
  assert.throws(() => parseSnapshot(JSON.stringify({ ...good, watchlist: ['nope'] })), /watchlist/);
  const missing = JSON.parse(JSON.stringify(good));
  delete missing.protocols[0].symbol;
  assert.throws(() => parseSnapshot(JSON.stringify(missing)), /symbol/);
});

test('the real snapshot yields a board covering its watchlist, with no category priced from one peer alone', { skip: realSnap === null }, () => {
  assert.equal(realSnap!.protocols.length, 758);
  assert.equal(realSnap!.watchlist.length, 40);
  const r = buildRadar(realSnap!);
  assert.ok(r.board.length >= 100);
  assert.ok(checkCoverage(r.board, realSnap!).pass && checkSorted(r.board).pass);
  for (const b of r.board) if (b.valuation.peers.category_peers < 5) assert.ok(b.valuation.peers.category_weight < 0.5, b.slug);
});

// ------------------------------------------------------------------ P1 audit corrections

test('curators and allocators form their own sector, valued below vault protocols on the real snapshot', { skip: realSnap === null }, () => {
  assert.deepEqual(M.FAMILIES['Curators & allocators'], ['Risk Curators', 'Onchain Capital Allocator']);
  assert.ok(!M.FAMILIES['Vaults & yield']!.includes('Risk Curators'));
  const c = M.comparables(realSnap!.protocols);
  const rc = M.multipleFor('Risk Curators', c);
  assert.equal(rc.family, 'Curators & allocators');
  assert.match(rc.note ?? '', /capital it manages inside other protocols/);
  assert.ok(rc.ratio < Math.exp(c.families['Vaults & yield']!.log), 'curator multiple below the vault sector');
  assert.equal(M.multipleFor('Yield', c).note, null);
});

test('held-out diagnostics calibrate the range to cover half of the held-out peers', { skip: realSnap === null }, () => {
  const d = M.diagnostics(realSnap!.protocols);
  assert.equal(d.calibrated, true);
  assert.equal(d.n, 128);
  assert.ok(Math.abs(d.coverage! - 0.5) <= 0.02, `coverage ${d.coverage}`);
  assert.ok(d.z > d.nominal_z!, 'the textbook z under-covers');
  assert.ok(d.nominal_coverage! < 0.5);
  assert.ok(d.z80! > d.z);
  assert.ok(d.mae! <= d.mae_global!, `model ${d.mae} vs global ${d.mae_global}`);
  const r = buildRadar(realSnap!);
  assert.deepEqual(r.diagnostics, d);
});

test('with too few priced peers the range falls back to the documented z, uncalibrated', () => {
  const few: Snapshot = { ...syntheticSnapshot(), protocols: [...sectorPeers, base] };
  const d = M.diagnostics(few.protocols);
  assert.equal(d.calibrated, false);
  assert.equal(d.z, M.P.rangeZ);
});

test('ranges carry two significant figures, rounded outward, and contain the value', () => {
  assert.equal(M.sig2(142_237_811, -1), 140_000_000);
  assert.equal(M.sig2(142_237_811, 1), 150_000_000);
  assert.equal(M.sig2(7.4, -1), 7);
  assert.equal(M.sig2(0.2, -1), 1);
  for (const r of buildRadar(realSnap ?? syntheticSnapshot()).board) {
    const v = r.valuation;
    assert.ok(v.low_usd <= v.implied_value_usd && v.implied_value_usd <= v.high_usd, r.slug);
    for (const x of [v.low_usd, v.high_usd]) assert.ok(String(x).replace(/0+$/, '').length <= 2, `${r.slug}: ${x}`);
  }
});

test('farm plans never assume a points program, a launch or a return', () => {
  for (const r of buildRadar(realSnap ?? syntheticSnapshot()).board) {
    for (const step of r.farm_steps) {
      assert.doesNotMatch(step, /usually (weight|reward)|points season|official bridge|completing its KYC/i, r.slug);
      for (const sentence of step.split(/(?<=[.;:])\s+/)) if (/\bpoints?\b/i.test(sentence)) assert.match(sentence, /\b(if|look for|found|any)\b/i, `${r.slug}: unconditional points claim: ${sentence}`);
    }
    const pay = r.farm_steps.find((x) => x.startsWith('Payoff illustration'));
    assert.ok(pay, r.slug);
    assert.match(pay!, /^Payoff illustration, not a forecast: only if a token launched/);
    assert.equal(/does not even cover the gas/.test(pay!), r.payoff_below_gas, r.slug);
  }
});

test('payoff below gas is flagged exactly when the illustration is smaller than the plan’s gas', () => {
  const c = M.comparables(sectorPeers);
  const eth = { ...base, category: 'Yield', chains: ['Ethereum'], tvl_usd: 6_000_000_000 };
  const cheap = { ...base, category: 'Yield', chains: ['Base'], tvl_usd: 20_000_000 };
  const pe = M.payoff(eth, M.value(eth, c, '2026-11-14'));
  const pc = M.payoff(cheap, M.value(cheap, c, '2026-11-14'));
  assert.equal(pe.belowGas, pe.reward < pe.gas);
  assert.equal(pc.belowGas, false);
  assert.equal(pe.gas, 48);
});

test('allocators get a playbook that first checks whether they take outside deposits', () => {
  const p = { ...base, category: 'Onchain Capital Allocator', chains: ['Base'] };
  assert.equal(M.playbookOf(p), 'allocator');
  const plan = M.farmSteps(p, 'early', M.value(p, M.comparables(sectorPeers), '2026-11-14')).join(' ');
  assert.match(plan, /Check whether it takes outside deposits at all/);
  assert.match(plan, /if not, skip it/);
});

test('the page calls its check a consistency check and says it is not an accuracy test', () => {
  const app = readFileSync(join(REPO, 'dashboard', 'app.js'), 'utf8');
  assert.match(app, /Consistency check/);
  assert.match(app, /reproducible from the code, which is not to say they are accurate/);
  assert.doesNotMatch(app, /\bAudit\b/);
  assert.match(app, /Held-out diagnostics/);
});
