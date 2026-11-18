// Token Launch Radar model, the one implementation of valuation and farm plans: main.ts runs this file to
// write board.json and the page runs it again (the consistency check). No clock, no randomness and no
// protocol names: implied value = TVL x peer multiple x momentum x runway, from the snapshot's figures.
var RadarModel = (function () {
  'use strict';

  var P = {
    // Peer multiples: market cap / TVL of priced tokens, winsorised to their 5th-95th percentile, log-median.
    winsorLow: 0.05,
    winsorHigh: 0.95,
    // Partial pooling: a category keeps n / (n + kCategory) of its own evidence, a sector n / (n + kFamily).
    // kCategory 15, not 5: held out, category medians did no better than one global multiple (1.80 vs 1.81)
    // and 15 was the only setting tried that lowered the error.
    kCategory: 15,
    kFamily: 5,
    // Spread is measured where at least this many peers exist (category, else sector, else global).
    minSpreadPeers: 5,
    // Range z: set by leave-one-out in diagnostics(); rangeZ is the fallback below minCalibrationPeers.
    rangeZ: 0.674,
    rangeCoverage: 0.5,
    minCalibrationPeers: 20,
    // Momentum: square root of the 7-day TVL growth factor, the factor clipped to [0.5, 2].
    growthMin: 0.5,
    growthMax: 2,
    // Runway (days tracked with no token recorded): ramp, plateau, fade.
    rampDays: 270,
    plateauDays: 900,
    fadeDays: 900,
    fadeMax: 0.35,
    runwayUnknown: 0.8,
    // Illustration only: share of a token's value assumed to reach users pro rata, if a token launches.
    userShare: 0.1,
    maxValue: 1e14
  };

  // --- classification

  var DERIVATIVE_CATEGORIES = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];
  var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  var WRAPPED = /\b(wrapped|staked|staking)\b/i;
  var EXCHANGE = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

  function recordsToken(p) { return p.gecko_id !== null || p.symbol !== null; }

  // Why a protocol that records no token looks like a product of a token that already trades, or null.
  function derivativeReason(p) {
    if (p.category !== null && DERIVATIVE_CATEGORIES.indexOf(p.category) >= 0) return 'category ' + p.category;
    if (VERSIONED.test(p.name)) return 'versioned name';
    if (WRAPPED.test(p.name)) return 'wrapped or staked product name';
    if (EXCHANGE.test(p.name)) return 'exchange product';
    return null;
  }

  // watchlist (the snapshot's list), trading (token recorded), derivative (wrapper product), else early.
  function tierOf(p, watch) {
    if (watch[p.slug]) return 'watchlist';
    if (recordsToken(p)) return 'trading';
    return derivativeReason(p) === null ? 'early' : 'derivative';
  }

  // --- sectors (category families)

  // Sectors: categories grouped by how they earn, the fallback for thin categories. Curators & allocators
  // earn a fee on capital deployed in other protocols' markets (TVL also counted there); their priced
  // peers trade at 0.006x and 0.019x against a vault median near 0.17x, so pooling with vaults overstated them.
  var FAMILIES = {
    'Curators & allocators': ['Risk Curators', 'Onchain Capital Allocator'],
    'Vaults & yield': ['Yield', 'Yield Aggregator', 'Basis Trading', 'Liquidity Manager', 'Leveraged Farming', 'Farm', 'Indexes', 'Options Vault', 'Staking Pool', 'Restaking', 'Governance Incentives'],
    'Credit & stablecoins': ['Lending', 'CDP', 'CDP Manager', 'Uncollateralized Lending', 'Collateral Markets', 'Collateral Management', 'Dual-Token Stablecoin', 'Stablecoin Wrapper', 'Algo-Stables', 'Stablecoin Issuer', 'Reserve Currency'],
    'Trading venues': ['Dexs', 'Derivatives', 'Interest Rate Derivatives', 'Prediction Market', 'Options', 'Synthetics', 'OTC Marketplace', 'NFT Marketplace', 'Launchpad'],
    'Real-world & BTC yield': ['RWA', 'CeDeFi', 'Anchor BTC', 'Decentralized BTC'],
    'Infrastructure & payments': ['Chain', 'Cross Chain Bridge', 'Payments', 'Crypto Card Issuer', 'Privacy', 'Insurance', 'AI Agents', 'Decentralized AI', 'Token Locker', 'DOR'],
    'Wrappers & custodians': ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']
  };
  var FAMILY_NOTES = {
    'Curators & allocators': 'Its TVL is capital it manages inside other protocols’ markets, much of it also counted there, so it is valued with fee-on-assets peers.'
  };
  var FAMILY_OF = {};
  Object.keys(FAMILIES).forEach(function (f) { FAMILIES[f].forEach(function (c) { FAMILY_OF[c] = f; }); });
  function familyOf(category) { return (category !== null && FAMILY_OF[category]) || 'Other'; }

  // --- statistics

  function sorted(xs) { return xs.slice().sort(function (a, b) { return a - b; }); }
  function median(xs) {
    var s = sorted(xs), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // Nearest-rank quantile: always an observed value.
  function quantile(xs, q) {
    var s = sorted(xs);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  }
  // Robust standard deviation: 1.4826 x the median absolute deviation.
  function robustSigma(xs) {
    var m = median(xs);
    return 1.4826 * median(xs.map(function (x) { return Math.abs(x - m); }));
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function round4(x) { return Math.round(x * 1e4) / 1e4; }
  // Two significant figures, rounded outward (dir < 0 down, else up): a range shows no false precision.
  function sig2(x, dir) {
    if (x < 10) return dir < 0 ? Math.max(1, Math.floor(x)) : Math.ceil(x);
    var step = Math.pow(10, String(Math.floor(x)).length - 2);
    return (dir < 0 ? Math.floor(x / step) : Math.ceil(x / step)) * step;
  }

  // --- comparables

  // Peer multiples from every protocol that records a token with a positive market cap and TVL.
  function comparables(protocols) {
    var peers = protocols.filter(function (p) {
      return recordsToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
    }).map(function (p) {
      return { slug: p.slug, category: p.category, ratio: p.mcap_usd / p.tvl_usd };
    });
    var logs = peers.map(function (x) { return Math.log(x.ratio); });
    var lo = logs.length ? quantile(logs, P.winsorLow) : Math.log(0.2);
    var hi = logs.length ? quantile(logs, P.winsorHigh) : Math.log(0.2);
    peers.forEach(function (x) { x.log = clamp(Math.log(x.ratio), lo, hi); x.clipped = x.log !== Math.log(x.ratio); });

    var all = peers.map(function (x) { return x.log; });
    var g = all.length ? median(all) : Math.log(0.2);
    var global = { log: g, n: all.length, sigma: all.length >= 2 ? robustSigma(all) : 1 };

    function group(key) {
      var out = {};
      peers.forEach(function (x) { var k = key(x); (out[k] = out[k] || []).push(x.log); });
      return out;
    }
    var famLogs = group(function (x) { return familyOf(x.category); });
    var catLogs = group(function (x) { return x.category === null ? '(none)' : x.category; });

    var families = {};
    Object.keys(FAMILIES).concat(['Other']).forEach(function (f) {
      var xs = famLogs[f] || [];
      var n = xs.length;
      var own = n ? median(xs) : g;
      families[f] = { log: (n * own + P.kFamily * g) / (n + P.kFamily), n: n, rawLog: n ? own : null, sigma: n >= P.minSpreadPeers ? robustSigma(xs) : null };
    });
    var categories = {};
    Object.keys(catLogs).sort().forEach(function (c) {
      var xs = catLogs[c], n = xs.length, fam = families[familyOf(c === '(none)' ? null : c)];
      categories[c] = { log: (n * median(xs) + P.kCategory * fam.log) / (n + P.kCategory), n: n, rawLog: median(xs), sigma: n >= P.minSpreadPeers ? robustSigma(xs) : null };
    });
    return { global: global, families: families, categories: categories, winsor: { low: Math.exp(lo), high: Math.exp(hi) }, peers: peers, z: P.rangeZ };
  }

  // The multiple a category gets, with the evidence behind it and the spread its range uses.
  function multipleFor(category, comps) {
    var famName = familyOf(category);
    var fam = comps.families[famName];
    var cat = comps.categories[category === null ? '(none)' : category];
    var catN = cat ? cat.n : 0;
    var log = cat ? cat.log : fam.log;
    var sigma = (cat && cat.sigma) || fam.sigma || comps.global.sigma;
    var support = catN >= P.minSpreadPeers ? 'strong' : fam.n >= P.minSpreadPeers ? 'moderate' : 'thin';
    var basis = catN >= P.minSpreadPeers ? 'category' : catN > 0 ? 'category + sector' : fam.n > 0 ? 'sector' : 'global';
    return {
      ratio: Math.exp(log), family: famName, basis: basis, support: support, sigma: sigma,
      category_peers: catN, family_peers: fam.n, global_peers: comps.global.n,
      category_raw: cat ? Math.exp(cat.rawLog) : null,
      family_raw: fam.rawLog === null ? null : Math.exp(fam.rawLog),
      global_ratio: Math.exp(comps.global.log),
      category_weight: catN / (catN + P.kCategory),
      note: FAMILY_NOTES[famName] || null
    };
  }

  // --- held-out diagnostics

  // Leave-one-out: predict each priced peer's multiple without it; z is the median error in spread units,
  // so half the held-out peers land inside +-z. Calibrated on those same peers: indicative, not validated.
  function diagnostics(protocols) {
    var peers = comparables(protocols).peers;
    var n = peers.length;
    if (n < P.minCalibrationPeers) return { n: n, calibrated: false, z: P.rangeZ };
    var err = 0, errSector = 0, errGlobal = 0, t = [];
    peers.forEach(function (x) {
      var rest = protocols.map(function (p) {
        if (p.slug !== x.slug) return p;
        var q = {};
        Object.keys(p).forEach(function (k) { q[k] = p[k]; });
        q.mcap_usd = null;
        return q;
      });
      var c = comparables(rest), m = multipleFor(x.category, c), actual = Math.log(x.ratio);
      var e = Math.abs(actual - Math.log(m.ratio));
      err += e;
      errSector += Math.abs(actual - c.families[familyOf(x.category)].log);
      errGlobal += Math.abs(actual - c.global.log);
      t.push(e / m.sigma);
    });
    var z = Math.ceil(quantile(t, P.rangeCoverage) * 100) / 100;
    var inside = function (k) { return round4(t.filter(function (v) { return v <= k; }).length / n); };
    return {
      n: n, calibrated: true, z: z, coverage: inside(z), nominal_z: P.rangeZ, nominal_coverage: inside(P.rangeZ),
      z80: Math.ceil(quantile(t, 0.8) * 100) / 100,
      mae: round4(err / n), mae_sector: round4(errSector / n), mae_global: round4(errGlobal / n)
    };
  }

  // --- factors

  function momentumFactor(change7d) {
    if (change7d === null) return 1;
    return Math.sqrt(clamp(1 + change7d / 100, P.growthMin, P.growthMax));
  }

  // Under ~9 months tracked a protocol has not yet shown it lasts; ~9-30 months with no token recorded
  // is the usual launch window; past that, each year without one makes a launch less likely.
  function runwayFactor(days) {
    if (days === null) return P.runwayUnknown;
    if (days < 0) return 0.6;
    if (days <= P.rampDays) return 0.6 + 0.4 * days / P.rampDays;
    if (days <= P.plateauDays) return 1;
    return clamp(1 - P.fadeMax * (days - P.plateauDays) / P.fadeDays, 1 - P.fadeMax, 1);
  }

  function dayNumber(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5; }
  function daysBetween(from, to) { return from === null ? null : Math.round(dayNumber(to) - dayNumber(from)); }

  function value(p, comps, asOf) {
    var m = multipleFor(p.category, comps);
    var days = daysBetween(p.listed_at, asOf);
    var mom = momentumFactor(p.change_7d);
    var run = runwayFactor(days);
    var raw = p.tvl_usd * m.ratio * mom * run;
    var v = clamp(Math.round(raw), 1, P.maxValue);
    var spread = Math.exp(comps.z * m.sigma);
    return {
      implied_value_usd: v,
      low_usd: clamp(Math.min(v, sig2(raw / spread, -1)), 1, P.maxValue),
      high_usd: clamp(Math.max(v, sig2(raw * spread, 1)), 1, P.maxValue),
      multiple: round4(m.ratio), momentum: round4(mom), runway: round4(run), days_tracked: days,
      per_1k_tvl: round4(1000 * v / Math.max(1, p.tvl_usd)),
      peers: m
    };
  }

  // --- farm plans

  // Cost of one contract call in US dollars: a model assumption, not snapshot data; unknown chains say so.
  var GAS = {
    Ethereum: 4, Bitcoin: 2, Solana: 0.01, Base: 0.03, Arbitrum: 0.05, Optimism: 0.05, Polygon: 0.02, Binance: 0.1,
    BSC: 0.1, Avalanche: 0.1, Sui: 0.01, Aptos: 0.01, 'Hyperliquid L1': 0.01, Unichain: 0.03, Linea: 0.05,
    Scroll: 0.05, Sonic: 0.02, Berachain: 0.02, Mantle: 0.03, Blast: 0.03, Plasma: 0.01, Monad: 0.01, Ink: 0.03,
    Katana: 0.03, Stellar: 0.01, Tron: 1, Ton: 0.02, 'zkSync Era': 0.05, Starknet: 0.05, Sei: 0.01, Flare: 0.01
  };
  var GAS_DEFAULT = 0.5;
  var PLAN_TXS = 12; // contract calls a plan makes over a season, for the payoff check

  function money(x) {
    if (x < 1) return '$' + x.toFixed(2);
    return '$' + String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  // Large model figures are shown to 3 significant digits: more would be false precision.
  function compact(x) {
    var u = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];
    for (var i = 0; i < u.length; i++) if (x >= u[i][0]) return '$' + Number((x / u[i][0]).toPrecision(3)) + u[i][1];
    return money(x);
  }

  // Chains come only from the protocol's own record: the cheapest known one, and a gas range over all.
  function chainPlan(chains) {
    var known = chains.filter(function (c) { return GAS[c] !== undefined; });
    var pool = known.length ? known : chains;
    var cheapest = pool.slice().sort(function (a, b) { return (GAS[a] || GAS_DEFAULT) - (GAS[b] || GAS_DEFAULT) || (a < b ? -1 : 1); })[0];
    var costs = chains.map(function (c) { return GAS[c] === undefined ? GAS_DEFAULT : GAS[c]; });
    return {
      chains: chains, cheapest: cheapest || null, gas: cheapest ? (GAS[cheapest] === undefined ? GAS_DEFAULT : GAS[cheapest]) : GAS_DEFAULT,
      gasEstimated: !known.length, gasMax: costs.length ? Math.max.apply(null, costs) : GAS_DEFAULT
    };
  }

  function positionUsd(tvl) { return tvl >= 5e8 ? 5000 : tvl >= 5e7 ? 2000 : tvl >= 1e7 ? 1000 : 500; }

  // Actions a category supports; a feature it does not always have reads "if it offers ...".
  var PLAYBOOK_OF = {
    'Risk Curators': 'curated', 'Onchain Capital Allocator': 'allocator',
    Yield: 'vault', 'Yield Aggregator': 'vault', 'Liquidity Manager': 'vault', 'Leveraged Farming': 'vault', Farm: 'vault',
    Indexes: 'vault', 'Options Vault': 'vault', 'Governance Incentives': 'vault',
    'Basis Trading': 'basis', 'Staking Pool': 'staking', Restaking: 'staking',
    Lending: 'lending', 'Collateral Markets': 'lending', 'Uncollateralized Lending': 'credit',
    CDP: 'cdp', 'CDP Manager': 'cdp', 'Dual-Token Stablecoin': 'stable', 'Stablecoin Wrapper': 'stable',
    Dexs: 'dex', Derivatives: 'perps', 'Interest Rate Derivatives': 'rates', 'Prediction Market': 'prediction',
    RWA: 'rwa', CeDeFi: 'rwa', 'Anchor BTC': 'btc', 'Decentralized BTC': 'btc',
    Chain: 'chain', 'Cross Chain Bridge': 'bridge', Payments: 'payments', 'Crypto Card Issuer': 'payments', Insurance: 'insurance'
  };
  function playbookOf(p) {
    var b = (p.category !== null && PLAYBOOK_OF[p.category]) || 'general';
    return b === 'bridge' && p.chains.length < 2 ? 'general' : b;
  }

  // Points programs are never assumed: every plan defers to what step 1 found.
  function ifPoints(otherwise) { return 'If step 1 found a points program, follow how it scores; otherwise ' + otherwise + '.'; }

  // Two action steps per playbook: (where, size, tx cost) -> [step, step].
  var ACTIONS = {
    curated: function (w, s, tx) { return [
      'Find a vault it curates in its docs (curated vaults usually sit on another protocol’s lending markets), deposit a ' + money(Math.min(100, s)) + ' test on ' + w + ', and withdraw ' + money(10) + ' to prove the exit before adding the rest of ' + money(s) + '. Cost: about ' + tx(4) + ' in gas. Time: 15 minutes.',
      ifPoints('hold 8-12 weeks for the vault yield alone, comparing its vaults’ net APY monthly') + ' Cost: the vault fee, typically 0-15% of yield. Time: 5 minutes a week.']; },
    allocator: function (w, s, tx) { return [
      'Check whether it takes outside deposits at all: many allocators deploy only their own or a partner’s capital. If its app offers a public vault on ' + w + ', deposit a ' + money(Math.min(100, s)) + ' test and prove the exit; if not, skip it, as there is nothing to farm directly. Cost: about ' + tx(4) + ' in gas. Time: 20 minutes.',
      'If you deposited, scale to at most ' + money(s) + ' and confirm monthly that the vault is open and its fees unchanged. ' + ifPoints('the vault yield is the only return') + ' Cost: the vault fee. Time: 5 minutes a month.']; },
    vault: function (w, s, tx) { return [
      'Deposit a ' + money(Math.min(100, s)) + ' test into its largest strategy on ' + w + ', confirm the receipt token and the withdrawal path, then add the rest of ' + money(s) + '. Cost: about ' + tx(3) + ' in gas. Time: 10 minutes.',
      ifPoints('hold at least 8 weeks for the strategy yield alone') + ' Cost: the strategy’s fees, typically 0-20% of yield. Time: 5 minutes a week.']; },
    basis: function (w, s, tx) { return [
      'Deposit ' + money(s) + ' of stablecoins into its delta-neutral (basis) product on ' + w + ', after reading how it handles negative funding and how long redemptions take. Cost: about ' + tx(3) + ' in gas. Time: 15 minutes.',
      'Check the yield weekly; exit if the product pauses or redemptions queue. ' + ifPoints('the yield is the only return') + ' Cost: performance fee, typically 10-20% of yield. Time: 5 minutes a week.']; },
    staking: function (w, s, tx) { return [
      'Stake ' + money(s) + ' of the asset it accepts on ' + w + ', noting the unbonding period before you start. Cost: about ' + tx(2) + ' in gas. Time: 10 minutes, plus the unbonding period when you exit.',
      'Keep the stake 8-12 weeks and claim any rewards it pays monthly. ' + ifPoints('the staking yield is the only return') + ' Cost: ' + tx(1) + ' per claim. Time: 5 minutes a month.']; },
    lending: function (w, s, tx) { return [
      'Supply ' + money(s) + ' of a stablecoin to one of its markets on ' + w + '. Only if that market allows borrowing, borrow at most 25% and keep the health factor above 2. Cost: about ' + tx(4) + ' in gas plus any borrow rate. Time: 15 minutes.',
      ifPoints('hold for the supply rate alone') + ' Repay any loan before you withdraw. Cost: borrow interest, about 0.5-1% of the loan a month. Time: 5 minutes a week.']; },
    credit: function (w, s, tx) { return [
      'Check the lender requirements (many credit pools need KYC or accreditation), then supply ' + money(s) + ' to one of its pools on ' + w + '. Borrowing here is for vetted borrowers, so farm as a lender only. Cost: about ' + tx(3) + ' in gas. Time: 1-3 days for onboarding.',
      'Hold to the pool’s term and read its default and withdrawal-queue rules first; credit pools can lock funds. Cost: none beyond gas. Time: 8-12 weeks.']; },
    cdp: function (w, s, tx) { return [
      'Deposit ' + money(s) + ' of accepted collateral on ' + w + ' and mint its stablecoin at no more than 40% of the maximum, so a 30% price drop does not liquidate you. Cost: about ' + tx(4) + ' in gas plus the stability fee. Time: 15 minutes.',
      'If it offers a savings or stability pool, put the minted stablecoin there; check the collateral ratio weekly. Cost: stability fee, typically 1-8% a year on the debt. Time: 5 minutes a week, for 8-12 weeks.']; },
    stable: function (w, s, tx) { return [
      'Get ' + money(s) + ' of its stablecoin on ' + w + ' by minting it in its own app or buying it, checking the peg on its page first. Cost: about ' + tx(3) + ' in gas plus any mint fee. Time: 10 minutes.',
      'If it offers a savings or staking module, hold the stablecoin there for 8-12 weeks. Exit if the peg moves more than 1%. Cost: none beyond gas. Time: 5 minutes a week.']; },
    dex: function (w, s, tx) { return [
      'Swap ' + money(Math.min(200, s)) + ' through it a few times in different weeks, then add ' + money(s) + ' of liquidity to a major pair on ' + w + ' (a stable pair keeps impermanent loss low). Cost: swap fees of 0.05-0.3% plus ' + tx(6) + ' in gas. Time: 20 minutes.',
      'Keep the liquidity in range. ' + ifPoints('the trading fees you earn are the only return') + ' Cost: ' + tx(2) + ' per adjustment. Time: 10 minutes a week, for 8+ weeks.']; },
    perps: function (w, s, tx) { return [
      'Deposit ' + money(Math.min(1000, s)) + ' as margin on ' + w + ' and trade small, at 2x leverage at most, or hedged, so volume builds without large directional risk. Cost: taker fees of about 0.03-0.06% of notional plus funding. Time: 15 minutes.',
      'If it offers a liquidity vault, keep spare margin there. ' + ifPoints('trading only costs fees') + ' Cost: budget about ' + money(Math.max(10, s * 0.01)) + ' a month in fees. Time: 10 minutes a day, for 8+ weeks.']; },
    rates: function (w, s, tx) { return [
      'Buy a fixed-yield position (or provide liquidity to a rate market) with ' + money(s) + ' on ' + w + ', choosing a maturity after 8-12 weeks. Cost: about ' + tx(3) + ' in gas plus 0.1-0.3% trading fees. Time: 20 minutes.',
      'Hold to maturity or roll it. ' + ifPoints('the fixed yield is the return') + ' Cost: ' + tx(2) + ' per roll. Time: 5 minutes a week.']; },
    prediction: function (w, s, tx) { return [
      'Fund ' + money(Math.min(500, s)) + ' on ' + w + ' and take small positions across several markets you understand, rather than one large bet. Cost: trading fees and spread, about 1-2% of volume. Time: 20 minutes.',
      'If it rewards market makers, provide liquidity to a market. Positions can go to zero. ' + ifPoints('expect to pay the spread') + ' Cost: spread on volume. Time: 10 minutes a day, for 8+ weeks.']; },
    rwa: function (w, s, tx) { return [
      'Check eligibility first: real-world-asset products often need KYC and exclude some countries. If you qualify, subscribe ' + money(s) + ' to its main product on ' + w + '. Cost: about ' + tx(3) + ' in gas plus the management fee. Time: 1-3 days.',
      'Hold to the product’s term, noting any lock-up or redemption delay first. ' + ifPoints('its yield is the return') + ' Cost: management fee, typically 0.1-1% a year. Time: 8-12 weeks.']; },
    btc: function (w, s, tx) { return [
      'If it mints a BTC token, deposit ' + money(s) + ' of BTC (or the BTC token it accepts) on ' + w + ', checking the redemption path back to BTC first. Cost: about ' + tx(3) + ' in gas plus any mint fee. Time: 20 minutes, longer for a native BTC deposit.',
      'If it offers a yield option for that token, use it for 8-12 weeks. ' + ifPoints('that yield is the return') + ' Cost: none beyond gas. Time: 5 minutes a week.']; },
    chain: function (w, s, tx) { return [
      'Bridge ' + money(Math.min(500, s)) + ' to ' + w + ' with the bridge its docs recommend, then use two or three apps built on it (a swap, a deposit, a mint) on different days. Cost: bridge fee plus ' + tx(6) + ' in gas. Time: 30 minutes.',
      'Use it monthly for things you need anyway. ' + ifPoints('activity alone earns nothing') + ' Cost: ' + tx(5) + ' a session. Time: 15 minutes a month, for 3+ months.']; },
    bridge: function (w, s, tx) { return [
      'Move ' + money(Math.min(200, s)) + ' through it between two chains its record lists (' + w + '), then back, on different days. Cost: its bridge fee plus ' + tx(4) + ' in gas. Time: 15 minutes a transfer.',
      'Use it for transfers you need anyway. ' + ifPoints('activity alone earns nothing') + ' Cost: about ' + tx(4) + ' a month. Time: 15 minutes a month, for 3+ months.']; },
    payments: function (w, s, tx) { return [
      'Open an account or card with it, completing any KYC it requires, and fund ' + money(Math.min(300, s)) + ' on ' + w + '. Cost: any card or top-up fee. Time: 1-2 days.',
      'Use it for spending you would do anyway. ' + ifPoints('any cashback it offers is the only return') + ' Cost: FX or top-up fees. Time: a few minutes a week, for 3+ months.']; },
    insurance: function (w, s, tx) { return [
      'Buy cover on a protocol you already use, or, if it offers underwriting pools, underwrite ' + money(s) + ' on ' + w + ' after reading the claims rules. Cost: the premium (cover) or ' + tx(3) + ' in gas (underwriting). Time: 15 minutes.',
      'Hold the cover or the underwriting position for its term (often 30-90 days). ' + ifPoints('the premium or underwriting yield is the return') + ' Cost: the premium. Time: 5 minutes a month.']; },
    general: function (w, s, tx) { return [
      'Make a first ' + money(Math.min(100, s)) + ' deposit or trade in its main product on ' + w + ', confirm you can exit, then scale to ' + money(s) + '. Cost: about ' + tx(4) + ' in gas. Time: 15 minutes.',
      'Keep using it on different days for 8+ weeks. ' + ifPoints('the product’s own yield or utility is the only return') + ' Cost: ' + tx(1) + ' per use. Time: 5 minutes a week.']; }
  };

  // Payoff illustration (not a forecast): the share of the implied value a position would get only if a
  // token launched, against the gas the plan spends.
  function payoff(p, val) {
    var c = chainPlan(p.chains), size = positionUsd(p.tvl_usd);
    var reward = size * P.userShare * val.implied_value_usd / Math.max(1, p.tvl_usd);
    return { size: size, reward: reward, gas: c.gas * PLAN_TXS, belowGas: reward < c.gas * PLAN_TXS };
  }

  function farmSteps(p, tier, val) {
    var c = chainPlan(p.chains);
    var size = positionUsd(p.tvl_usd);
    var tx = function (n) { return money(c.gas * n); };
    var where = p.chains.length === 0 ? 'the chain its app names' : p.chains.length === 1 ? p.chains[0] : 'your chosen chain';
    var listed = p.chains.length > 6 ? p.chains.slice(0, 6).join(', ') + ' and ' + (p.chains.length - 6) + ' more' : p.chains.join(', ');
    var gasNote = c.gasEstimated ? ' (estimated: this model has no gas reference for ' + c.cheapest + ')' : '';
    var steps = [
      'Verify first: open ' + p.name + '’s app from its DefiLlama page (slug ' + p.slug + '), confirm the contract addresses in its docs, and look for an official points or rewards program. Its DefiLlama record shows no token, which is not proof it has none; without an announced program, any future reward is speculation. Cost: free. Time: 15 minutes.',
      p.chains.length > 1
        ? 'Pick a chain from those its record lists (' + listed + '). The cheapest of them to use is ' + c.cheapest + ' at about ' + money(c.gas) + ' a transaction' + gasNote + '; the dearest about ' + money(c.gasMax) + '. Prefer the one where its app shows the deepest vault or pool, as a deposit-based program would count it there. Fund a fresh wallet with ' + money(size) + ' plus ' + tx(10) + ' for gas. Cost: about ' + money(Math.max(1, size * 0.001)) + ' in transfer fees. Time: 10-30 minutes.'
        : 'Fund a fresh wallet on ' + where + ' with ' + money(size) + ' plus ' + tx(10) + ' for gas' + gasNote + '. Cost: about ' + money(Math.max(1, size * 0.001)) + ' in transfer fees. Time: 10-30 minutes.'
    ];
    var pb = playbookOf(p);
    steps = steps.concat(ACTIONS[pb](pb === 'bridge' ? listed : where, size, tx));
    var pay = payoff(p, val);
    steps.push('Payoff illustration, not a forecast: only if a token launched and ' + Math.round(P.userShare * 100) + '% of the ' + compact(val.implied_value_usd) + ' implied value went to users pro rata would ' + money(size) + ' get about ' + money(pay.reward) + ', against roughly ' + money(pay.gas) + ' in gas. ' +
      (pay.belowGas ? 'That does not even cover the gas: on these numbers it is not worth farming for a token at this size. ' : '') + 'Cost: free. Time: 5 minutes.');
    steps.push('Track it: log each deposit, transaction hash and date. Exit if TVL falls more than 30% in a week, a security incident is reported, or the team says no token is planned. Cost: free. Time: 5 minutes a week.');
    if (tier === 'derivative') steps.push('Caution: this looks like a wrapper, bridge or custody product of a token that already trades (' + derivativeReason(p) + '), so any reward may come from the parent project rather than a new token. Cost: free. Time: 5 minutes.');
    return steps;
  }

  // --- the board

  function byValue(a, b) {
    return b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  }

  function build(snapshot, minRows) {
    minRows = minRows || 100;
    var watch = {};
    snapshot.watchlist.forEach(function (s) { watch[s] = true; });
    var comps = comparables(snapshot.protocols);
    var diag = diagnostics(snapshot.protocols);
    comps.z = diag.z;
    var tiers = {};
    snapshot.protocols.forEach(function (p) { tiers[p.slug] = tierOf(p, watch); });

    var members = snapshot.protocols.filter(function (p) { return tiers[p.slug] === 'watchlist' || tiers[p.slug] === 'early'; });
    if (members.length < minRows) {
      members = members.concat(snapshot.protocols.filter(function (p) { return tiers[p.slug] === 'derivative'; })
        .sort(function (a, b) { return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1); })
        .slice(0, minRows - members.length));
    }
    var board = members.map(function (p) {
      var v = value(p, comps, snapshot.as_of);
      return {
        rank: 0, slug: p.slug, name: p.name, implied_value_usd: v.implied_value_usd, tier: tiers[p.slug],
        category: p.category, family: v.peers.family, chains: p.chains.slice(), tvl_usd: p.tvl_usd, change_7d: p.change_7d,
        listed_at: p.listed_at, valuation: v, playbook: playbookOf(p), payoff_below_gas: payoff(p, v).belowGas,
        farm_steps: farmSteps(p, tiers[p.slug], v)
      };
    }).sort(byValue).slice(0, 4000);
    board.forEach(function (r, i) { r.rank = i + 1; });

    var trading = snapshot.protocols.filter(function (p) { return tiers[p.slug] === 'trading'; }).map(function (p) {
      var priced = p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
      return { slug: p.slug, name: p.name, symbol: p.symbol, category: p.category, family: familyOf(p.category), tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, mcap_to_tvl: priced ? round4(p.mcap_usd / p.tvl_usd) : null };
    }).sort(function (a, b) { return (b.mcap_usd || -1) - (a.mcap_usd || -1) || (a.slug < b.slug ? -1 : 1); });

    var count = function (t) { return snapshot.protocols.filter(function (p) { return tiers[p.slug] === t; }).length; };
    return {
      model: 'radar-model/1.1', params: P, as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
      counts: { protocols: snapshot.protocols.length, watchlist: snapshot.watchlist.length, board: board.length, early: count('early'), derivative: count('derivative'), trading: count('trading'), priced_peers: comps.global.n },
      diagnostics: diag,
      comparables: {
        global: { ratio: round4(Math.exp(comps.global.log)), n: comps.global.n, sigma: round4(comps.global.sigma) },
        winsor: { low: round4(comps.winsor.low), high: round4(comps.winsor.high) },
        families: Object.keys(comps.families).map(function (f) { var x = comps.families[f]; return { family: f, n: x.n, raw: x.rawLog === null ? null : round4(Math.exp(x.rawLog)), pooled: round4(Math.exp(x.log)) }; }),
        categories: Object.keys(comps.categories).map(function (c) { var x = comps.categories[c]; return { category: c, family: familyOf(c === '(none)' ? null : c), n: x.n, raw: round4(Math.exp(x.rawLog)), pooled: round4(Math.exp(x.log)) }; })
      },
      board: board, trading: trading
    };
  }

  return {
    P: P, FAMILIES: FAMILIES, GAS: GAS, build: build, comparables: comparables, multipleFor: multipleFor, value: value,
    diagnostics: diagnostics, momentumFactor: momentumFactor, runwayFactor: runwayFactor, daysBetween: daysBetween, tierOf: tierOf,
    derivativeReason: derivativeReason, recordsToken: recordsToken, familyOf: familyOf, playbookOf: playbookOf,
    chainPlan: chainPlan, farmSteps: farmSteps, payoff: payoff, money: money, compact: compact, sig2: sig2, quantile: quantile, median: median
  };
})();
