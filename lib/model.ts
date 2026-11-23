// The radar's model: one sealed snapshot in, one ranked board out.
//
// Two fits, both made on the snapshot itself at run time, nothing carried in
// but the method:
//
//   conditional value   log10(mcap) = a + b * log10(TVL), an OLS fit over the
//                       protocols whose token already trades and records a
//                       market cap. The slope lands near 0.52: value scales
//                       sub-linearly with TVL, which a flat multiple misses.
//   launch odds         a logistic fit of "a token is recorded" over all 758
//                       protocols, on log TVL, log age, winsorized 7-day
//                       growth and category.
//
//   implied value       conditional value x launch odds.
//
// Both fits are validated out-of-sample inside this file (leave-one-out and
// walk-forward time splits for the value fit, stride-fold cross-validation
// for the odds) and the numbers are handed to the dashboard, so the page
// publishes the model's own measured miss next to its claims.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ------------------------------------------------------------------ dates

/**
 * Age in days on the phase convention: whole years at 365.25 days, whole
 * months at 30.44, plus the day remainder, all against the snapshot's as_of.
 * Fractional on purpose: the fits were specified against it, and it keeps a
 * protocol's age a pure function of the two dates the snapshot carries.
 */
export function ageDaysApprox(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const [ay, am, ad] = asOf.split('-').map(Number) as [number, number, number];
  const parts = listedAt.split('-').map(Number);
  const [y, m, d] = parts as [number, number, number];
  if (![ay, am, ad, y, m, d].every(Number.isFinite)) return null;
  return (ay - y) * 365.25 + (am - m) * 30.44 + (ad - d);
}

/** Age in whole calendar days, for display only; the fits use ageDaysApprox. */
export function ageDaysReal(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / 86_400_000));
}

/** 7-day growth as a fraction, winsorized to [-50%, +100%]; unreported is 0. */
export function growthFraction(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 0;
  return Math.max(-50, Math.min(100, change7d)) / 100;
}

// ------------------------------------------------------- small linear algebra

/** Solve A x = b by Gauss-Jordan elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-12) M[piv]![c] = 1e-12;
    const swap = M[c]!;
    M[c] = M[piv]!;
    M[piv] = swap;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/** Ordinary least squares with a whisper of ridge for numerical safety. */
export function ols(X: number[][], y: number[], ridge = 1e-9): number[] {
  const k = X[0]!.length;
  const XtX = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Xty = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    for (let a = 0; a < k; a++) {
      Xty[a]! += xi[a]! * y[i]!;
      for (let b = 0; b < k; b++) XtX[a]![b]! += xi[a]! * xi[b]!;
    }
  }
  for (let a = 0; a < k; a++) XtX[a]![a]! += ridge;
  return solveLinear(XtX, Xty);
}

/** The median of a non-empty list. */
export function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** The value at index floor(n/2) of the sorted list: the imputation median. */
function upperMedian(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const dot = (beta: number[], x: number[]): number => beta.reduce((sum, b, i) => sum + b * x[i]!, 0);

// ------------------------------------------------------------- the value fit

/** The protocols the value fit may learn from: a token trades and records a market cap above zero. */
export function valueFitRows(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** Median |log10 error| and the shares of predictions landing within 2x and 3x. */
function logErrors(preds: number[], actual: number[]): { med: number; within2: number; within3: number } {
  const errs = preds.map((p, i) => Math.abs(p - actual[i]!));
  const within = (factor: number) => errs.filter((e) => e <= Math.log10(factor)).length / errs.length;
  return { med: medianOf(errs), within2: within(2), within3: within(3) };
}

/** The flat-multiple baseline's one constant: the median recorded mcap/TVL. */
function medianMultiple(rows: SnapshotProtocol[]): number {
  return medianOf(rows.map((p) => p.mcap_usd! / p.tvl_usd));
}

/** One walk-forward split: fit on the oldest-listed rows, score the newest. */
export interface WalkForward {
  train_share: number;
  train: number;
  test: number;
  model: number;
  baseline: number;
}

/** Everything the value fit knows about itself, measured out-of-sample. */
export interface ValueFit {
  intercept: number;
  slope: number;
  n: number;
  in_sample: number;
  loo: number;
  loo_within2: number;
  loo_within3: number;
  /** The typical-miss band the board publishes: 10^loo, about 3.4. */
  band_factor: number;
  /** Leave-one-out residual quantiles in dex, the honest spread of the fit. */
  resid_q05: number;
  resid_q25: number;
  resid_q50: number;
  resid_q75: number;
  resid_q95: number;
  baseline_k: number;
  baseline_in_sample: number;
  baseline_loo: number;
  baseline_loo_within3: number;
  walk_forward: WalkForward[];
}

const valueFeatures = (p: SnapshotProtocol): number[] => [1, Math.log10(p.tvl_usd)];

/** Fit the conditional-value model and measure it honestly. */
export function fitValueModel(protocols: SnapshotProtocol[], asOf: string): ValueFit {
  const rows = valueFitRows(protocols);
  const y = rows.map((p) => Math.log10(p.mcap_usd!));
  const beta = ols(rows.map(valueFeatures), y);
  const pred = (p: SnapshotProtocol) => dot(beta, valueFeatures(p));

  // Leave-one-out for this fit and for the flat-multiple baseline alike.
  const looPred: number[] = [];
  const looBase: number[] = [];
  const looResid: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, j) => j !== i);
    const b = ols(train.map(valueFeatures), train.map((p) => Math.log10(p.mcap_usd!)));
    looPred.push(dot(b, valueFeatures(rows[i]!)));
    looBase.push(Math.log10(rows[i]!.tvl_usd * medianMultiple(train)));
    looResid.push(y[i]! - looPred[i]!);
  }
  const loo = logErrors(looPred, y);
  const looB = logErrors(looBase, y);
  const resid = [...looResid].sort((a, b) => a - b);
  const quantile = (q: number) => resid[Math.min(resid.length - 1, Math.floor(q * resid.length))]!;

  // Walk-forward: fit on the oldest-listed, test on the newest, two splits.
  const ageOf = (p: SnapshotProtocol) => ageDaysApprox(asOf, p.listed_at);
  const dated = rows.filter((p) => ageOf(p) !== null).sort((a, b) => ageOf(b)! - ageOf(a)!);
  const walk_forward: WalkForward[] = [];
  for (const share of [0.6, 0.5]) {
    const cut = Math.floor(dated.length * share);
    const train = dated.slice(0, cut);
    const test = dated.slice(cut);
    const b = ols(train.map(valueFeatures), train.map((p) => Math.log10(p.mcap_usd!)));
    const k = medianMultiple(train);
    const yTest = test.map((p) => Math.log10(p.mcap_usd!));
    walk_forward.push({
      train_share: share,
      train: train.length,
      test: test.length,
      model: logErrors(test.map((p) => dot(b, valueFeatures(p))), yTest).med,
      baseline: logErrors(test.map((p) => Math.log10(p.tvl_usd * k)), yTest).med,
    });
  }

  return {
    intercept: beta[0]!,
    slope: beta[1]!,
    n: rows.length,
    in_sample: logErrors(rows.map(pred), y).med,
    loo: loo.med,
    loo_within2: loo.within2,
    loo_within3: loo.within3,
    band_factor: Math.pow(10, loo.med),
    resid_q05: quantile(0.05),
    resid_q25: quantile(0.25),
    resid_q50: quantile(0.5),
    resid_q75: quantile(0.75),
    resid_q95: quantile(0.95),
    baseline_k: medianMultiple(rows),
    baseline_in_sample: logErrors(rows.map((p) => Math.log10(p.tvl_usd * medianMultiple(rows))), y).med,
    baseline_loo: looB.med,
    baseline_loo_within3: looB.within3,
    walk_forward,
  };
}

// -------------------------------------------------------------- the odds fit

/** Categories with at least five rows in the value-fit sample, first-appearance order; the first is the baseline. */
export function bigCategories(fitRows: SnapshotProtocol[]): string[] {
  const counts = new Map<string, number>();
  for (const p of fitRows) if (p.category !== null) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= 5).map(([c]) => c);
}

/** The median recorded age, the value imputed where a protocol lists none. */
export function medianAgeDays(protocols: SnapshotProtocol[], asOf: string): number {
  const ages = protocols.map((p) => ageDaysApprox(asOf, p.listed_at)).filter((a): a is number => a !== null);
  return upperMedian(ages);
}

/** One protocol's odds features: constant, log TVL, log age in years, winsorized growth, category dummies. */
export function oddsFeatures(p: SnapshotProtocol, asOf: string, catsBig: string[], medAge: number): number[] {
  const age = ageDaysApprox(asOf, p.listed_at) ?? medAge;
  const feats = [1, Math.log10(p.tvl_usd), Math.log10(Math.max(age, 1) / 365.25), growthFraction(p.change_7d)];
  for (const c of catsBig.slice(1)) feats.push(p.category === c ? 1 : 0);
  return feats;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Newton's method for the logistic fit, the analysis's own iteration. */
function fitLogistic(X: number[][], y: number[]): number[] {
  const k = X[0]!.length;
  let beta = new Array<number>(k).fill(0);
  for (let iter = 0; iter < 60; iter++) {
    const g = new Array<number>(k).fill(0);
    const H = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const xi = X[i]!;
      const pr = sigmoid(dot(beta, xi));
      const w = pr * (1 - pr) + 1e-9;
      for (let a = 0; a < k; a++) {
        g[a]! += xi[a]! * (y[i]! - pr);
        for (let b = 0; b < k; b++) H[a]![b]! += xi[a]! * xi[b]! * w;
      }
    }
    for (let a = 0; a < k; a++) H[a]![a]! += 1e-6;
    const step = solveLinear(H, g);
    beta = beta.map((b, i) => b + step[i]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return beta;
}

/** Everything the odds fit knows about itself. */
export interface OddsFit {
  beta: number[];
  cats_big: string[];
  med_age_days: number;
  brier_in_sample: number;
  /** Five stride folds over the snapshot's own order: deterministic, no seed to argue about. */
  brier_cv: number;
  brier_base_rate: number;
  base_rate: number;
}

/** Fit the launch-odds model over every protocol in the snapshot. */
export function fitOddsModel(protocols: SnapshotProtocol[], asOf: string): OddsFit {
  const catsBig = bigCategories(valueFitRows(protocols));
  const medAge = medianAgeDays(protocols, asOf);
  const X = protocols.map((p) => oddsFeatures(p, asOf, catsBig, medAge));
  const y = protocols.map((p) => (p.gecko_id !== null || p.symbol !== null ? 1 : 0));
  const beta = fitLogistic(X, y);
  const brier = (idx: number[], b: number[]) => idx.reduce((s, i) => s + (sigmoid(dot(b, X[i]!)) - y[i]!) ** 2, 0) / idx.length;
  const all = protocols.map((_, i) => i);
  const brier_in_sample = brier(all, beta);
  let cv = 0;
  for (let f = 0; f < 5; f++) {
    const test = all.filter((i) => i % 5 === f);
    const train = all.filter((i) => i % 5 !== f);
    const b = fitLogistic(
      train.map((i) => X[i]!),
      train.map((i) => y[i]!),
    );
    cv += brier(test, b) * (test.length / all.length);
  }
  const base_rate = y.reduce((s, v) => s + v, 0) / y.length;
  const brier_base_rate = y.reduce((s, v) => s + (base_rate - v) ** 2, 0) / y.length;
  return { beta, cats_big: catsBig, med_age_days: medAge, brier_in_sample, brier_cv: cv, brier_base_rate, base_rate };
}

/** A protocol's launch odds under a fitted model. */
export function launchOdds(fit: OddsFit, p: SnapshotProtocol, asOf: string): number {
  return sigmoid(dot(fit.beta, oddsFeatures(p, asOf, fit.cats_big, fit.med_age_days)));
}

/** A protocol's conditional value: what its token would be worth if it launched, under the value fit. */
export function conditionalValue(fit: ValueFit, tvlUsd: number): number {
  return Math.pow(10, fit.intercept + fit.slope * Math.log10(tvlUsd));
}

// --------------------------------------------------------------- exclusions

/**
 * The snapshot's own watchlist rule, minus its $50M floor, applied to every
 * protocol that records no token: a protocol is set aside when it is a
 * wrapped, staked or bridged product of one whose token already trades, an
 * exchange's own record, or a versioned pool of another protocol. The
 * reasons are returned as labels so the page can account for every one of
 * the 758 protocols: launched, ranked, or set aside for a named reason.
 */
export type ExclusionReason = 'category' | 'version-name' | 'wrapped-word' | 'exchange-name';

const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSIONED_NAME = /\s(V2|v2|2\.0|V3|v3|3\.0)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token: both token fields null, the snapshot's only consistent reading. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** The reasons a pre-token protocol is not a launch candidate, empty when it is a genuine one. */
export function exclusionReasons(p: SnapshotProtocol): ExclusionReason[] {
  const why: ExclusionReason[] = [];
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) why.push('category');
  if (VERSIONED_NAME.test(p.name)) why.push('version-name');
  if (WRAPPED_WORD.test(p.name)) why.push('wrapped-word');
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) why.push('exchange-name');
  return why;
}

// ------------------------------------------------------------- farm economics

/** Per-transaction gas in dollars by chain, a stated assumption of the farm model. */
export function gasPerTx(chain: string): number {
  if (chain === 'Ethereum') return 8;
  if (chain === 'Solana') return 0.02;
  if (['Arbitrum', 'Base', 'Optimism', 'Linea', 'Polygon', 'zkSync Era', 'Scroll', 'Mantle', 'Blast', 'Mode', 'Taiko', 'Metis'].includes(chain)) return 0.15;
  return 0.5;
}

/** The cheapest chain a protocol runs on, and its gas price: where a farmer would work. */
export function cheapestChain(p: SnapshotProtocol): { chain: string; gas: number } {
  let best: { chain: string; gas: number } | null = null;
  for (const chain of p.chains) {
    const gas = gasPerTx(chain);
    if (best === null || gas < best.gas) best = { chain, gas };
  }
  return best ?? { chain: 'its main chain', gas: 0.5 };
}

/** One category's way of being farmed: the action, a season's shape, and a sensible minimum position. */
export interface Archetype {
  /** The core action, as a sentence a farmer can follow. */
  action: (name: string, chain: string) => string;
  /** The weekly upkeep action, a noun phrase. */
  upkeep: string;
  txs: number;
  setup_min: number;
  upkeep_min: number;
  capital: number;
  /** True when the category offers no surface a retail wallet can farm. */
  no_retail: boolean;
  note: string | null;
}

const ARCHETYPES: Record<string, Partial<Archetype>> = {
  Dexs: { txs: 30, setup_min: 20, upkeep_min: 30, capital: 1000, upkeep: 'rebalance the LP position and add one swap', action: (n, c) => `Provide liquidity to ${n}'s main pool on ${c} and make swaps through it each week.` },
  Lending: { txs: 15, setup_min: 15, upkeep_min: 15, capital: 1000, upkeep: 'check the health factor and roll the borrow', action: (n, c) => `Supply USDC to ${n} on ${c} and run one careful borrow-and-resupply loop against it.` },
  'Uncollateralized Lending': { txs: 15, setup_min: 15, upkeep_min: 15, capital: 1000, upkeep: 'review the pool and roll the position', action: (n, c) => `Supply USDC to a ${n} pool on ${c} and keep the credit position open.` },
  'Risk Curators': { txs: 6, setup_min: 10, upkeep_min: 5, capital: 2500, upkeep: 'confirm the vault is still allocating as described', action: (n, c) => `Deposit USDC into a ${n} curated vault on ${c} and hold the vault shares.` },
  'Onchain Capital Allocator': { txs: 6, setup_min: 10, upkeep_min: 5, capital: 2500, upkeep: 'confirm the allocation has not changed character', action: (n, c) => `Deposit USDC into a ${n} allocation vault on ${c} and hold the shares.` },
  Yield: { txs: 6, setup_min: 10, upkeep_min: 5, capital: 2500, upkeep: 'check the yield source is unchanged', action: (n, c) => `Deposit into ${n}'s yield vault on ${c} and hold the position.` },
  'Yield Aggregator': { txs: 6, setup_min: 10, upkeep_min: 5, capital: 2500, upkeep: 'check which vault the aggregator routes to', action: (n, c) => `Deposit into ${n} on ${c} and let the aggregator route the position.` },
  CDP: { txs: 10, setup_min: 20, upkeep_min: 15, capital: 2500, upkeep: 'check the collateral ratio and top up if it thins', action: (n, c) => `Open a ${n} vault on ${c}: deposit collateral and mint its stablecoin against it.` },
  'CDP Manager': { txs: 10, setup_min: 20, upkeep_min: 15, capital: 2500, upkeep: 'check the managed vault ratios', action: (n, c) => `Deposit collateral through ${n} on ${c} and let it manage the minted position.` },
  'Basis Trading': { txs: 6, setup_min: 10, upkeep_min: 5, capital: 2500, upkeep: 'confirm the basis position is still hedged', action: (n, c) => `Deposit USDC into ${n}'s basis vault on ${c} and hold through the season.` },
  CeDeFi: { txs: 6, setup_min: 10, upkeep_min: 5, capital: 2500, upkeep: 'confirm the strategy allocation is unchanged', action: (n, c) => `Deposit into ${n}'s managed strategy on ${c} and hold the position.` },
  Restaking: { txs: 8, setup_min: 15, upkeep_min: 10, capital: 1000, upkeep: 'check the operator set and restaked balance', action: (n, c) => `Restake through ${n} on ${c} and keep the restaking receipt.` },
  'Collateral Markets': { txs: 8, setup_min: 15, upkeep_min: 10, capital: 1000, upkeep: 'check the collateral markets it serves', action: (n, c) => `Post collateral into ${n} on ${c} and keep the position live.` },
  'Staking Pool': { txs: 8, setup_min: 15, upkeep_min: 10, capital: 1000, upkeep: 'check the pool validator and balance', action: (n, c) => `Stake through ${n}'s pool on ${c} and keep the staking position.` },
  RWA: { txs: 8, setup_min: 25, upkeep_min: 10, capital: 5000, upkeep: 'check the asset reports and the position', note: 'Many RWA issuers gate deposits behind KYC or an allowlist; complete it before funding, and treat a refusal as the end of this farm.', action: (n, c) => `Deposit into ${n}'s real-world-asset product on ${c} once its access checks clear.` },
  Chain: { txs: 40, setup_min: 45, upkeep_min: 30, capital: 500, upkeep: 'use two native dApps and bridge a small amount', action: (n, c) => `Bridge funds to ${n} and use its native dApps — swaps, a lending market, a name or NFT mint — as a resident, not a tourist.` },
  'Prediction Market': { txs: 50, setup_min: 30, upkeep_min: 60, capital: 500, upkeep: 'trade both sides of two markets and provide liquidity', action: (n, c) => `Trade on ${n}: take positions on both sides of liquid markets and rest small limit orders.` },
  Payments: { no_retail: true, txs: 0, setup_min: 0, upkeep_min: 0, capital: 1000, upkeep: 'none', action: (n) => `${n} moves money; it keeps no deposit, pool or staking surface a retail wallet can farm.` },
  Derivatives: { txs: 20, setup_min: 25, upkeep_min: 30, capital: 1000, upkeep: 'roll one small hedged position', action: (n, c) => `Deposit margin on ${n} (${c}) and keep one small, hedged position open.` },
  'Interest Rate Derivatives': { txs: 20, setup_min: 25, upkeep_min: 30, capital: 1000, upkeep: 'roll the rate position', action: (n, c) => `Open a small interest-rate position on ${n} (${c}) and roll it through the season.` },
  'Options Vault': { txs: 8, setup_min: 15, upkeep_min: 10, capital: 1000, upkeep: 'check the weekly option epoch', action: (n, c) => `Deposit into a ${n} options vault on ${c} and stay through its weekly epochs.` },
  'Leveraged Farming': { txs: 24, setup_min: 25, upkeep_min: 20, capital: 1000, upkeep: 'check the leverage ratio and rebalance', action: (n, c) => `Open a conservative leveraged farm on ${n} (${c}), well under its maximum leverage.` },
  Farm: { txs: 20, setup_min: 20, upkeep_min: 20, capital: 1000, upkeep: 'harvest and re-stake the position', action: (n, c) => `Stake into ${n}'s farm on ${c} and keep the position compounding.` },
  'Liquidity Manager': { txs: 8, setup_min: 15, upkeep_min: 10, capital: 2500, upkeep: 'check the managed range and fees', action: (n, c) => `Deposit into a ${n} managed liquidity vault on ${c}.` },
  'Stablecoin Wrapper': { txs: 8, setup_min: 15, upkeep_min: 10, capital: 2500, upkeep: 'check the wrapper backing', action: (n, c) => `Mint or deposit the stable asset through ${n} on ${c} and hold it.` },
  'Dual-Token Stablecoin': { txs: 8, setup_min: 15, upkeep_min: 10, capital: 2500, upkeep: 'check both sides of the pair stay balanced', action: (n, c) => `Mint ${n}'s stablecoin on ${c} against its paired asset and hold both sides as designed.` },
  'Anchor BTC': { txs: 6, setup_min: 20, upkeep_min: 5, capital: 2500, upkeep: 'check the BTC reserve accounting', action: (n, c) => `Deposit BTC value into ${n} on ${c} and hold the anchored position.` },
  'Decentralized BTC': { txs: 6, setup_min: 20, upkeep_min: 5, capital: 2500, upkeep: 'check the mint and redemption queues', action: (n, c) => `Mint or deposit through ${n} on ${c} and hold the BTC-backed position.` },
  'Cross Chain Bridge': { txs: 20, setup_min: 20, upkeep_min: 15, capital: 500, upkeep: 'bridge a small amount each way', action: (n, c) => `Bridge funds through ${n} in both directions and use the bridged funds on ${c}.` },
  'OTC Marketplace': { txs: 10, setup_min: 20, upkeep_min: 15, capital: 2500, upkeep: 'refresh two standing offers', action: (n, c) => `Post and fill small offers on ${n} (${c}) through the season.` },
  Insurance: { txs: 6, setup_min: 15, upkeep_min: 5, capital: 2500, upkeep: 'check the cover book and capacity', action: (n, c) => `Underwrite or buy cover through ${n} on ${c} and keep the policy live.` },
  'Governance Incentives': { txs: 12, setup_min: 15, upkeep_min: 15, capital: 1000, upkeep: 'vote in the live proposals', action: (n, c) => `Stake into ${n}'s incentive program on ${c} and vote in its governance.` },
  'Crypto Card Issuer': { txs: 30, setup_min: 15, upkeep_min: 20, capital: 500, upkeep: 'route ordinary spending through the card', action: (n) => `Take ${n}'s card and route ordinary spending through it, keeping the account active.` },
  Privacy: { txs: 12, setup_min: 20, upkeep_min: 10, capital: 1000, upkeep: 'make one private transfer', action: (n, c) => `Deposit into ${n} on ${c} and make private transfers through the season.` },
  Indexes: { txs: 6, setup_min: 10, upkeep_min: 5, capital: 1000, upkeep: 'check the index composition', action: (n, c) => `Buy and hold a ${n} index token on ${c} through the season.` },
};

const GENERIC_ARCHETYPE: Archetype = {
  txs: 10,
  setup_min: 15,
  upkeep_min: 10,
  capital: 1000,
  no_retail: false,
  note: null,
  upkeep: 'repeat the core action once',
  action: (n, c) => `Deposit into ${n} on ${c} and use its main product as a regular user.`,
};

/** The archetype a category farms by: its own row, else the generic deposit. */
export function archetypeFor(category: string | null): Archetype {
  const base: Archetype = { ...GENERIC_ARCHETYPE };
  if (category !== null && ARCHETYPES[category] !== undefined) return { ...base, ...ARCHETYPES[category] };
  return base;
}

/** The farm model's stated assumptions, printed on the page beside the verdicts. */
export const FARM_DEFAULTS = { drop_share: 0.1, weeks: 16, opp_rate: 0.05 };

export interface FarmParams {
  drop_share: number;
  weeks: number;
  opp_rate: number;
  capital: number;
}

/** One row's farm economics under stated assumptions. */
export interface FarmEcon {
  pool: number;
  intensity: number;
  gross: number;
  gas_cost: number;
  opp_cost: number;
  hours: number;
  net: number;
  per_hour: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
}

/** The verdict arithmetic of MODEL §6, in one place so the page and the plan agree. */
export function farmEconomics(condValue: number, tvl: number, arch: Archetype, gasPerTxUsd: number, params: FarmParams): FarmEcon {
  const pool = condValue * params.drop_share;
  const intensity = pool / tvl;
  const gross = intensity * params.capital;
  const gas_cost = arch.txs * gasPerTxUsd;
  const opp_cost = params.capital * params.opp_rate * (params.weeks / 52);
  const hours = (arch.setup_min + arch.upkeep_min * params.weeks) / 60;
  const net = gross - gas_cost - opp_cost;
  const per_hour = hours > 0 ? net / hours : 0;
  const verdict = arch.no_retail || per_hour < 5 ? 'SKIP' : per_hour >= 25 ? 'FARM' : 'MARGINAL';
  return { pool, intensity, gross, gas_cost, opp_cost, hours, net, per_hour, verdict };
}

// ------------------------------------------------------------ number formats

/** Whole dollars with comma grouping, no locale dependence: "$60,522,077". */
export function usd(n: number): string {
  const neg = n < 0;
  const digits = String(Math.round(Math.abs(n)));
  return `${neg ? '-$' : '$'}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** A small rate as a plain decimal with its significant digits kept: "0.003275". */
export function rate(x: number): string {
  if (x === 0) return '0';
  const s = x.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

/** Signed dollars an hour: "$7.13", "-$12.34". */
export function usdHour(n: number): string {
  const v = Math.abs(n).toFixed(2);
  return n < 0 ? `-$${v}` : `$${v}`;
}

// --------------------------------------------------------------- farm steps

/** A protocol's farm plan: six steps, each the archetype instantiated with the row's own numbers. */
export function farmSteps(p: SnapshotProtocol, arch: Archetype, gas: { chain: string; gas: number }, econ: FarmEcon, params: FarmParams): string[] {
  const chain = gas.chain;
  const weeks = params.weeks;
  const steps: string[] = [];
  steps.push(
    `Open a fresh wallet for this farm and fund it on ${chain}, the cheapest chain ${p.name} runs on at about ${usd(gas.gas)} a transaction. Cost: about ${usd(gas.gas * 2)} for the funding transactions. Time: 10 minutes, once, and keep the seed phrase offline.`,
  );
  if (arch.no_retail) {
    steps.push(
      `${arch.action(p.name, chain)} There is no position to open and nothing to stake, so the honest plan is not to farm it: the verdict is SKIP at any capital, and the steps below are the monitoring routine only.`,
    );
  } else {
    steps.push(
      `${arch.action(p.name, chain)} Cost: ${usd(params.capital)} of capital plus about ${usd(econ.gas_cost)} of gas across roughly ${arch.txs} transactions for the season. Time: ${arch.setup_min} minutes to set up.${arch.note !== null ? ` Note: ${arch.note}` : ''}`,
    );
  }
  steps.push(
    `Stay a user for the ${weeks}-week season: ${arch.upkeep}, about ${arch.upkeep_min} minutes a week (${arch.setup_min + arch.upkeep_min * weeks} minutes of your time in all). One deposit and silence reads as a bot farm; a season of ordinary use is the position.`,
  );
  steps.push(
    arch.no_retail
      ? `The arithmetic, on paper only: a launch worth ${usd(econ.pool / params.drop_share)} with ${Math.round(params.drop_share * 100)}% to farmers is a ${usd(econ.pool)} pool over ${usd(p.tvl_usd)} of TVL, ${rate(econ.intensity)} per $1 in — but with no deposit, pool or staking surface, no retail position can take a share of it, which is why the verdict stays SKIP.`
      : `The arithmetic, at the stated assumptions: a launch worth ${usd(econ.pool / params.drop_share)} with ${Math.round(params.drop_share * 100)}% to farmers is a ${usd(econ.pool)} pool over ${usd(p.tvl_usd)} of TVL, ${rate(econ.intensity)} per $1 in. A ${usd(params.capital)} position expects about ${usd(econ.gross)} before costs and ${usd(econ.net)} after gas and the 5%/yr cost of locked capital: ${usdHour(econ.per_hour)} an hour, a ${econ.verdict}.`,
  );
  const growth = p.change_7d === null ? 'unreported in the snapshot' : `${p.change_7d > 0 ? '+' : ''}${p.change_7d}% over the snapshot's last 7 days`;
  steps.push(
    `Monitor weekly: ${p.name}'s TVL trend (${growth}), its own announcements, and any points or rewards page it opens. If it launches, claim only from the link the protocol itself publishes — a claim never costs a fee, and a page asking for one is a phish.`,
  );
  steps.push(
    `Exit with discipline: if no token or points program has appeared by the end of the ${weeks}-week season, unwind in one session (about ${usd(gas.gas * 3)} of gas, 15 minutes) and write the wallet, the dates and every transaction into a farm log, so the next season starts from a record, not a memory.`,
  );
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ------------------------------------------------------------------- board

/** One ranked row of the board: the shape board.json carries. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  cond_value_usd: number;
  odds: number;
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  net_usd_per_hour: number;
  farm_steps: string[];
}

/** One row as the dashboard receives it: the board row plus its whole working. */
export interface RadarRow extends BoardRow {
  age_imputed: boolean;
  gas_chain: string;
  gas_per_tx: number;
  arch: { txs: number; setup_min: number; upkeep_min: number; capital: number };
  econ: { pool: number; intensity: number; gross: number; gas_cost: number; opp_cost: number; hours: number; net: number; per_hour: number };
}

/** Everything the dashboard renders: the board, the model, the accounting, the launched set. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  counts: { total: number; launched: number; pretoken: number; excluded: number; ranked: number; fit_sample: number; watchlist: number; watchlist_covered: number };
  reason_counts: Record<ExclusionReason, number>;
  model: {
    value: { intercept: number; slope: number; n: number; band_factor: number; resid_q25: number; resid_q75: number };
    baseline_k: number;
    validation: {
      in_model: number;
      in_baseline: number;
      loo_model: number;
      loo_baseline: number;
      within2_model: number;
      within3_model: number;
      within3_baseline: number;
      walk_forward: WalkForward[];
    };
    odds: { brier_cv: number; brier_in: number; brier_base: number; base_rate: number; beta_const: number; beta_tvl: number; beta_age: number; beta_growth: number };
  };
  rows: RadarRow[];
  live: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number | null; change_7d: number | null }[];
  defaults: { drop_share: number; weeks: number; opp_rate: number };
  issues: string[];
}

const round = (x: number, dp: number): number => {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
};

/** Fit the models, apply the exclusions, rank the genuine pre-token protocols, and assemble everything. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; data: RadarData } {
  const valueFit = fitValueModel(snapshot.protocols, snapshot.as_of);
  const oddsFit = fitOddsModel(snapshot.protocols, snapshot.as_of);
  const watch = new Set(snapshot.watchlist);
  const launched: SnapshotProtocol[] = [];
  const pretoken: SnapshotProtocol[] = [];
  for (const p of snapshot.protocols) (recordsNoToken(p) ? pretoken : launched).push(p);

  const reason_counts: Record<ExclusionReason, number> = { category: 0, 'version-name': 0, 'wrapped-word': 0, 'exchange-name': 0 };
  const genuine: SnapshotProtocol[] = [];
  for (const p of pretoken) {
    const why = exclusionReasons(p);
    if (why.length === 0) genuine.push(p);
    else for (const w of why) reason_counts[w]++;
  }

  const scored = genuine.map((p) => {
    const cond = conditionalValue(valueFit, p.tvl_usd);
    const odds = launchOdds(oddsFit, p, snapshot.as_of);
    const implied = Math.max(1, Math.round(cond * odds));
    const arch = archetypeFor(p.category);
    const gas = cheapestChain(p);
    const params: FarmParams = { ...FARM_DEFAULTS, capital: arch.capital };
    const econ = farmEconomics(cond, p.tvl_usd, arch, gas.gas, params);
    return { p, cond, odds, implied, arch, gas, econ, steps: farmSteps(p, arch, gas, econ, params) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = [];
  const rows: RadarRow[] = [];
  scored.forEach((s, i) => {
    const row: BoardRow = {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: ageDaysReal(snapshot.as_of, s.p.listed_at),
      watchlist: watch.has(s.p.slug),
      cond_value_usd: Math.round(s.cond),
      odds: round(s.odds, 4),
      implied_value_usd: s.implied,
      band_low_usd: Math.round(s.implied / valueFit.band_factor),
      band_high_usd: Math.round(s.implied * valueFit.band_factor),
      verdict: s.econ.verdict,
      net_usd_per_hour: round(s.econ.per_hour, 2),
      farm_steps: s.steps,
    };
    board.push(row);
    rows.push({
      ...row,
      age_imputed: s.p.listed_at === null,
      gas_chain: s.gas.chain,
      gas_per_tx: s.gas.gas,
      arch: { txs: s.arch.txs, setup_min: s.arch.setup_min, upkeep_min: s.arch.upkeep_min, capital: s.arch.capital },
      econ: {
        pool: Math.round(s.econ.pool),
        intensity: s.econ.intensity,
        gross: Math.round(s.econ.gross),
        gas_cost: Math.round(s.econ.gas_cost * 100) / 100,
        opp_cost: Math.round(s.econ.opp_cost * 100) / 100,
        hours: round(s.econ.hours, 1),
        net: Math.round(s.econ.net),
        per_hour: round(s.econ.per_hour, 2),
      },
    });
  });

  const live = launched
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, 24);

  const data: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    counts: {
      total: snapshot.protocols.length,
      launched: launched.length,
      pretoken: pretoken.length,
      excluded: pretoken.length - genuine.length,
      ranked: board.length,
      fit_sample: valueFit.n,
      watchlist: snapshot.watchlist.length,
      watchlist_covered: board.filter((r) => r.watchlist).length,
    },
    reason_counts,
    model: {
      value: { intercept: round(valueFit.intercept, 4), slope: round(valueFit.slope, 4), n: valueFit.n, band_factor: round(valueFit.band_factor, 2), resid_q25: round(valueFit.resid_q25, 3), resid_q75: round(valueFit.resid_q75, 3) },
      baseline_k: round(valueFit.baseline_k, 4),
      validation: {
        in_model: round(valueFit.in_sample, 3),
        in_baseline: round(valueFit.baseline_in_sample, 3),
        loo_model: round(valueFit.loo, 3),
        loo_baseline: round(valueFit.baseline_loo, 3),
        within2_model: round(valueFit.loo_within2, 3),
        within3_model: round(valueFit.loo_within3, 3),
        within3_baseline: round(valueFit.baseline_loo_within3, 3),
        walk_forward: valueFit.walk_forward.map((w) => ({ ...w, model: round(w.model, 3), baseline: round(w.baseline, 3) })),
      },
      odds: {
        brier_cv: round(oddsFit.brier_cv, 4),
        brier_in: round(oddsFit.brier_in_sample, 4),
        brier_base: round(oddsFit.brier_base_rate, 4),
        base_rate: round(oddsFit.base_rate, 3),
        beta_const: round(oddsFit.beta[0]!, 3),
        beta_tvl: round(oddsFit.beta[1]!, 3),
        beta_age: round(oddsFit.beta[2]!, 3),
        beta_growth: round(oddsFit.beta[3]!, 3),
      },
    },
    rows,
    live,
    defaults: { ...FARM_DEFAULTS },
    issues: [],
  };
  data.issues = boardIssue(board, snapshot);
  return { board, data };
}

/** The board checked the way the sealed scorer checks it; an empty list is a clean board. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string[] {
  const issues: string[] = [];
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  if (board.length < 100 || board.length > 4000) issues.push(`the board has ${board.length} rows, outside 100..4000`);
  let previous = Number.POSITIVE_INFINITY;
  let allEqual = true;
  board.forEach((row, i) => {
    if (!slugs.has(row.slug)) issues.push(`row ${i + 1} names ${row.slug}, which is not in the snapshot`);
    if (row.rank !== i + 1) issues.push(`row ${i + 1} carries rank ${row.rank}`);
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 1e14) issues.push(`row ${i + 1} has an unusable implied value`);
    if (row.implied_value_usd > previous) issues.push(`row ${i + 1} rises above the row before it`);
    if (i > 0 && row.implied_value_usd !== board[0]!.implied_value_usd) allEqual = false;
    previous = row.implied_value_usd;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      issues.push(`row ${i + 1} has the wrong number of farm steps`);
    } else {
      for (const step of row.farm_steps) {
        const len = step.trim().length;
        if (len < 20 || len > 600) issues.push(`row ${i + 1} has a farm step of ${len} characters`);
      }
    }
  });
  if (board.length > 1 && allEqual) issues.push('every implied value on the board is the same');
  for (const slug of snapshot.watchlist) if (!board.some((r) => r.slug === slug)) issues.push(`watchlist protocol ${slug} is missing from the board`);
  return issues;
}

/** The dashboard's data file: the whole radar as one assignment. */
export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}
