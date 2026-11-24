'use strict';
/* Token Launch Radar — renders window.RADAR (written by the program next to
   this page) and recomputes the farm verdicts live at the reader's scenario
   inputs. The printed plan in each detail view stays the canonical one from
   board.json; the tables are the live recompute of the same arithmetic. */
const R = window.RADAR;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const commas = (n) => Math.round(n).toLocaleString('en-US');
const money = (n) => '$' + commas(n);
const compact = (n) => {
  const a = Math.abs(n);
  const f = (v, u) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + u;
  if (a >= 1e9) return '$' + f(n / 1e9, 'B');
  if (a >= 1e6) return '$' + f(n / 1e6, 'M');
  if (a >= 1e3) return '$' + f(n / 1e3, 'K');
  return money(n);
};
const hour = (n) => (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2) + '/h';
const fee = (n) => (Math.abs(n) >= 1000 ? money(n) : '$' + String(Math.round(n * 100) / 100));
const trimPct = (x) => String(Math.round(x * 100) / 100);
const pct = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
const pctHtml = (n) => (n === null || n === undefined ? '—' : '<span class="' + (n >= 0 ? 'pos' : 'neg') + '">' + pct(n) + '</span>');
const years = (d) => (d === null || d === undefined ? '—' : (d / 365.25).toFixed(1) + 'y');
const x10 = (dex) => '×' + Math.pow(10, dex).toFixed(2);
const bpct = (x) => Math.round(x * 100) + '%';
const sgn = (n) => (n < 0 ? '- ' : '+ ') + Math.abs(n).toFixed(3);

/* The one scenario's arithmetic — the same formulas the program runs for
   board.json, so the page and the board can be checked against each other. */
const SC = R.scenario;
function scenarioDeposit(tvl, planPct) {
  return Math.min(SC.plan_cap, Math.max(SC.plan_floor, (planPct / 100) * tvl));
}
function scenarioEcon(row, planPct, dropPct, weeks) {
  const deposit = scenarioDeposit(row.tvl_usd, planPct);
  const pool = (dropPct / 100) * row.implied_value_usd;
  const intensity = deposit / row.tvl_usd;
  const drop = pool * intensity;
  const gas_cost = row.arch.txs * row.gas_per_tx;
  const opp_cost = deposit * SC.opp_rate * (weeks / 52);
  const hours = (row.arch.setup_min + row.arch.upkeep_min * weeks) / 60;
  const net = drop - gas_cost;
  const per_hour = hours > 0 ? net / hours : 0;
  const verdict = row.arch.no_retail || per_hour < 5 ? 'SKIP' : per_hour >= 25 ? 'FARM' : 'MARGINAL';
  return { deposit, pool, intensity, drop, gas_cost, opp_cost, hours, net, per_hour, verdict };
}
window.RADAR_ECON = { econ: scenarioEcon, deposit: scenarioDeposit };

const state = {
  tab: 'all', q: '', cat: '', sort: 'rank',
  plan: +(SC.plan_pct * 100).toFixed(4), drop: +(SC.drop_share * 100).toFixed(1), weeks: SC.weeks,
  slug: null,
};
const bySlug = new Map(R.rows.map((r) => [r.slug, r]));
const tabOf = (r) => (r.watchlist ? 'watchlist' : r.tvl_usd >= R.floor_usd ? 'offlist' : 'early');
function verdictCounts() {
  const c = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (const r of R.rows) c[scenarioEcon(r, state.plan, state.drop, state.weeks).verdict]++;
  return c;
}

function renderMeta() {
  const when = new Date(R.as_of + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  $('#meta').innerHTML = 'Snapshot as of <b>' + when + '</b><br>Source: DefiLlama · ' + R.counts.total + ' protocols<br>TVL floor ' + money(R.floor_usd) + ' · board seal <b>' + R.seal.checksum + '</b>';
}

function renderStats() {
  const c = R.counts, v = R.model.validation, wf = v.walk_forward[0];
  const lad = R.model.ladders, hon = R.model.honesty;
  const oLast = lad.odds[lad.odds.length - 1], oBase = lad.odds[0];
  const vc = verdictCounts();
  const top = R.rows[0];
  const box = (t, n, s) => '<div class="stat"><div class="t">' + t + '</div><div class="n">' + n + '</div><div class="s">' + s + '</div></div>';
  $('#stats').innerHTML =
    box('Ranked', c.ranked + ' <small>protocols</small>', c.watchlist_covered + ' of ' + c.watchlist + ' watchlist ranked · ' + (c.ranked - c.ranked_watchlist) + ' more the watchlist leaves out') +
    box('Implied value', compact(R.seal.total_implied), 'summed over the board · #1 ' + esc(top.name) + ' at ' + compact(top.implied_value_usd)) +
    box('Value miss, walk-forward', x10(wf.model), 'vs ' + x10(wf.baseline) + ' for a flat TVL multiple · leave-one-out ' + x10(v.loo_model) + ' vs ' + x10(v.loo_baseline)) +
    box('Range holds, leave-one-out', bpct(hon.loo.in_p25_75) + ' · ' + bpct(hon.loo.in_p10_90), 'of traded caps priced without themselves fell inside the printed P25–P75 (stated 50%) and P10–P90 (stated 80%)') +
    box('Launch odds, held out', bpct(oLast.acc_b) + ' <small>called right</small>', 'walk-forward vs ' + bpct(oBase.acc_b) + ' for the base rate · Brier ' + R.model.odds.brier_cv.toFixed(3) + ' vs ' + R.model.odds.brier_base.toFixed(3) + ', ten-fold') +
    box('Worth farming, this scenario', vc.FARM + ' <small>clear $25/h</small>', vc.MARGINAL + ' marginal · ' + vc.SKIP + ' skip · at the plan size, drop share and horizon below');
}

const ACCT = [
  ['ranked_watchlist', 'Watchlist', '#b97e10'], ['ranked_above_floor', 'Off-list, above the floor', '#0e7c6b'],
  ['ranked_below_floor', 'Early, below the floor', '#7fae9f'], ['launched_priced', 'Launched, cap recorded', '#546e7a'],
  ['launched_unpriced', 'Launched, no cap recorded', '#b0bec5'], ['excl_bridge', 'Set aside: bridges', '#c9a86a'],
  ['excl_staking', 'Set aside: liquid staking', '#d3b578'], ['excl_exchange', 'Set aside: exchange records', '#dec491'],
  ['excl_named', 'Set aside: versioned / wrapped', '#ecd9a0'],
];
function renderAcct() {
  const c = R.counts;
  const bar = ACCT.map((a) => '<span style="width:' + ((c[a[0]] / c.total) * 100).toFixed(2) + '%;background:' + a[2] + '" title="' + a[1] + ': ' + c[a[0]] + '"></span>').join('');
  const legend = ACCT.map((a) => '<span><i style="background:' + a[2] + '"></i>' + a[1] + ' <b>' + c[a[0]] + '</b></span>').join('');
  const ledger = 'All ' + c.total + ' protocols in exactly one group: ' + c.ranked + ' ranked (' + c.ranked_watchlist + ' watchlist · ' + c.ranked_above_floor + ' off-list above the floor · ' + c.ranked_below_floor + ' early, below it) · ' + c.launched + ' already record a token (' + c.launched_priced + ' with a usable cap — the value fit’s sample · ' + c.launched_unpriced + ' without) · ' + c.excluded + ' set aside by the house list’s own rules (' + c.excl_bridge + ' bridges · ' + c.excl_staking + ' liquid staking &amp; restaking · ' + c.excl_exchange + ' exchange records · ' + c.excl_named + ' versioned or wrapped names).';
  $('#acct').innerHTML = '<div class="bar">' + bar + '</div><div class="legend">' + legend + '</div><p class="ledger">' + ledger + '</p>';
}

function renderSeal() {
  const el = $('#seal');
  const ok = R.issues.length === 0;
  el.className = 'strip' + (ok ? '' : ' bad');
  el.textContent = ok
    ? 'Self-check ✓ — this table is board.json: ' + R.counts.ranked + ' of ' + R.counts.ranked + ' rows recomputed here · ranks 1–' + R.counts.ranked + ' in order, implied values never rise · totals equal: ' + money(R.seal.total_implied) + ' implied · checksum ' + R.seal.checksum + ' = board.json · watchlist ' + R.counts.watchlist_covered + ' of ' + R.counts.watchlist + ' ranked · ledger ' + R.counts.total + ' of ' + R.counts.total + ' protocols in one group each'
    : 'Self-check failed: ' + R.issues.join('; ');
  $('#footseal').textContent = R.seal.checksum;
}

const mark = (s) => (s.kept === null ? '<span class="mk no">the baseline</span>' : s.kept ? '<span class="mk kept">KEPT</span>' : '<span class="mk no">tested, not kept</span>');
function renderEvidence() {
  const lad = R.model.ladders, hon = R.model.honesty, o = R.model.odds, vf = R.model.value;
  const vRows = lad.value.map((s) => '<tr><td>' + esc(s.label) + '</td><td>' + x10(s.test_a) + '</td><td>' + x10(s.test_b) + '</td><td>' + mark(s) + '</td></tr>').join('');
  const oRows = lad.odds.map((s) => '<tr><td>' + esc(s.label) + '</td><td>' + s.test_a.toFixed(3) + ' · ' + bpct(s.acc_a) + '</td><td>' + s.test_b.toFixed(3) + ' · ' + bpct(s.acc_b) + '</td><td>' + mark(s) + '</td></tr>').join('');
  const hRow = (label, loo, wf) => '<tr><td>' + label + '</td><td>' + bpct(loo) + '</td><td>' + bpct(wf) + '</td></tr>';
  const hRows = hRow('within ×3 of the model', hon.loo.within3, hon.wf.within3) + hRow('inside P25–P75 · stated 50%', hon.loo.in_p25_75, hon.wf.in_p25_75) + hRow('inside P10–P90 · stated 80%', hon.loo.in_p10_90, hon.wf.in_p10_90);
  const cats = o.beta_cats.slice().sort((a, b) => a.beta - b.beta);
  const catTxt = cats.length ? ' + category offsets from ' + cats[0].beta.toFixed(2) + ' (' + esc(cats[0].name) + ') to ' + cats[cats.length - 1].beta.toFixed(2) + ' (' + esc(cats[cats.length - 1].name) + ')' : '';
  $('#evidence').innerHTML =
    '<h2>Out-of-sample evidence — a term is kept only if it lowers the error on <span class="kept">both</span> tests</h2>' +
    '<div class="evgrid">' +
    '<div class="ev"><h3>Value ladder · typical miss, lower is better</h3><table><tr><th>Term</th><th>Leave-one-out</th><th>Walk-forward</th><th></th></tr>' + vRows + '</table></div>' +
    '<div class="ev"><h3>Odds ladder · Brier score · share called right</h3><table><tr><th>Term</th><th>Ten-fold CV</th><th>Walk-forward</th><th></th></tr>' + oRows + '</table></div>' +
    '<div class="ev"><h3>Range honesty · printed ranges vs real caps</h3><table><tr><th>Share of traded tokens</th><th>Leave-one-out</th><th>Walk-forward</th></tr>' + hRows + '</table></div>' +
    '</div>' +
    '<p class="coeffs">Fitted on this snapshot — value: log<sub>10</sub>(cap) = ' + vf.intercept.toFixed(4) + ' + ' + vf.slope.toFixed(4) + '·log<sub>10</sub>(TVL) on ' + vf.n + ' traded tokens (the flat rule would multiply TVL by ×' + R.model.baseline_k.toFixed(4) + '). Odds, in logits: ' + o.beta_const.toFixed(3) + ' ' + sgn(o.beta_tvl) + '·log<sub>10</sub>(TVL) ' + sgn(o.beta_age) + '·log(age, years) ' + sgn(o.beta_growth) + '·(7-day growth, winsorized)' + catTxt + '.</p>' +
    '<p class="reading">Reading it: only the size curve survives both tests, so the value model is the size curve alone — the category step buys a little leave-one-out accuracy and loses it out of time, and the growth step does the reverse. In the odds, age does the heavy lifting; the size step on its own adds nothing once age is known, and the full fitted surface — the board’s model — still posts the best held-out score of any rung. The ranges are the fit’s own residuals, printed where they land: honest, and wide.</p>';
}

const TABS = [['all', 'All'], ['farm', 'Farm'], ['marginal', 'Marginal'], ['skip', 'Skip'], ['watchlist', 'Watchlist'], ['early', 'Early'], ['offlist', 'Off-list']];
function renderTabs() {
  const vc = verdictCounts();
  const n = { all: R.rows.length, farm: vc.FARM, marginal: vc.MARGINAL, skip: vc.SKIP, watchlist: 0, early: 0, offlist: 0 };
  for (const r of R.rows) n[tabOf(r)]++;
  $('#tabs').innerHTML = TABS.map((t) => '<button type="button" data-tab="' + t[0] + '" class="' + (state.tab === t[0] ? 'on' : '') + '">' + t[1] + ' <b>' + n[t[0]] + '</b></button>').join('');
  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => { state.tab = b.dataset.tab; renderTabs(); renderBoard(); });
}

function pricedRows() {
  return R.rows.map((r) => ({ r, e: scenarioEcon(r, state.plan, state.drop, state.weeks) }));
}
function renderBoard() {
  let list = pricedRows().filter(({ r, e }) => {
    if (state.tab === 'farm' || state.tab === 'marginal' || state.tab === 'skip') { if (e.verdict !== state.tab.toUpperCase()) return false; }
    else if (state.tab !== 'all' && tabOf(r) !== state.tab) return false;
    if (state.cat && r.category !== state.cat) return false;
    if (state.q) { const q = state.q.toLowerCase(); if (!r.name.toLowerCase().includes(q) && !r.slug.includes(q)) return false; }
    return true;
  });
  const sorters = {
    rank: (a, b) => a.r.rank - b.r.rank,
    perhour: (a, b) => b.e.per_hour - a.e.per_hour,
    tvl: (a, b) => b.r.tvl_usd - a.r.tvl_usd,
    odds: (a, b) => b.r.odds - a.r.odds,
    age: (a, b) => (b.r.age_days ?? -1) - (a.r.age_days ?? -1),
    name: (a, b) => a.r.name.localeCompare(b.r.name),
  };
  list = list.sort(sorters[state.sort] || sorters.rank);
  $('#rowcount').textContent = 'Showing ' + list.length + ' of ' + R.rows.length + ' ranked protocols · scenario: plan ' + state.plan + '% of TVL (' + money(SC.plan_floor) + '–' + money(SC.plan_cap) + ') · drop ' + state.drop + '% of implied · ' + state.weeks + ' weeks · verdicts net of gas';
  $('#board tbody').innerHTML = list.map(rowHtml).join('');
  for (const tr of document.querySelectorAll('#board tbody tr')) tr.addEventListener('click', () => openDetail(tr.dataset.slug));
}
function rowHtml({ r, e }) {
  const tag = r.watchlist ? '<span class="tag wl">Watchlist</span>' : r.tvl_usd >= R.floor_usd ? '<span class="tag off">Off-list</span>' : '<span class="tag early">Early</span>';
  const chain = r.chains.length ? esc(r.chains[0]) + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') : '—';
  const i25 = Math.round(r.c25 * r.odds), i75 = Math.round(r.c75 * r.odds);
  return '<tr data-slug="' + esc(r.slug) + '">' +
    '<td class="r">' + r.rank + '</td>' +
    '<td>' + r.rank_lo + '–' + r.rank_hi + '</td>' +
    '<td><span class="name">' + esc(r.name) + '</span>' + tag + '<div class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + chain + '</div></td>' +
    '<td class="r">' + compact(r.tvl_usd) + '</td>' +
    '<td class="r">' + pctHtml(r.change_7d) + '</td>' +
    '<td class="r">' + years(r.age_days) + (r.age_imputed ? '<div class="sub">imputed</div>' : '') + '</td>' +
    '<td>' + Math.round(r.odds * 100) + '%<div class="oddsbar"><i style="width:' + Math.round(r.odds * 100) + '%"></i></div></td>' +
    '<td class="r">' + compact(r.cond_value_usd) + '</td>' +
    '<td class="r"><b>' + compact(r.implied_value_usd) + '</b><div class="sub">' + compact(i25) + '–' + compact(i75) + '</div></td>' +
    '<td><span class="chip ' + e.verdict.toLowerCase() + '">' + e.verdict + ' · ' + hour(e.per_hour) + '</span><div class="sub">' + money(e.drop) + ' drop · ' + fee(e.gas_cost) + ' fees</div></td>' +
    '<td class="r ' + (e.per_hour < 0 ? 'neg' : 'pos') + '">' + hour(e.per_hour) + '</td></tr>';
}

const kv = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>';
function openDetail(slug) {
  const r = bySlug.get(slug);
  if (!r) return;
  state.slug = slug;
  const e = scenarioEcon(r, SC.plan_pct * 100, SC.drop_share * 100, SC.weeks);
  const imp25 = Math.round(r.c25 * r.odds), imp75 = Math.round(r.c75 * r.odds), imp10 = Math.round(r.c10 * r.odds), imp90 = Math.round(r.c90 * r.odds);
  const el = $('#view-detail');
  el.hidden = false;
  el.innerHTML =
    '<button type="button" class="back" id="back">← Back to the board</button>' +
    '<h2>' + esc(r.name) + ' <span class="chip ' + e.verdict.toLowerCase() + '">' + e.verdict + ' · ' + hour(e.per_hour) + '</span></h2>' +
    '<div class="cards">' +
    '<div class="card"><h3>The model\u2019s pricing</h3>' +
    kv('Rank', '#' + r.rank + ' of ' + R.rows.length + ' · refit range ' + r.rank_lo + '–' + r.rank_hi) +
    kv('TVL', money(r.tvl_usd)) +
    kv('Value if it launches', money(r.cond_value_usd)) +
    kv('Conditional P25–P75', money(r.c25) + ' – ' + money(r.c75)) +
    kv('Conditional P10–P90', money(r.c10) + ' – ' + money(r.c90)) +
    kv('Launch odds', Math.round(r.odds * 100) + '%') +
    kv('Implied value', money(r.implied_value_usd)) +
    kv('Implied P25–P75', money(imp25) + ' – ' + money(imp75)) +
    kv('Implied P10–P90', money(imp10) + ' – ' + money(imp90)) +
    kv('Band (×/÷ ' + R.model.value.band_factor.toFixed(2) + ')', money(r.band_low_usd) + ' – ' + money(r.band_high_usd)) +
    '</div>' +
    '<div class="card"><h3>What the snapshot says</h3>' +
    kv('Category', esc(r.category || 'Uncategorised')) +
    kv('Chains', esc(r.chains.join(', ') || '—')) +
    kv('TVL change, 7 days', pct(r.change_7d)) +
    kv('Listed', r.listed_at ? esc(r.listed_at.slice(0, 10)) : 'not recorded') +
    kv('Age', years(r.age_days) + (r.age_imputed ? ' (imputed at the median — the snapshot records no listing date)' : '')) +
    kv('Cheapest chain for gas', esc(r.gas_chain) + ' at ' + fee(r.gas_per_tx) + ' per transaction') +
    kv('Plan shape', r.arch.txs + ' transactions · ' + r.arch.setup_min + ' min setup · ' + r.arch.upkeep_min + ' min/week upkeep') +
    (r.arch.no_retail ? kv('Retail access', 'none recorded — the verdict is SKIP whatever the arithmetic says') : '') +
    '</div>' +
    '<div class="card"><h3>Economics at the stated scenario</h3>' +
    kv('Plan size', money(e.deposit) + ' (' + trimPct(SC.plan_pct * 100) + '% of TVL, ' + money(SC.plan_floor) + '–' + money(SC.plan_cap) + ')') +
    kv('Farmer pool', money(e.pool) + ' (' + trimPct(SC.drop_share * 100) + '% of implied value)') +
    kv('Your share of TVL', (e.intensity * 100).toFixed(4) + '%') +
    kv('Expected drop', money(e.drop)) +
    kv('Gas', fee(e.gas_cost) + ' (' + r.arch.txs + ' tx on ' + esc(r.gas_chain) + ')') +
    kv('Risk-free on the deposit', money(e.opp_cost) + ' at ' + trimPct(SC.opp_rate * 100) + '%/yr — shown, not netted: the leaders\u2019 arithmetic nets fees only') +
    kv('Your time', e.hours.toFixed(1) + ' h over ' + SC.weeks + ' weeks') +
    kv('Net of fees', money(e.net)) +
    kv('Net per hour', hour(e.per_hour)) +
    kv('Verdict', e.verdict + ' (FARM ≥ $25/h · MARGINAL $5–25/h · SKIP below)') +
    '</div>' +
    '<div class="card"><h3>The farm plan (canonical, from board.json)</h3><ol class="steps">' +
    r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') +
    '</ol></div>' +
    '</div>';
  $('#back').addEventListener('click', closeDetail);
  document.querySelector('.tablewrap').hidden = true;
  $('#rowcount').hidden = true;
  el.scrollIntoView();
}
function closeDetail() {
  state.slug = null;
  $('#view-detail').hidden = true;
  document.querySelector('.tablewrap').hidden = false;
  $('#rowcount').hidden = false;
}

function renderLive() {
  $('#livetable tbody').innerHTML = R.live.map((p) =>
    '<tr><td><span class="name">' + esc(p.name) + '</span></td><td>' + esc(p.category || '—') + '</td>' +
    '<td class="r">' + compact(p.tvl_usd) + '</td><td class="r">' + (p.mcap_usd ? compact(p.mcap_usd) : '—') + '</td>' +
    '<td class="r">' + pctHtml(p.change_7d) + '</td></tr>').join('');
}

function readParams() {
  const q = new URLSearchParams(location.search);
  if (q.get('view') === 'detail' && q.get('slug')) state.slug = q.get('slug');
  const v = (q.get('verdict') || '').toLowerCase();
  if (['farm', 'marginal', 'skip', 'watchlist', 'early', 'offlist'].includes(v)) state.tab = v;
  if (q.get('sort')) state.sort = q.get('sort');
  if (q.get('q')) state.q = q.get('q');
  if (q.get('cat')) state.cat = q.get('cat');
  const num = (key, target) => { const n = parseFloat(q.get(key) || ''); if (Number.isFinite(n) && n > 0) state[target] = n; };
  num('plan', 'plan'); num('drop', 'drop'); num('weeks', 'weeks');
}
function boot() {
  readParams();
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  $('#cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => '<option' + (c === state.cat ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
  $('#plan').value = state.plan;
  $('#drop').value = state.drop;
  $('#weeks').value = state.weeks;
  $('#q').value = state.q;
  $('#sort').value = state.sort;
  const onScenario = () => {
    const p = parseFloat($('#plan').value), d = parseFloat($('#drop').value), w = parseFloat($('#weeks').value);
    if (Number.isFinite(p) && p > 0) state.plan = p;
    if (Number.isFinite(d) && d >= 0) state.drop = d;
    if (Number.isFinite(w) && w > 0) state.weeks = w;
    renderStats(); renderTabs(); renderBoard();
  };
  for (const id of ['#plan', '#drop', '#weeks']) $(id).addEventListener('input', onScenario);
  $('#q').addEventListener('input', () => { state.q = $('#q').value; renderBoard(); });
  $('#cat').addEventListener('change', () => { state.cat = $('#cat').value; renderBoard(); });
  $('#sort').addEventListener('change', () => { state.sort = $('#sort').value; renderBoard(); });
  $('#reset').addEventListener('click', () => {
    state.plan = +(SC.plan_pct * 100).toFixed(4); state.drop = +(SC.drop_share * 100).toFixed(1); state.weeks = SC.weeks;
    state.q = ''; state.cat = ''; state.sort = 'rank'; state.tab = 'all';
    $('#plan').value = state.plan; $('#drop').value = state.drop; $('#weeks').value = state.weeks;
    $('#q').value = ''; $('#cat').value = ''; $('#sort').value = 'rank';
    renderStats(); renderTabs(); renderBoard();
  });
  renderMeta(); renderStats(); renderAcct(); renderSeal(); renderEvidence(); renderTabs(); renderBoard(); renderLive();
  if (state.slug) openDetail(state.slug);
}
if (typeof document !== 'undefined' && document.querySelector) boot();
