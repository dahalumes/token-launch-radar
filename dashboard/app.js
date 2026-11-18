// Token Launch Radar page: renders window.RADAR (../data.js) and re-runs model.js on the snapshot as a
// consistency check (reproducibility, not accuracy). It computes no valuation: risk notes and the farm label
// read fields model.js wrote. Views: #/ board (filters in the query), #/p/<slug>, #/trading, #/method.
(function () {
  'use strict';
  var R = window.RADAR, M = window.RadarModel, view = document.getElementById('view');
  if (!R) { view.innerHTML = '<p class="empty">No data: data.js was not found beside the dashboard.</p>'; return; }
  var D = R.diagnostics || { z: 0.674, n: 0 }, P = R.params;
  var TIER = { watchlist: 'Watchlist', early: 'Early', derivative: 'Derivative' };
  var KYC = { rwa: 1, credit: 1, payments: 1 };
  var COLS = [['rank', '#', 1], ['name', 'Protocol'], ['tier', 'Tier'], ['implied_value_usd', 'Implied value (est.)', 1],
    ['range', 'Indicative range', 1], ['support', 'Peer support'], ['farm', 'Farm'], ['tvl_usd', 'TVL', 1],
    ['change_7d', '7d', 1, 1], ['days', 'Days tracked', 1, 1], ['chains', 'Chains', 1, 1]];
  var FILTERS = [['tier', 'Tier', 'All tiers'], ['fam', 'Sector', 'All sectors'], ['cat', 'Category', 'All categories'],
    ['chain', 'Chain', 'All chains'], ['sup', 'Peer support', 'Any peer support'], ['min', 'Minimum TVL, $M', 'Any TVL']];

  // ------------------------------------------------------------ consistency check: recompute the board here
  var check = (function () {
    if (!M || !window.RADAR_INPUT) return { ok: false, text: 'unavailable: model.js or the snapshot did not load.' };
    var again = M.build(window.RADAR_INPUT), want = {}, same = 0;
    again.board.forEach(function (r) { want[r.slug] = r.implied_value_usd + ':' + r.rank; });
    R.board.forEach(function (r) { if (want[r.slug] === r.implied_value_usd + ':' + r.rank) same++; });
    return { ok: same === R.board.length && again.board.length === R.board.length, same: same };
  })();

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function money(x) {
    if (x === null || x === undefined) return '–';
    var u = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (var i = 0; i < u.length; i++) if (Math.abs(x) >= u[i][0]) return '$' + Number((x / u[i][0]).toPrecision(3)) + u[i][1];
    return '$' + Math.round(x);
  }
  function pct(x) {
    if (x === null || x === undefined) return '<span class="muted">–</span>';
    return '<span class="' + (x > 0 ? 'up' : x < 0 ? 'down' : '') + '">' + (x > 0 ? '+' : '') + x.toFixed(1) + '%</span>';
  }
  function x(n) { return n === null || n === undefined ? '–' : n.toFixed(n < 0.1 ? 4 : 3) + '×'; }
  function tag(cls, text) { return '<span class="tag tag-' + esc(cls) + '">' + esc(text) + '</span>'; }
  function farmTag(r) { return r.payoff_below_gas ? tag('low', 'below gas') : tag('ok', 'covers gas'); }

  // Range bar on one log scale for the whole board, so widths compare across rows.
  var LO = Math.log(Math.min.apply(null, R.board.map(function (r) { return r.valuation.low_usd; })) || 1);
  var HI = Math.log(Math.max.apply(null, R.board.map(function (r) { return r.valuation.high_usd; })) || 2);
  function at(v) { return (100 * (Math.log(v) - LO) / (HI - LO || 1)).toFixed(1) + '%'; }
  function bar(v) {
    return '<div class="range" role="img" aria-label="Indicative range ' + money(v.low_usd) + ' to ' + money(v.high_usd) + ', estimate ' + money(v.implied_value_usd) + '">' +
      '<i style="left:' + at(v.low_usd) + ';right:calc(100% - ' + at(v.high_usd) + ')"></i><b style="left:' + at(v.implied_value_usd) + '"></b></div>';
  }

  // Plain-language cautions, each read from a field model.js wrote; none changes a value.
  function risks(r) {
    var v = r.valuation, p = v.peers, out = [];
    if (p.support === 'thin') out.push('Thin peer evidence (under ' + P.minSpreadPeers + ' priced peers in its category or sector): a wide range.');
    if (p.note) out.push(p.note);
    if (r.payoff_below_gas) out.push('The payoff illustration does not cover the plan’s gas at the suggested size.');
    if (r.change_7d !== null && r.change_7d <= -10) out.push('TVL fell ' + Math.abs(r.change_7d).toFixed(1) + '% in the last 7 days.');
    if (v.days_tracked === null) out.push('No listing date in the snapshot, so its runway is assumed.');
    else if (v.days_tracked > P.plateauDays) out.push(v.days_tracked + ' days with no token recorded: the runway factor is fading.');
    if (KYC[r.playbook]) out.push('Its category often requires KYC or accreditation.');
    if (r.tier === 'derivative') out.push('Looks like a wrapper, bridge or custody product of a token that already trades.');
    return out;
  }

  function cell(r, k) {
    var v = r.valuation;
    return k === 'days' ? v.days_tracked : k === 'chains' ? r.chains.length : k === 'range' ? v.high_usd / v.low_usd :
      k === 'support' ? { strong: 3, moderate: 2, thin: 1 }[v.peers.support] : k === 'farm' ? (r.payoff_below_gas ? 0 : 1) : r[k];
  }

  // ------------------------------------------------------------ routing
  function parseHash() {
    var h = location.hash.replace(/^#/, '') || '/', q = {}, i = h.indexOf('?');
    if (i >= 0) {
      h.slice(i + 1).split('&').forEach(function (kv) {
        var j = kv.indexOf('=');
        if (kv) q[decodeURIComponent(j < 0 ? kv : kv.slice(0, j))] = j < 0 ? '' : decodeURIComponent(kv.slice(j + 1));
      });
      h = h.slice(0, i);
    }
    return { path: h, q: q };
  }
  function go(q) {
    var s = Object.keys(q).filter(function (k) { return q[k]; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); });
    location.hash = '#/' + (s.length ? '?' + s.join('&') : '');
  }
  function on(sel, ev, fn) { view.querySelectorAll(sel).forEach(function (el) { el.addEventListener(ev, fn); }); }

  function chrome(active) {
    document.querySelectorAll('.tabs a').forEach(function (a) {
      if (a.getAttribute('data-view') === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var c = R.counts;
    document.getElementById('kpis').innerHTML = [[c.board, 'pre-token protocols ranked'], [c.watchlist + '/' + c.watchlist, 'watchlist covered'],
      [c.early, 'early finds below the floor'], [c.priced_peers, 'priced peers set the multiples'],
      [check.ok ? '✓ ' + c.board : '✗', 'values reproducible in-browser']].map(function (k) { return '<span><b>' + k[0] + '</b>' + k[1] + '</span>'; }).join('');
    document.getElementById('sub').textContent = 'Protocols whose DefiLlama record shows no token, ranked by a model estimate · snapshot ' + R.as_of;
    document.getElementById('foot').textContent = R.source + ' · ' + R.model + ' · Implied values are model estimates, not market prices or launch predictions.';
  }

  // ------------------------------------------------------------ board
  function uniq(list) { var o = {}; list.forEach(function (v) { if (v) o[v] = 1; }); return Object.keys(o).sort(); }
  var CHOICES = {
    tier: ['watchlist', 'early', 'derivative'], fam: uniq(R.board.map(function (r) { return r.family; })),
    cat: uniq(R.board.map(function (r) { return r.category; })), chain: uniq([].concat.apply([], R.board.map(function (r) { return r.chains; }))),
    sup: ['strong', 'moderate', 'thin'], min: ['10', '50', '100', '500']
  };

  function cards() {
    return '<h2 class="section">Top opportunities by implied value</h2><div class="cards">' + R.board.slice(0, 3).map(function (r) {
      var v = r.valuation, k = risks(r);
      return '<a class="card" href="#/p/' + encodeURIComponent(r.slug) + '"><span class="rk">#' + r.rank + '</span><strong>' + esc(r.name) + '</strong> <span class="muted">' + esc(r.category || '') + '</span>' +
        '<span class="big">' + money(r.implied_value_usd) + '</span>' + bar(v) + '<div class="ends"><span>' + money(v.low_usd) + '</span><span>indicative range</span><span>' + money(v.high_usd) + '</span></div>' +
        '<div class="meta">' + tag(r.tier, TIER[r.tier]) + tag(v.peers.support, v.peers.support + ' peer support') + farmTag(r) + '</div>' +
        (k.length ? '<p class="risk">⚠ ' + esc(k[0]) + '</p>' : '') + '</a>';
    }).join('') + '</div>';
  }

  function board(q) {
    chrome('board');
    var key = q.sort || 'rank', dir = q.dir || (key === 'rank' || key === 'name' ? 'asc' : 'desc'), sign = dir === 'asc' ? 1 : -1;
    var text = (q.q || '').toLowerCase(), min = Number(q.min || 0) * 1e6;
    var active = FILTERS.filter(function (f) { return q[f[0]]; }).concat(q.q ? [['q', 'Search']] : []);
    var rows = R.board.filter(function (r) {
      return (!q.tier || r.tier === q.tier) && (!q.fam || r.family === q.fam) && (!q.cat || r.category === q.cat) &&
        (!q.chain || r.chains.indexOf(q.chain) >= 0) && (!q.sup || r.valuation.peers.support === q.sup) &&
        (!min || r.tvl_usd >= min) && (!text || (r.name + ' ' + r.slug).toLowerCase().indexOf(text) >= 0);
    }).sort(function (a, b) {
      var u = cell(a, key), v = cell(b, key);
      if (u === null) return 1;
      if (v === null) return -1;
      return (typeof u === 'string' ? sign * u.localeCompare(v) : sign * (u - v)) || a.rank - b.rank;
    });
    var head = COLS.map(function (c) {
      return '<th scope="col"' + (c[2] ? ' class="num' + (c[3] ? ' opt' : '') + '"' : '') + ' aria-sort="' + (c[0] === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none') + '"><button data-key="' + c[0] + '">' + c[1] + '</button></th>';
    }).join('');
    var body = rows.map(function (r) {
      var v = r.valuation;
      return '<tr data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '</td>' +
        '<td><a href="#/p/' + encodeURIComponent(r.slug) + '">' + esc(r.name) + '</a><span class="cat">' + esc(r.category || 'uncategorised') + '</span></td>' +
        '<td>' + tag(r.tier, TIER[r.tier]) + '</td><td class="num value">' + money(r.implied_value_usd) + '</td>' +
        '<td class="num">' + bar(v) + '<span class="muted">' + money(v.low_usd) + '–' + money(v.high_usd) + '</span></td>' +
        '<td>' + tag(v.peers.support, v.peers.support) + '</td><td>' + farmTag(r) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td><td class="num opt">' + pct(r.change_7d) + '</td>' +
        '<td class="num opt">' + (v.days_tracked === null ? '–' : v.days_tracked) + '</td><td class="num opt">' + r.chains.length + '</td></tr>';
    }).join('');
    view.innerHTML = (active.length ? '' : cards()) + '<h2 class="section">The board</h2><div class="filters" role="search">' +
      '<input type="search" id="f-q" aria-label="Search protocols (press Enter)" placeholder="Search protocol, Enter" value="' + esc(q.q || '') + '">' +
      FILTERS.map(function (f) {
        return '<select data-f="' + f[0] + '" aria-label="' + f[1] + '"><option value="">' + f[2] + '</option>' + CHOICES[f[0]].map(function (v) {
          return '<option' + (v === q[f[0]] ? ' selected' : '') + ' value="' + esc(v) + '">' + esc(f[0] === 'min' ? '≥ $' + v + 'M TVL' : v) + '</option>';
        }).join('') + '</select>';
      }).join('') +
      '<button class="ghost" data-reset>Reset</button><span class="count" aria-live="polite">' + rows.length + ' of ' + R.board.length + ' shown</span></div>' +
      (active.length ? '<div class="chips">' + active.map(function (f) { return '<button class="chip" data-drop="' + f[0] + '" aria-label="Remove filter ' + esc(f[1]) + '">' + esc(f[1]) + ': ' + esc(q[f[0]]) + ' ×</button>'; }).join('') + '</div>' : '') +
      '<p class="check' + (check.ok ? '' : ' bad') + '"><b>' + (check.ok ? '✓' : '✗') + ' Consistency check:</b> ' + (check.text || (check.ok ? 'all ' : 'only ') + check.same + ' of ' + R.board.length +
        ' implied values and ranks, recomputed here by model.js from the ' + window.RADAR_INPUT.protocols.length + '-protocol snapshot, match board.json: the figures are reproducible from the code, which is not to say they are accurate.') + '</p>' +
      (rows.length ? '<div class="wrap"><table class="table"><caption class="sr">Protocols ranked by implied value; select a column to sort.</caption><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>'
        : '<div class="empty"><p>No protocol matches these filters.</p><button class="ghost" data-reset>Clear all filters</button></div>');

    function set(k, val) { var n = Object.assign({}, q); n[k] = val; go(n); }
    on('select[data-f]', 'change', function (e) { set(e.target.getAttribute('data-f'), e.target.value); });
    on('#f-q', 'keydown', function (e) { if (e.key === 'Enter') set('q', e.target.value); });
    on('[data-reset]', 'click', function () { go({}); });
    on('[data-drop]', 'click', function (e) { set(e.currentTarget.getAttribute('data-drop'), ''); });
    on('th button', 'click', function (e) {
      var k = e.currentTarget.getAttribute('data-key'), n = Object.assign({}, q);
      n.sort = k; n.dir = k === key ? (dir === 'asc' ? 'desc' : 'asc') : (k === 'name' || k === 'rank' ? 'asc' : 'desc');
      go(n);
    });
    on('tbody tr', 'click', function (e) { if (e.target.tagName !== 'A') location.hash = '#/p/' + encodeURIComponent(e.currentTarget.getAttribute('data-slug')); });
  }

  // ------------------------------------------------------------ detail
  function line(label, val, cls) { return '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + label + '</span><span class="num' + (cls ? ' ' + cls : '') + '">' + val + '</span>'; }

  function detail(slug) {
    chrome('board');
    var r = R.board.filter(function (b) { return b.slug === slug; })[0];
    if (!r) { view.innerHTML = '<div class="empty"><p>No protocol “' + esc(slug) + '” on this board.</p><a class="back" href="#/">← Back to the radar</a></div>'; return; }
    var v = r.valuation, p = v.peers, k = risks(r);
    var evidence = (p.category_peers ? esc(r.category) + ': ' + p.category_peers + ' priced peer' + (p.category_peers > 1 ? 's' : '') + ', median ' + x(p.category_raw) + ', weight ' + Math.round(100 * p.category_weight) + '%. ' : esc(r.category || 'Uncategorised') + ': no priced peer. ') +
      'Sector ' + esc(p.family) + ': ' + p.family_peers + ' peers' + (p.family_raw === null ? '' : ', median ' + x(p.family_raw)) + '. All priced tokens: ' + p.global_peers + ', median ' + x(p.global_ratio) + '.';
    view.innerHTML = '<a class="back" href="#/">← Back to the radar</a><div class="detail"><div class="card">' +
      '<h2>' + esc(r.name) + '</h2>' + tag(r.tier, TIER[r.tier]) + ' ' + tag(p.support, p.support + ' peer support') + ' ' + farmTag(r) +
      '<h3>Model estimate · rank #' + r.rank + ' of ' + R.board.length + '</h3><div class="equation">' +
      line('TVL (snapshot)', money(r.tvl_usd)) + line('× peer multiple (' + esc(p.basis) + ')', x(v.multiple)) +
      line('× momentum √(7d growth ' + (r.change_7d === null ? 'n/a' : r.change_7d.toFixed(1) + '%') + ')', v.momentum.toFixed(3)) +
      line('× runway (' + (v.days_tracked === null ? 'unknown age' : v.days_tracked + ' days, no token recorded') + ')', v.runway.toFixed(3)) +
      line('Implied value', money(r.implied_value_usd), 'total') + '</div>' + bar(v) +
      '<div class="ends"><span>' + money(v.low_usd) + '</span><span>indicative range ±' + D.z + 'σ (σ ' + p.sigma.toFixed(1) + ')</span><span>' + money(v.high_usd) + '</span></div>' +
      '<h3>Risks to weigh</h3>' + (k.length ? '<ul class="risks">' + k.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '<p class="muted">No flags beyond the model’s general uncertainty.</p>') +
      '<h3>Snapshot facts</h3><dl class="facts"><dt>Category</dt><dd>' + esc(r.category || 'uncategorised') + ' (sector: ' + esc(p.family) + ')</dd>' +
      '<dt>Chains</dt><dd>' + esc(r.chains.join(', ') || '–') + '</dd><dt>Tracked since</dt><dd>' + esc(r.listed_at || 'unknown') + '</dd></dl>' +
      '<p class="note">' + evidence + ' Range: ' + Math.round(100 * (D.coverage || 0.5)) + '% of ' + D.n +
      ' held-out priced peers fell inside; indicative, not a validated forecast, and blind to the momentum, runway and launch assumptions.</p></div>' +
      '<div class="card"><h3>Farm plan · ' + esc(r.playbook) + ' playbook</h3><ol class="steps">' + r.farm_steps.map(function (s) {
        var m = s.match(/^(.*?)\s*Cost: (.*?)\s*Time: (.*?)\.?$/);
        return '<li>' + (m ? esc(m[1]) + '<span class="ct"><span>Cost: ' + esc(m[2].replace(/\.$/, '')) + '</span><span>Time: ' + esc(m[3]) + '</span></span>' : esc(s)) + '</li>';
      }).join('') + '</ol></div></div>';
  }

  // ------------------------------------------------------------ peers and method
  function table(head, rows, label) {
    return '<div class="wrap"><table class="table"><caption class="sr">' + label + '</caption><thead><tr>' + head.map(function (h, i) { return '<th scope="col"' + (i ? ' class="num"' : '') + '>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (i ? ' class="num"' : '') + '>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }

  function trading() {
    chrome('trading');
    var C = R.comparables;
    view.innerHTML = '<div class="card prose"><h3>Tokens that already trade</h3><p>' + R.counts.trading + ' protocols record a token and stay off the radar. The market caps of ' +
      C.global.n + ' are snapshot facts; their market cap / TVL is the evidence behind the multiples.</p></div>' +
      '<div class="grid2">' + table(['Sector', 'Peers', 'Median', 'Pooled'], C.families.map(function (f) { return [esc(f.family), f.n, x(f.raw), x(f.pooled)]; }), 'Sector multiples') +
      '<p class="note">Sector medians are pooled with all priced tokens’ (' + x(C.global.ratio) + '); each protocol’s page shows its category evidence.</p></div>' +
      table(['Protocol', 'Symbol', 'TVL', 'Market cap (fact)', 'mcap / TVL'], R.trading.slice(0, 40).map(function (t) {
        return [esc(t.name) + '<span class="cat">' + esc(t.category || '') + '</span>', esc(t.symbol || '–'), money(t.tvl_usd), money(t.mcap_usd), x(t.mcap_to_tvl)];
      }), 'Largest protocols whose token trades');
  }

  function method() {
    chrome('method');
    var C = R.comparables, stat = function (b, s) { return '<div><b>' + b + '</b>' + s + '</div>'; };
    view.innerHTML = '<div class="card prose"><h3>How an implied value is built</h3><p><code>implied value = TVL × peer multiple × momentum × runway</code>, by <code>value()</code> in model.js, from the snapshot alone; no protocol is named in the model.</p><ul>' +
      '<li><b>Peer multiple.</b> Market cap / TVL of ' + C.global.n + ' priced tokens, clipped to ' + x(C.winsor.low) + '–' + x(C.winsor.high) + '; a category’s log-median is pooled with its sector’s (weight n / (n + ' + P.kCategory + ')), a sector’s with all tokens’ (n / (n + ' + P.kFamily + ')). Curators and allocators are a sector of their own: their TVL is capital managed inside other protocols’ markets.</li>' +
      '<li><b>Momentum.</b> √ of the 7-day TVL growth factor, the factor clipped to ' + P.growthMin + '–' + P.growthMax + '.</li>' +
      '<li><b>Runway.</b> Days tracked with no token recorded: rises to 1 over ' + P.rampDays + ' days, holds to ' + P.plateauDays + ', then fades by up to ' + Math.round(P.fadeMax * 100) + '%; unknown age counts ' + P.runwayUnknown + '.</li>' +
      '<li><b>Indicative range.</b> ±z robust spreads (σ) of the peers’ log multiples, z from <code>diagnostics()</code>. Support: strong with ≥' + P.minSpreadPeers + ' category peers, moderate with ≥' + P.minSpreadPeers + ' sector peers, else thin.</li>' +
      '<li><b>Farm plans.</b> A playbook per category (<code>ACTIONS</code>), chains from the protocol’s record, gas from <code>GAS</code>; points and optional features depend on step 1. The payoff step illustrates a launch with ' + Math.round(P.userShare * 100) + '% to users and flags when it misses gas.</li></ul>' +
      (D.calibrated ? '<h3>Held-out diagnostics</h3><div class="stats">' + stat(D.mae.toFixed(2), 'mean |log error|, this model') + stat(D.mae_global.toFixed(2), 'one global multiple') +
        stat(D.z, 'z for the range (textbook 0.674)') + stat(Math.round(100 * D.coverage) + '%', 'held-out peers inside (0.674: ' + Math.round(100 * D.nominal_coverage) + '%)') + '</div>' +
        '<p>Each of the ' + D.n + ' priced peers was predicted from the others: a typical miss of about ' + Math.exp(D.mae).toFixed(1) + '× (sector alone ' + D.mae_sector.toFixed(2) + '). Sectors and categories add little over one global multiple, so ranks mostly follow TVL, momentum and runway; an 80% range would need z = ' + D.z80 + '. This tests the multiple only, on tokens that launched; it cannot test whether these protocols will launch one, or at what value.</p>' : '') +
      '<p class="note">Snapshot figures are facts; every implied value, range and payoff is this model’s estimate, not a market price or a forecast. A protocol whose record shows no token may already have one.</p></div>';
  }

  function route() {
    var h = parseHash();
    if (h.path.indexOf('/p/') === 0) detail(decodeURIComponent(h.path.slice(3)));
    else if (h.path === '/trading') trading();
    else if (h.path === '/method') method();
    else board(h.q);
  }
  document.getElementById('skip').addEventListener('click', function (e) { e.preventDefault(); view.focus(); });
  window.addEventListener('hashchange', function () { route(); window.scrollTo(0, 0); view.focus({ preventScroll: true }); });
  route();
})();
