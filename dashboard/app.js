'use strict';
/* Token Launch Radar — renders window.RADAR (written by the program next to
   this page). Before anything is drawn, the page refits the model itself:
   fitModel() re-runs the program's own fits on the records shipped in
   fit-data.js, recomputes every board row, and checks its seal against the
   program's. Verdicts then recompute live at the reader's scenario inputs;
   each detail's printed plan stays the canonical one from board.json. */
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

/* ------------------------------------------------ the refit, in this page
   The same arithmetic as the program's lib/model.ts, run on the shipped
   records: Gauss-Jordan OLS, the cleaning pass, the joint surface with
   category offsets shrunk by n/(n+64) and the growth term the ladder
   kept, and the peers' launch curves (ten log-age bins, isotonic,
   category curves blended toward the all-peer curve, 30 pseudo-peers).
   If this page and the program disagree, the seal strip says so. */
function solveLin(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) M[piv][c] = 1e-12;
    const sw = M[c]; M[c] = M[piv]; M[piv] = sw;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
function olsJ(X, y) {
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    for (let a = 0; a < k; a++) {
      Xty[a] += xi[a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += xi[a] * xi[b];
    }
  }
  for (let a = 0; a < k; a++) XtX[a][a] += 1e-9;
  return solveLin(XtX, Xty);
}
const medianJ = (v) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const growthFrac = (c) => (c === null || c === undefined || !Number.isFinite(c) ? 0 : Math.max(-50, Math.min(100, c)) / 100);
/* A packed listing age (years × 4096 + (months + 16) × 64 + days + 32,
   the signed calendar differences) rebuilt with the program's own
   expression, so the refit's ages are the program's, bit for bit. */
function ageFromPack(pack) {
  const years = Math.floor(pack / 4096);
  const rem = pack - years * 4096;
  const months = Math.floor(rem / 64) - 16;
  const days = rem - (months + 16) * 64 - 32;
  return years * 365.25 + months * 30.44 + days;
}
function buildCurve(pts) {
  const p = [...pts].sort((a, b) => a.age - b.age);
  if (!p.length) return { centers: [], values: [], n: 0 };
  const NB = 10;
  const lo = Math.log10(Math.max(p[0].age, 1)), hi = Math.log10(Math.max(p[p.length - 1].age, 1));
  const bins = Array.from({ length: NB }, () => []);
  for (const pt of p) {
    const la = Math.log10(Math.max(pt.age, 1));
    bins[Math.min(NB - 1, Math.max(0, Math.floor(((la - lo) / (hi - lo || 1)) * NB)))].push(pt);
  }
  const centers = [], shares = [], weights = [];
  for (const bin of bins) {
    if (!bin.length) continue;
    centers.push(bin.reduce((s, q) => s + Math.log10(Math.max(q.age, 1)), 0) / bin.length);
    shares.push(bin.reduce((s, q) => s + q.tok, 0) / bin.length);
    weights.push(bin.length);
  }
  const blocks = shares.map((v, i) => ({ v, w: weights[i], c: 1 }));
  const out = [];
  for (const bl of blocks) {
    out.push({ ...bl });
    while (out.length >= 2 && out[out.length - 2].v > out[out.length - 1].v) {
      const b2 = out.pop(), b1 = out.pop(), tw = b1.w + b2.w;
      out.push({ v: (b1.v * b1.w + b2.v * b2.w) / tw, w: tw, c: b1.c + b2.c });
    }
  }
  const values = [];
  for (const bl of out) for (let i = 0; i < bl.c; i++) values.push(bl.v);
  return { centers, values, n: p.length };
}
function curveAt(cv, age) {
  if (!cv.centers.length) return 0;
  const la = Math.log10(Math.max(age, 1));
  const { centers, values } = cv;
  if (la <= centers[0]) return values[0];
  if (la >= centers[centers.length - 1]) return values[values.length - 1];
  for (let i = 1; i < centers.length; i++) {
    if (la <= centers[i]) {
      const t = (la - centers[i - 1]) / (centers[i] - centers[i - 1]);
      return values[i - 1] + t * (values[i] - values[i - 1]);
    }
  }
  return values[values.length - 1];
}
function fnvSeal(parts) {
  const s = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function fitModel() {
  const F = window.FIT;
  if (!F) return null;
  try {
    const comps = F.comps.map((c) => [Math.log10(c[0]), Math.log10(c[1]), c[2], c[3], c[4]]);
    const b1 = olsJ(comps.map((c) => [1, c[0]]), comps.map((c) => c[1]));
    const cleaned = comps.filter((c) => Math.abs(c[1] - (b1[0] + b1[1] * c[0])) <= 1.0);
    const counts = new Map();
    for (const c of cleaned) if (c[2] !== 0) counts.set(c[2], (counts.get(c[2]) || 0) + 1);
    const big = [...counts.entries()].filter(([, n]) => n >= 5).map(([k]) => k);
    const feats = (c) => [1, c[0], ...big.slice(1).map((k) => (c[2] === k ? 1 : 0)), c[4]];
    const fitSurf = (train) => {
      const beta = olsJ(train.map(feats), train.map((c) => c[1]));
      const cnt = new Map();
      for (const c of train) if (c[2] !== 0) cnt.set(c[2], (cnt.get(c[2]) || 0) + 1);
      const off = big.map((k, i) => {
        if (i === 0) return 0;
        const n = cnt.get(k) || 0;
        return (beta[2 + i - 1] || 0) * (n / (n + 64));
      });
      return { beta, off, g: beta[beta.length - 1] };
    };
    const predS = (s, logT, catIdx, growth) => {
      let v = s.beta[0] + s.beta[1] * logT;
      const i = big.indexOf(catIdx);
      if (i > 0) v += s.off[i];
      return v + s.g * growth;
    };
    const surf = fitSurf(cleaned);
    const looErr = [];
    for (let i = 0; i < cleaned.length; i++) {
      const s = fitSurf(cleaned.filter((_, j) => j !== i));
      looErr.push(Math.abs(predS(s, cleaned[i][0], cleaned[i][2], cleaned[i][4]) - cleaned[i][1]));
    }
    const loo = medianJ(looErr);
    const dated = cleaned.filter((c) => c[3] >= 0).map((c) => [c, ageFromPack(c[3])]).sort((a, b) => b[1] - a[1]);
    const cut = Math.floor(dated.length * 0.6);
    const sW = fitSurf(dated.slice(0, cut).map((d) => d[0]));
    const wf = medianJ(dated.slice(cut).map((d) => Math.abs(predS(sW, d[0][0], d[0][2], d[0][4]) - d[0][1])));
    const P = F.peers;
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const peers = Array.from({ length: P.t.length }, (_, i) => ({ age: ageFromPack(ALPHA.indexOf(P.am[3 * i]) * 4096 + ALPHA.indexOf(P.am[3 * i + 1]) * 64 + ALPHA.indexOf(P.am[3 * i + 2])), tok: P.t.charCodeAt(i) - 48, cat: ALPHA.indexOf(P.cs[i]) }));
    const global = buildCurve(peers);
    const groups = new Map();
    for (const p of peers) { if (!groups.has(p.cat)) groups.set(p.cat, []); groups.get(p.cat).push(p); }
    const byCat = new Map();
    for (const [k, v] of groups) byCat.set(k, buildCurve(v));
    const sortedAges = peers.map((p) => p.age).sort((a, b) => a - b);
    const medAge = sortedAges[Math.floor(sortedAges.length / 2)];
    const shareAt = (catIdx, age) => {
      const g = curveAt(global, age);
      const cat = byCat.get(catIdx);
      if (!cat || !cat.n) return g;
      return (cat.n * curveAt(cat, age) + 30 * g) / (cat.n + 30);
    };
    const oldest = Math.pow(10, global.centers[global.centers.length - 1]);
    let matched = 0;
    const parts = [];
    for (const row of R.rows) {
      const catIdx = row.category ? F.cats.indexOf(row.category) : 0;
      const cond = Math.pow(10, predS(surf, Math.log10(row.tvl_usd), catIdx, growthFrac(row.change_7d)));
      const age = row.age_approx_days === null || row.age_approx_days === undefined ? medAge : row.age_approx_days;
      const f = shareAt(catIdx, age);
      const finf = shareAt(catIdx, oldest);
      const odds = f >= 1 ? 0.97 : Math.min(0.97, Math.max(0.02, (finf - f) / (1 - f)));
      const implied = Math.max(1, Math.round(cond * odds));
      if (Math.round(implied / 1000) === Math.round(row.implied_value_usd / 1000)) matched++;
      parts.push(row.slug + ':' + Math.round(implied / 1000));
    }
    const seal = fnvSeal(parts);
    return {
      kept: cleaned.length, raw: comps.length, matched, total: R.rows.length, seal,
      sealOk: seal === R.seal.checksum && matched === R.rows.length,
      loo, wf,
      looOk: Math.abs(loo - R.model.validation.loo_model) < 0.002,
      wfOk: Math.abs(wf - R.model.validation.walk_forward[0].model) < 0.002,
    };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}
const REFIT = fitModel();

/* The one scenario's arithmetic — the same formulas the program runs for
   board.json. A plan's fees are the sum of its steps' costs; its hours are
   the sum of its steps' times, weekly parts re-timed at the horizon. */
const SC = R.scenario;
function scenarioDeposit(tvl, planPct) {
  return Math.min(SC.plan_cap, Math.max(SC.plan_floor, (planPct / 100) * tvl));
}
function planHours(row, weeks) {
  return row.plan.reduce((s, st) => s + st.time_min + st.per_week_min * (weeks - SC.weeks), 0) / 60;
}
function planFees(row) {
  return row.plan.reduce((s, st) => s + st.cost_usd, 0);
}
function scenarioEcon(row, planPct, dropPct, weeks) {
  const deposit = scenarioDeposit(row.tvl_usd, planPct);
  const hours = planHours(row, weeks);
  const pool = (dropPct / 100) * row.implied_value_usd;
  const drop = pool * (deposit / row.tvl_usd);
  const opp_cost = deposit * SC.opp_rate * (weeks / 52);
  if (row.arch.no_retail) return { deposit, pool, drop, fees: 0, opp_cost, hours, net: 0, per_hour: 0, verdict: 'SKIP' };
  const fees = planFees(row);
  const net = drop - fees;
  const per_hour = hours > 0 ? net / hours : 0;
  const verdict = per_hour < 5 ? 'SKIP' : per_hour >= 25 ? 'FARM' : 'MARGINAL';
  return { deposit, pool, drop, fees, opp_cost, hours, net, per_hour, verdict };
}
const state = {
  tab: 'all', q: '', cat: '', chain: '', sort: 'rank',
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
  const hon = R.model.honesty, o = R.model.odds;
  const vc = verdictCounts();
  const top = R.rows[0];
  const box = (t, n, s) => '<div class="stat"><div class="t">' + t + '</div><div class="n">' + n + '</div><div class="s">' + s + '</div></div>';
  $('#stats').innerHTML =
    box('Ranked', c.ranked + ' <small>protocols</small>', c.watchlist_covered + ' of ' + c.watchlist + ' watchlist ranked · ' + (c.ranked - c.ranked_watchlist) + ' more the watchlist leaves out') +
    box('Implied value', compact(R.seal.total_implied), 'summed over the board · #1 ' + esc(top.name) + ' at ' + compact(top.implied_value_usd)) +
    box('Value miss, walk-forward', x10(wf.model), 'vs ' + x10(wf.baseline) + ' for a flat TVL multiple · leave-one-out ' + x10(v.loo_model) + ' on ' + c.fit_sample + ' cleaned caps') +
    box('Range holds, leave-one-out', bpct(hon.loo.in_p25_75) + ' · ' + bpct(hon.loo.in_p10_90), 'of traded caps priced without themselves fell inside the printed P25–P75 (stated 50%) and P10–P90 (stated 80%)') +
    box('Launch odds, held out', o.brier_cv.toFixed(3) + ' <small>Brier</small>', 'the peers\u2019 curve, ten-fold on dated peers · the logistic posts ' + o.logistic_cv.toFixed(3) + ' · base rate ' + o.brier_base.toFixed(3)) +
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
  const ledger = 'All ' + c.total + ' protocols in exactly one group: ' + c.ranked + ' ranked (' + c.ranked_watchlist + ' watchlist · ' + c.ranked_above_floor + ' off-list above the floor · ' + c.ranked_below_floor + ' early, below it) · ' + c.launched + ' already record a token (' + c.launched_priced + ' with a usable cap — ' + c.fit_sample + ' of them survive the value fit\u2019s cleaning pass · ' + c.launched_unpriced + ' without) · ' + c.excluded + ' set aside by the house list\u2019s own rules (' + c.excl_bridge + ' bridges · ' + c.excl_staking + ' liquid staking &amp; restaking · ' + c.excl_exchange + ' exchange records · ' + c.excl_named + ' versioned or wrapped names).';
  $('#acct').innerHTML = '<div class="bar">' + bar + '</div><div class="legend">' + legend + '</div><p class="ledger">' + ledger + '</p>';
}

function renderSeal() {
  const el = $('#seal');
  const c = R.counts;
  if (REFIT && REFIT.sealOk && REFIT.looOk && REFIT.wfOk) {
    el.className = 'strip ok';
    el.textContent = 'Refit in this browser ✓ — the fits were re-run here from the records shipped with this page: the cleaning pass kept ' + REFIT.kept + ' of ' + REFIT.raw + ' caps, the surface and launch curves were refitted, and ' + REFIT.matched + ' of ' + REFIT.total + ' board rows recomputed to the program\u2019s own values · seal ' + REFIT.seal + ' = board.json\u2019s · held-out errors match (leave-one-out ' + x10(REFIT.loo) + ' · walk-forward ' + x10(REFIT.wf) + ') · totals equal: ' + money(R.seal.total_implied) + ' implied · watchlist ' + c.watchlist_covered + ' of ' + c.watchlist + ' ranked · ledger ' + c.total + ' of ' + c.total + ' in one group each';
  } else if (REFIT && !REFIT.error) {
    el.className = 'strip bad';
    el.textContent = 'Refit check failed — this browser\u2019s refit recomputed ' + REFIT.matched + ' of ' + REFIT.total + ' rows to the program\u2019s values and its seal ' + REFIT.seal + ' against the program\u2019s ' + R.seal.checksum + '. Trust board.json, not this page\u2019s arithmetic.';
  } else {
    el.className = 'strip' + (R.issues.length === 0 ? '' : ' bad');
    el.textContent = R.issues.length === 0
      ? 'Self-check ✓ — this table is board.json: ' + c.ranked + ' of ' + c.ranked + ' rows in order, implied values never rise · totals equal: ' + money(R.seal.total_implied) + ' implied · checksum ' + R.seal.checksum + ' = board.json · watchlist ' + c.watchlist_covered + ' of ' + c.watchlist + ' ranked · the refit records were not shipped with this copy of the page, so the in-browser refit did not run'
      : 'Self-check failed: ' + R.issues.join('; ');
  }
  $('#footseal').textContent = R.seal.checksum;
}

const mark = (s) => (s.kept === null ? '<span class="mk no">the baseline</span>' : s.kept ? '<span class="mk kept">KEPT</span>' : '<span class="mk no">tested, not kept</span>');
function renderEvidence() {
  const lad = R.model.ladders, hon = R.model.honesty, o = R.model.odds, vf = R.model.value, cl = R.model.cleaning, fam = R.model.family;
  const vRows = lad.value.map((s) => '<tr><td>' + esc(s.label) + '</td><td>' + x10(s.test_a) + '</td><td>' + x10(s.test_b) + '</td><td>' + mark(s) + '</td></tr>').join('');
  const oRows = lad.odds.map((s) => '<tr><td>' + esc(s.label) + '</td><td>' + s.test_a.toFixed(3) + ' · ' + bpct(s.acc_a) + '</td><td>' + s.test_b.toFixed(3) + ' · ' + bpct(s.acc_b) + '</td><td>' + mark(s) + '</td></tr>').join('');
  const hRow = (label, loo, wf) => '<tr><td>' + label + '</td><td>' + bpct(loo) + '</td><td>' + bpct(wf) + '</td></tr>';
  const hRows = hRow('within ×3 of the model', hon.loo.within3, hon.wf.within3) + hRow('inside P25–P75 · stated 50%', hon.loo.in_p25_75, hon.wf.in_p25_75) + hRow('inside P10–P90 · stated 80%', hon.loo.in_p10_90, hon.wf.in_p10_90);
  const offs = vf.cats.filter((c) => c.name !== vf.cats[0].name).map((c) => c.name + ' ×' + Math.pow(10, c.shrunk).toFixed(2) + ' (raw ×' + Math.pow(10, c.raw).toFixed(2) + ', n=' + c.n + ')').join(' · ');
  const droppedNames = cl.dropped.slice(0, 6).map((d) => d.slug).join(', ');
  $('#evidence').innerHTML =
    '<h2>Out-of-sample evidence — a term is kept only if it lowers the error on <span class="kept">both</span> tests</h2>' +
    '<div class="evgrid">' +
    '<div class="ev"><h3>Value ladder · typical miss, lower is better</h3><table><tr><th>Term</th><th>Leave-one-out</th><th>Walk-forward</th><th></th></tr>' + vRows + '</table></div>' +
    '<div class="ev"><h3>Odds ladder · Brier score · share called right</h3><table><tr><th>Term</th><th>Ten-fold CV</th><th>Walk-forward</th><th></th></tr>' + oRows + '</table></div>' +
    '<div class="ev"><h3>Range honesty · printed ranges vs real caps</h3><table><tr><th>Share of traded tokens</th><th>Leave-one-out</th><th>Walk-forward</th></tr>' + hRows + '</table></div>' +
    '</div>' +
    '<p class="coeffs">Fitted on this snapshot — value: log<sub>10</sub>(cap) = ' + vf.intercept.toFixed(4) + ' + ' + vf.slope.toFixed(4) + '·log<sub>10</sub>(TVL) + category offsets + ' + vf.growth_coef.toFixed(3) + '·(7-day growth, winsorized), on ' + vf.n + ' cleaned caps. Offsets, shrunk ×n/(n+' + vf.shrink_k + '): ' + offs + '. The cleaning pass set aside ' + cl.dropped.length + ' of ' + cl.raw + ' usable records whose caps sit more than tenfold from a first-pass line — ' + droppedNames + ' among them; a parent token\u2019s whole cap against one deployment\u2019s TVL is the typical case. Odds: the launch curve of ' + o.n_peers + ' dated peers, category curves blended toward the all-peer curve with ' + o.blend + ' pseudo-peers; the logistic is the ladder\u2019s last rung and is not used. Family test: ' + fam.n_family_comps + ' fit-sample rows share a name-family with another protocol and record a median ×' + Math.pow(10, fam.median_resid_dex).toFixed(1) + ' MORE cap than the line gives them — so no parent or family discount is taken anywhere on this board.</p>';
  $('#reading-slot').innerHTML = '<p class="reading">Reading it: the cleaning pass and the size curve do the heavy lifting; the shrunk category surface survives both tests where raw dummies flipped sign across time, and the growth term survives with it — hot weeks price slightly lower, not higher, once size is known. In the odds, the peers\u2019 own record beats the regression: age carries the signal, categories sharpen it, and the logistic is published as the losing rung. The ranges are the fit\u2019s own residuals, printed where they land: honest, and wide.</p>';
}

const TABS = [['all', 'All'], ['farm', 'Farm'], ['marginal', 'Marginal'], ['skip', 'Skip'], ['watchlist', 'Watchlist'], ['early', 'Early'], ['offlist', 'Off-list']];
function renderTabs() {
  const vc = verdictCounts();
  const n = { all: R.rows.length, farm: vc.FARM, marginal: vc.MARGINAL, skip: vc.SKIP, watchlist: 0, early: 0, offlist: 0 };
  for (const r of R.rows) n[tabOf(r)]++;
  $('#tabs').innerHTML = TABS.map((t) => '<button type="button" data-tab="' + t[0] + '" class="' + (state.tab === t[0] ? 'on' : '') + '">' + t[1] + ' <b>' + n[t[0]] + '</b></button>').join('');
  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => { state.tab = b.dataset.tab; renderTabs(); renderBoard(); });
}

function filteredRows() {
  let list = R.rows.map((r) => ({ r, e: scenarioEcon(r, state.plan, state.drop, state.weeks) })).filter(({ r, e }) => {
    if (state.tab === 'farm' || state.tab === 'marginal' || state.tab === 'skip') { if (e.verdict !== state.tab.toUpperCase()) return false; }
    else if (state.tab !== 'all' && tabOf(r) !== state.tab) return false;
    if (state.cat && r.category !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
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
  return list.sort(sorters[state.sort] || sorters.rank);
}
function renderBoard() {
  const list = filteredRows();
  $('#rowcount').textContent = 'Showing ' + list.length + ' of ' + R.rows.length + ' ranked protocols · scenario: plan ' + state.plan + '% of TVL (' + money(SC.plan_floor) + '–' + money(SC.plan_cap) + ') · drop ' + state.drop + '% of implied · ' + state.weeks + ' weeks · verdicts net of fees';
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
    '<td><span class="chip ' + e.verdict.toLowerCase() + '">' + e.verdict + ' · ' + hour(e.per_hour) + '</span><div class="sub">' + money(e.drop) + ' drop · ' + fee(e.fees) + ' fees</div></td>' +
    '<td class="r ' + (e.per_hour < 0 ? 'neg' : 'pos') + '">' + hour(e.per_hour) + '</td></tr>';
}

const kv = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>';
function openDetail(slug) {
  const r = bySlug.get(slug);
  if (!r) return;
  state.slug = slug;
  const e = scenarioEcon(r, SC.plan_pct * 100, SC.drop_share * 100, SC.weeks);
  const vf = R.model.value;
  const imp25 = Math.round(r.c25 * r.odds), imp75 = Math.round(r.c75 * r.odds), imp10 = Math.round(r.c10 * r.odds), imp90 = Math.round(r.c90 * r.odds);
  const catRow = vf.cats.find((c) => c.name === r.category);
  const catNote = !catRow
    ? 'no offset — its category is not one of the ' + vf.cats.length + ' fitted on five or more cleaned caps, so it prices on the line'
    : catRow.name === vf.cats[0].name
      ? 'the baseline category — every offset is measured from it'
      : 'shrunk offset: raw ×' + Math.pow(10, catRow.raw).toFixed(2) + ' pulled toward the line by its ' + catRow.n + ' records';
  const eq = (op, val, total) => '<div class="eqrow' + (total ? ' total' : '') + '"><span class="op">' + op + '</span><span class="val">' + val + '</span></div>';
  // Verdict panel: break-evens and the sensitivity grid, at the canonical scenario.
  const feesGas = Math.max(0, e.fees - 1);
  const beDrop = e.drop > 0 ? (e.fees / (r.implied_value_usd * (e.deposit / r.tvl_usd))) * 100 : null;
  const beOdds = e.drop > 0 ? r.odds * (e.fees / e.drop) : null;
  const vsCash = e.net - e.opp_cost;
  const gridDeps = [...new Set([1000, 3000, Math.round(e.deposit), 30000])].sort((a, b) => a - b);
  const gridShares = [3.5, 7, 14];
  const cell = (dep, share) => {
    const net = (share / 100) * r.implied_value_usd * (dep / r.tvl_usd) - e.fees;
    const cash = dep * SC.opp_rate * (SC.weeks / 52);
    const cls = net > cash ? 'good' : net > 0 ? 'mid' : 'bad';
    return '<td class="' + cls + '">' + (net < 0 ? '−' : '') + '$' + commas(Math.abs(net)) + '</td>';
  };
  const grid = '<table class="sgrid"><tr><th>net · drop \\ deposit</th>' + gridDeps.map((d) => '<th>' + money(d) + (d === Math.round(e.deposit) ? ' (plan)' : '') + '</th>').join('') + '</tr>' +
    gridShares.map((s) => '<tr><th>' + s + '%</th>' + gridDeps.map((d) => cell(d, s)).join('') + '</tr>').join('') + '</table>';
  const peers = '<table class="peers"><tr><th>Peer</th><th>Category</th><th class="r">TVL</th><th class="r">Cap</th><th class="r">Cap/TVL</th><th class="r">Cap ÷ model</th></tr>' +
    r.peers.map((p) => '<tr><td><span class="name">' + esc(p.name) + '</span></td><td>' + esc(p.category || '—') + '</td><td class="r">' + compact(p.tvl_usd) + '</td><td class="r">' + compact(p.mcap_usd) + '</td><td class="r">×' + p.mult.toFixed(2) + '</td><td class="r">×' + p.model_ratio.toFixed(2) + '</td></tr>').join('') + '</table>';
  const steps = r.plan.map((s, i) => {
    const time = s.per_week_min > 0 ? s.per_week_min + ' MIN/WK' : s.time_min + ' MIN';
    return '<div class="pstep"><div class="ph"><span class="n">' + (i + 1) + '</span><b>' + esc(s.phase) + '</b><span class="pchip">' + (s.cost_usd > 0 ? 'COST ' + fee(s.cost_usd) : 'COST $0') + '</span><span class="pchip">' + time + '</span></div><p>' + esc(s.text) + '</p></div>';
  }).join('');
  const el = $('#view-detail');
  el.hidden = false;
  el.innerHTML =
    '<button type="button" class="back" id="back">← Back to the board</button>' +
    '<h2>' + esc(r.name) + ' <span class="chip ' + e.verdict.toLowerCase() + '">' + e.verdict + ' · ' + hour(e.per_hour) + '</span></h2>' +
    '<div class="dcards">' +
    '<div class="card"><h3>How the figure is made</h3>' +
    eq('The fitted line at $100M of TVL', money(r.eq.ref_usd)) +
    eq('× <b>size</b> — TVL ' + money(r.tvl_usd) + ', to the ' + vf.slope.toFixed(4) + ' power', '×' + r.eq.size_factor.toFixed(4)) +
    eq('× <b>category</b> — ' + esc(r.category || 'uncategorised'), '×' + r.eq.cat_factor.toFixed(4)) +
    eq('× <b>7-day growth</b> — ' + pct(r.change_7d) + ' winsorized, coefficient ' + r.eq.growth_coef.toFixed(3), '×' + r.eq.growth_factor.toFixed(4)) +
    eq('= <b>value if it launches</b>', money(r.cond_value_usd), true) +
    eq('× <b>launch odds</b> — its cohort\u2019s record, below', Math.round(r.odds * 100) + '%') +
    eq('= <b>implied value</b>', money(r.implied_value_usd), true) +
    kv('Category term', catNote) +
    kv('Odds, as arithmetic', bpct(r.odds_parts.f_age) + ' of its cohort record a token by its age (' + years(r.age_days) + ') · ' + bpct(r.odds_parts.f_inf) + ' by the oldest age · (' + bpct(r.odds_parts.f_inf) + ' − ' + bpct(r.odds_parts.f_age) + ') ÷ (100% − ' + bpct(r.odds_parts.f_age) + ') = ' + bpct(r.odds)) +
    kv('Cohort', (r.category || 'uncategorised') + ' · ' + r.odds_parts.cohort_n + ' dated peers of ' + R.model.odds.n_peers + ', blended toward the all-peer curve') +
    kv('Conditional P25–P75', money(r.c25) + ' – ' + money(r.c75)) +
    kv('Implied P25–P75', money(imp25) + ' – ' + money(imp75)) +
    kv('Implied P10–P90', money(imp10) + ' – ' + money(imp90)) +
    (r.fam ? '<p class="note">Family: ' + r.fam.siblings.map((s) => esc(s.name) + (s.mcap_usd ? ' (cap ' + compact(s.mcap_usd) + ')' : '')).join(', ') + ' already record a token under this name. Flagged, not discounted — the fit sample\u2019s family products record more cap than the curve, not less (see the evidence above).</p>' : '') +
    '<p class="note">Tested, not used: a family or parent discount (the test runs the other way), the unshrunk category dummies (they flip across the time split), and chain count. Age enters through the odds, never the value.</p>' +
    '</div>' +
    '<div class="card"><h3>The verdict, at the stated scenario</h3>' +
    kv('Plan size', money(e.deposit) + ' (' + trimPct(SC.plan_pct * 100) + '% of TVL, ' + money(SC.plan_floor) + '–' + money(SC.plan_cap) + ')') +
    kv('Farmer pool', money(e.pool) + ' (' + trimPct(SC.drop_share * 100) + '% of implied value)') +
    kv('Expected drop', money(e.drop)) +
    kv('Fees', fee(e.fees) + ' (gas ' + fee(feesGas) + ' on ' + esc(r.gas_chain) + ' + $1.00 exchange withdrawal)') +
    kv('Net of fees', money(e.net) + ' for ' + e.hours.toFixed(1) + ' h of work · ' + hour(e.per_hour)) +
    kv('The same deposit in a T-bill', money(e.opp_cost) + ' at ' + trimPct(SC.opp_rate * 100) + '%/yr over ' + SC.weeks + ' weeks — ' + (vsCash >= 0 ? 'the farm beats cash by ' + money(vsCash) : 'cash beats the farm by ' + money(-vsCash))) +
    kv('Break-even drop share', beDrop === null ? '—' : beDrop.toFixed(2) + '% of implied (the model prints ' + trimPct(SC.drop_share * 100) + '%)') +
    kv('Break-even launch odds', beOdds === null ? '—' : bpct(beOdds) + ' (the cohort reads ' + bpct(r.odds) + ')') +
    kv('Verdict', e.verdict + ' (FARM ≥ $25/h · MARGINAL $5–25/h · SKIP below)') +
    '<h3 style="margin-top:8px">Sensitivity — net of fees</h3>' + grid +
    '<p class="note">Each cell re-runs the verdict\u2019s arithmetic at that drop share and deposit, fees held at the plan\u2019s. Green beats the T-bill on the same deposit; amber is positive but under cash.</p>' +
    '</div>' +
    '<div class="card"><h3>Nearest priced peers — the fit\u2019s exhibits</h3>' + peers +
    '<p class="note">The closest traded tokens to this protocol in the cleaned fit sample, by TVL. Cap ÷ model is what each peer\u2019s recorded cap does against this page\u2019s own curve: the scatter the honesty table above is made of.</p>' +
    '</div>' +
    '<div class="card"><h3>What the snapshot says</h3>' +
    kv('Rank', '#' + r.rank + ' of ' + R.rows.length + ' · refit range ' + r.rank_lo + '–' + r.rank_hi) +
    kv('Category', esc(r.category || 'Uncategorised')) +
    kv('Chains', esc(r.chains.join(', ') || '—')) +
    kv('TVL', money(r.tvl_usd) + ' · ' + pct(r.change_7d) + ' over 7 days') +
    kv('Listed', r.listed_at ? esc(r.listed_at.slice(0, 10)) : 'not recorded') +
    kv('Age', years(r.age_days) + (r.age_imputed ? ' (imputed at the median — the snapshot records no listing date)' : '')) +
    kv('Cheapest chain for gas', esc(r.gas_chain) + ' · ' + esc(r.gas_token) + ' at ' + fee(r.gas_per_tx) + ' per transaction (stated assumption)') +
    kv('Plan shape', r.arch.txs + ' transactions · ' + r.arch.setup_min + ' min setup · ' + r.arch.upkeep_min + ' min/week upkeep · ' + e.hours.toFixed(1) + ' h the season') +
    kv('Exit line', 'unwind below ' + money(r.exit.usd) + ' of TVL (' + r.exit.pct.toFixed(1) + '% — a worse week than 95% of this snapshot\u2019s protocols just recorded)') +
    kv('Cohort review', r.review ? 'half of its cohort\u2019s remaining launches arrive by ' + esc(r.review.date) + ' (' + r.review.months + ' months)' : 'its cohort\u2019s curve has flattened at its age — review next season') +
    (r.arch.no_retail ? kv('Retail access', 'none recorded — the verdict is SKIP whatever the arithmetic says') : '') +
    '</div>' +
    '<div class="card wide"><h3>The farm plan (canonical, from board.json)</h3><div class="psteps">' + steps + '</div></div>' +
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

function exportCsv() {
  const head = 'rank,slug,name,category,chains,tvl_usd,change_7d,odds,cond_value_usd,implied_value_usd,verdict,net_usd_per_hour';
  const q = (s) => '"' + String(s === null || s === undefined ? '' : s).replace(/"/g, '""') + '"';
  const lines = filteredRows().map(({ r, e }) => [r.rank, r.slug, q(r.name), q(r.category || ''), q(r.chains.join(' ')), r.tvl_usd, r.change_7d === null ? '' : r.change_7d, r.odds, r.cond_value_usd, r.implied_value_usd, e.verdict, e.per_hour.toFixed(2)].join(','));
  const blob = new Blob([head + '\n' + lines.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'token-radar-board.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function readParams() {
  const q = new URLSearchParams(location.search);
  if (q.get('view') === 'detail' && q.get('slug')) state.slug = q.get('slug');
  const v = (q.get('verdict') || '').toLowerCase();
  if (['farm', 'marginal', 'skip', 'watchlist', 'early', 'offlist'].includes(v)) state.tab = v;
  if (q.get('sort')) state.sort = q.get('sort');
  if (q.get('q')) state.q = q.get('q');
  if (q.get('cat')) state.cat = q.get('cat');
  if (q.get('chain')) state.chain = q.get('chain');
  const num = (key, target) => { const n = parseFloat(q.get(key) || ''); if (Number.isFinite(n) && n > 0) state[target] = n; };
  num('plan', 'plan'); num('drop', 'drop'); num('weeks', 'weeks');
}
function boot() {
  readParams();
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  $('#cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => '<option' + (c === state.cat ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
  const chainCounts = new Map();
  for (const r of R.rows) for (const ch of r.chains) chainCounts.set(ch, (chainCounts.get(ch) || 0) + 1);
  const chains = [...chainCounts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([c]) => c);
  $('#chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => '<option' + (c === state.chain ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
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
  $('#chain').addEventListener('change', () => { state.chain = $('#chain').value; renderBoard(); });
  $('#sort').addEventListener('change', () => { state.sort = $('#sort').value; renderBoard(); });
  $('#export').addEventListener('click', exportCsv);
  $('#reset').addEventListener('click', () => {
    state.plan = +(SC.plan_pct * 100).toFixed(4); state.drop = +(SC.drop_share * 100).toFixed(1); state.weeks = SC.weeks;
    state.q = ''; state.cat = ''; state.chain = ''; state.sort = 'rank'; state.tab = 'all';
    $('#plan').value = state.plan; $('#drop').value = state.drop; $('#weeks').value = state.weeks;
    $('#q').value = ''; $('#cat').value = ''; $('#chain').value = ''; $('#sort').value = 'rank';
    renderStats(); renderTabs(); renderBoard();
  });
  renderMeta(); renderStats(); renderAcct(); renderSeal(); renderEvidence(); renderTabs(); renderBoard(); renderLive();
  if (state.slug) openDetail(state.slug);
}
if (typeof document !== 'undefined' && document.querySelector) boot();
