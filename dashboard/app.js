'use strict';
/* Token Launch Radar — renders window.RADAR (written by the program next to
   this page) and recomputes the farm verdicts live at the reader's inputs.
   The printed plan in each detail view stays the canonical one from
   board.json; the economics panel is the live recompute. */

const R = window.RADAR;
const $ = (s, el) => (el || document).querySelector(s);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const commas = (n) => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const money = (n) => (n < 0 ? '-$' : '$') + commas(n);
const compact = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return money(n);
};
const hour = (n) => (n < 0 ? '-$' + Math.abs(n).toFixed(2) : '$' + n.toFixed(2));
const pct = (x) => (x === null || x === undefined ? '—' : (x > 0 ? '+' : '') + x + '%');
const years = (d) => (d === null ? '—' : (d / 365.25).toFixed(1) + 'y');

const state = {
  view: 'board', q: '', cat: '', verdict: '', tier: '', wl: false, sort: 'rank',
  cap: null, drop: R.defaults.drop_share, weeks: R.defaults.weeks, slug: null,
};

/* The farm arithmetic of the model section, redone at the reader's inputs.
   Only the Payments row is structurally unfarmable; everything else is the
   same formula the program used, so the page and board.json agree at the
   default inputs. */
function econ(row) {
  const capital = state.cap !== null ? state.cap : row.arch.capital;
  const pool = row.cond_value_usd * state.drop;
  const intensity = pool / row.tvl_usd;
  const gross = intensity * capital;
  const gas_cost = row.arch.txs * row.gas_per_tx;
  const opp_cost = capital * R.defaults.opp_rate * (state.weeks / 52);
  const hours = (row.arch.setup_min + row.arch.upkeep_min * state.weeks) / 60;
  const net = gross - gas_cost - opp_cost;
  const per_hour = hours > 0 ? net / hours : 0;
  const verdict = row.category === 'Payments' || per_hour < 5 ? 'SKIP' : per_hour >= 25 ? 'FARM' : 'MARGINAL';
  const floor = R.defaults.opp_rate * (state.weeks / 52);
  const breakeven = intensity > floor ? gas_cost / (intensity - floor) : null;
  return { capital, pool, intensity, gross, gas_cost, opp_cost, hours, net, per_hour, verdict, breakeven };
}

function renderMeta() {
  $('#meta').innerHTML =
    'snapshot <b>' + esc(R.as_of) + '</b><br>source <b>' + esc(R.source) + '</b><br>floor <b>' + money(R.floor_usd) + ' TVL</b>';
}

function renderSelfCheck() {
  const el = $('#selfcheck');
  const c = R.counts;
  if (R.issues && R.issues.length) {
    el.className = 'strip bad';
    el.textContent = 'SELF-CHECK FAILED: ' + R.issues.join(' · ');
    return;
  }
  el.textContent =
    'SELF-CHECK ✓ board.json = this table · ' + c.ranked + ' ranked rows · ranks 1..' + c.ranked +
    ' · implied non-rising · watchlist ' + c.watchlist_covered + '/' + c.watchlist +
    ' · every row carries a 6-step farm plan · dossier rebuilt from this output';
}

function renderAccounting() {
  const c = R.counts;
  const rc = R.reason_counts;
  const cell = (n, t, amber) => '<div class="cell"><div class="n' + (amber ? ' amber' : '') + '">' + n + '</div><div class="t">' + t + '</div></div>';
  $('#accounting').innerHTML =
    cell(c.total, 'protocols in the snapshot') +
    cell(c.launched, 'already record a token — set aside') +
    cell(c.pretoken, 'record no token') +
    cell(c.excluded, 'of those, products of launched tokens — excluded') +
    cell(c.ranked, 'genuine pre-token — ranked below', true) +
    cell(c.watchlist_covered + '/' + c.watchlist, 'house watchlist on the board', true) +
    '<div class="cell"><div class="n">' + c.fit_sample + '</div><div class="t">traded tokens with a market cap — the value fit\'s sample</div></div>' +
    '<div class="cell"><div class="n" style="font-size:12.5px;line-height:1.45;padding-top:3px">' +
    rc.category + ' category · ' + rc['wrapped-word'] + ' wrapped/staked name · ' + rc['version-name'] + ' versioned name · ' + rc['exchange-name'] + ' exchange name' +
    '</div><div class="t">exclusion reasons (a protocol can trip more than one)</div></div>';
}

const TIERS = { '10m': (v) => v >= 1e7, '1m': (v) => v >= 1e6 && v < 1e7, '100k': (v) => v >= 1e5 && v < 1e6, small: (v) => v < 1e5 };

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  let rows = R.rows.filter((row) => {
    if (q && !(row.name.toLowerCase().includes(q) || row.slug.includes(q))) return false;
    if (state.cat && row.category !== state.cat) return false;
    if (state.tier && !TIERS[state.tier](row.implied_value_usd)) return false;
    if (state.wl && !row.watchlist) return false;
    if (state.verdict && econ(row).verdict !== state.verdict) return false;
    return true;
  });
  const by = {
    rank: (a, b) => a.rank - b.rank,
    perhour: (a, b) => econ(b).per_hour - econ(a).per_hour,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    odds: (a, b) => b.odds - a.odds,
    age: (a, b) => (b.age_days ?? -1) - (a.age_days ?? -1),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  rows = rows.sort(by[state.sort] || by.rank);
  return rows;
}

function renderBoard() {
  const rows = visibleRows();
  const tbody = $('#board tbody');
  tbody.innerHTML = rows.map((row) => {
    const e = econ(row);
    return '<tr data-slug="' + esc(row.slug) + '"' + (row.watchlist ? ' class="wl"' : '') + '>' +
      '<td class="r">' + row.rank + '</td>' +
      '<td><span class="name">' + esc(row.name) + '</span>' + (row.watchlist ? ' <span class="star" title="On the house watchlist">★</span>' : '') +
      '<span class="band">' + esc(row.slug) + '</span></td>' +
      '<td>' + esc(row.category || '—') + '</td>' +
      '<td class="r">' + compact(row.tvl_usd) + '</td>' +
      '<td class="r ' + (row.change_7d > 0 ? 'pos' : row.change_7d < 0 ? 'neg' : '') + '">' + pct(row.change_7d) + '</td>' +
      '<td class="r">' + years(row.age_days) + (row.age_imputed ? ' <span class="tag">age imputed</span>' : '') + '</td>' +
      '<td class="r">' + compact(row.cond_value_usd) + '</td>' +
      '<td class="r">' + row.odds.toFixed(2) + '</td>' +
      '<td class="r"><span class="implied">' + compact(row.implied_value_usd) + '</span>' +
      '<span class="band">÷/× ' + R.model.value.band_factor + ' honesty band</span></td>' +
      '<td><span class="badge ' + e.verdict + '">' + e.verdict + '</span></td>' +
      '<td class="r">' + hour(e.per_hour) + '</td></tr>';
  }).join('');
  tbody.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => openDetail(tr.dataset.slug)));
  const capNote = state.cap !== null ? money(state.cap) + ' capital' : 'archetype-minimum capital';
  $('#rowcount').textContent =
    'Showing ' + rows.length + ' of ' + R.counts.ranked + ' ranked · verdicts at ' + capNote +
    ' · drop share ' + Math.round(state.drop * 100) + '% · season ' + state.weeks + ' weeks';
}

function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }

function openDetail(slug) {
  const row = R.rows.find((r) => r.slug === slug);
  if (!row) return;
  state.slug = slug;
  const e = econ(row);
  const el = $('#view-detail');
  el.innerHTML =
    '<button type="button" class="back" id="backbtn">← Back to the board</button>' +
    '<div class="dhead"><h2>' + esc(row.name) + '</h2>' +
    '<span class="badge ' + e.verdict + '">' + e.verdict + ' · ' + hour(e.per_hour) + '/h</span>' +
    (row.watchlist ? '<span class="tag">★ house watchlist</span>' : '') +
    '<span class="tag">rank #' + row.rank + ' of ' + R.counts.ranked + '</span></div>' +
    '<p class="fine">' + esc(row.slug) + ' · ' + esc(row.category || 'uncategorised') + ' · listed ' + esc(row.listed_at || 'date not reported') +
    (row.age_imputed ? ' — no listing date in the snapshot, so its age is imputed at the population median for the odds fit' : '') + '</p>' +
    '<div class="grid">' +
    '<div class="card"><h3>The position in the snapshot</h3>' +
    kv('TVL', money(row.tvl_usd)) + kv('7-day change', pct(row.change_7d)) +
    kv('Age', years(row.age_days) + (row.age_days !== null ? ' (' + commas(row.age_days) + ' days)' : '')) +
    kv('Chains', esc(row.chains.join(', ') || '—')) +
    kv('Cheapest chain to farm', esc(row.gas_chain) + ' at ' + money(row.gas_per_tx) + '/tx') + '</div>' +
    '<div class="card"><h3>How the model prices it</h3>' +
    kv('Conditional value (if it launches)', money(row.cond_value_usd)) +
    kv('Launch odds', row.odds.toFixed(3)) +
    kv('Implied value (ranked by this)', money(row.implied_value_usd)) +
    kv('Honesty band (÷/× ' + R.model.value.band_factor + ')', money(row.band_low_usd) + ' – ' + money(row.band_high_usd)) +
    kv('Farmer pool at ' + Math.round(state.drop * 100) + '% drop share', money(e.pool)) +
    kv('Pool intensity', '$' + e.intensity.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') + ' per $1 of TVL') + '</div>' +
    '<div class="card"><h3>Economics at your inputs</h3>' +
    kv('Capital', money(e.capital) + (state.cap === null ? ' (archetype minimum)' : ' (your input)')) +
    kv('Expected gross from the pool', money(e.gross)) +
    kv('Gas (' + row.arch.txs + ' tx on ' + esc(row.gas_chain) + ')', '-' + money(e.gas_cost)) +
    kv('Opportunity cost (5%/yr, ' + state.weeks + ' wks)', '-' + money(e.opp_cost)) +
    kv('Your time (setup + upkeep)', e.hours.toFixed(1) + ' h') +
    kv('Net', money(e.net)) + kv('Net per hour', hour(e.per_hour)) +
    kv('Break-even capital', e.breakeven === null ? 'none at this drop share' : money(e.breakeven)) +
    '<p class="fine">Change capital, drop share or season length on the board and this panel recomputes. The plan below is the canonical one from board.json, at the archetype minimum.</p></div>' +
    '</div>' +
    '<div class="card" style="margin-top:12px"><h3>The farm plan (canonical, from board.json)</h3><ol class="steps">' +
    row.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol></div>';
  $('#backbtn').addEventListener('click', () => showView('board'));
  showView('detail');
}

function showView(name) {
  state.view = name;
  const map = { board: '#view-board', model: '#view-model', live: '#view-live', detail: '#view-detail' };
  for (const key of Object.keys(map)) $(map[key]).hidden = key !== name;
  document.querySelectorAll('.views button').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === name || (name === 'detail' && b.dataset.view === 'board'));
  });
  window.scrollTo(0, 0);
}

function renderModel() {
  const v = R.model.value;
  const val = R.model.validation;
  $('#formula-value').textContent =
    'log10(market cap) = ' + v.intercept + ' + ' + v.slope + ' × log10(TVL)   —   fitted on ' + v.n + ' traded tokens that record a market cap';
  const dex = (x) => x.toFixed(3) + ' dex';
  const rows = [
    ['Median miss, in-sample', dex(val.in_model), dex(val.in_baseline)],
    ['Median miss, leave-one-out', dex(val.loo_model), dex(val.loo_baseline)],
    ['Walk-forward: fit oldest ' + Math.round(val.walk_forward[0].train_share * 100) + '%, test newest ' + val.walk_forward[0].test, dex(val.walk_forward[0].model), dex(val.walk_forward[0].baseline)],
    ['Walk-forward: fit oldest ' + Math.round(val.walk_forward[1].train_share * 100) + '%, test newest ' + val.walk_forward[1].test, dex(val.walk_forward[1].model), dex(val.walk_forward[1].baseline)],
    ['Share of leave-one-out predictions within 3× of the truth', Math.round(val.within3_model * 100) + '%', Math.round(val.within3_baseline * 100) + '%'],
  ];
  $('#valtable tbody').innerHTML = rows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td class="r">' + r[1] + '</td><td class="r">' + r[2] + '</td></tr>').join('');
  $('#valnote').textContent =
    'A median miss of ' + val.loo_model.toFixed(3) + ' dex means half of the leave-one-out predictions land within ÷/× ' + v.band_factor +
    ' of the cap the token actually recorded. The flat multiple it is compared against is the population\'s own median multiple, ' +
    R.model.baseline_k + ' × TVL — the rule of thumb a hand-made radar would use.';
  const o = R.model.odds;
  $('#formula-odds').textContent =
    'logit(launch odds) = ' + o.beta_const + ' + ' + o.beta_tvl + '·log10(TVL) + ' + o.beta_age + '·log(age in years) + (' + o.beta_growth + ')·(7d growth, winsorized) + category terms   —   fitted on all ' + R.counts.total;
  $('#oddsnote').textContent =
    'Brier score, five-fold cross-validated: ' + o.brier_cv + ' (in-sample ' + o.brier_in + '), against ' + o.brier_base +
    ' for the base-rate guess — ' + Math.round(o.base_rate * 100) + '% of the snapshot already records a token. Age pulls odds up hard (older and tokenless is a statement), size helps, and a hot week slightly lowers them.';
  $('#rangenote').textContent =
    'Every implied value on the board carries the value fit\'s own leave-one-out miss as its band: ÷/× ' + v.band_factor +
    '. The middle half of leave-one-out residuals runs from ' + v.resid_q25 + ' to +' + v.resid_q75 +
    ' dex, so a typical launch lands somewhere between a third and twice the point estimate even before the tails. Treat the point estimate as a ranking device; the band is the honest claim.';
}

function renderLive() {
  $('#livetable tbody').innerHTML = R.live.map((p) =>
    '<tr><td><span class="name">' + esc(p.name) + '</span><span class="band">' + esc(p.slug) + '</span></td>' +
    '<td>' + esc(p.category || '—') + '</td><td class="r">' + compact(p.tvl_usd) + '</td>' +
    '<td class="r">' + (p.mcap_usd === null ? '—' : compact(p.mcap_usd)) + '</td>' +
    '<td class="r ' + (p.change_7d > 0 ? 'pos' : p.change_7d < 0 ? 'neg' : '') + '">' + pct(p.change_7d) + '</td></tr>',
  ).join('');
}

function buildCategoryOptions() {
  const counts = new Map();
  for (const row of R.rows) if (row.category) counts.set(row.category, (counts.get(row.category) || 0) + 1);
  const sel = $('#cat');
  [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([cat, n]) => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat + ' (' + n + ')';
    sel.appendChild(opt);
  });
}

function wireControls() {
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
  $('#cat').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); });
  $('#verdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
  $('#tier').addEventListener('change', (e) => { state.tier = e.target.value; renderBoard(); });
  $('#wl').addEventListener('change', (e) => { state.wl = e.target.checked; renderBoard(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderBoard(); });
  $('#cap').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    state.cap = Number.isFinite(v) && v > 0 ? v : null;
    renderBoard();
  });
  $('#drop').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) { state.drop = Math.min(100, Math.max(0, v)) / 100; renderBoard(); }
  });
  $('#weeks').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) { state.weeks = Math.min(52, Math.max(1, v)); renderBoard(); }
  });
  document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
}

/* Deep links: ?view=detail&slug=… renders a protocol, ?verdict=FARM a filter.
   The screenshots are taken through these, so what they show is the page's
   own doing, not a mock. */
function readParams() {
  const p = new URLSearchParams(location.search);
  if (p.get('q')) { state.q = p.get('q'); $('#q').value = state.q; }
  if (p.get('cat')) { state.cat = p.get('cat'); $('#cat').value = state.cat; }
  if (p.get('verdict')) { state.verdict = p.get('verdict'); $('#verdict').value = state.verdict; }
  if (p.get('tier')) { state.tier = p.get('tier'); $('#tier').value = state.tier; }
  if (p.get('wl') === '1') { state.wl = true; $('#wl').checked = true; }
  if (p.get('sort')) { state.sort = p.get('sort'); $('#sort').value = state.sort; }
  const cap = parseFloat(p.get('cap') || '');
  if (Number.isFinite(cap) && cap > 0) { state.cap = cap; $('#cap').value = String(cap); }
  const drop = parseFloat(p.get('drop') || '');
  if (Number.isFinite(drop)) { state.drop = Math.min(100, Math.max(0, drop)) / 100; $('#drop').value = String(drop); }
  const weeks = parseInt(p.get('weeks') || '', 10);
  if (Number.isFinite(weeks)) { state.weeks = Math.min(52, Math.max(1, weeks)); $('#weeks').value = String(weeks); }
  return p;
}

function boot() {
  $('#drop').value = String(Math.round(R.defaults.drop_share * 100));
  $('#weeks').value = String(R.defaults.weeks);
  buildCategoryOptions();
  wireControls();
  const p = readParams();
  renderMeta();
  renderSelfCheck();
  renderAccounting();
  renderBoard();
  renderModel();
  renderLive();
  const view = p.get('view');
  if (view === 'detail' && p.get('slug')) openDetail(p.get('slug'));
  else if (view === 'model' || view === 'live') showView(view);
  else showView('board');
}

boot();
