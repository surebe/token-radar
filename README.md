# Token Launch Radar

A token launch radar for the make.fun bounty
[token-radar-01](https://make.fun/bounty/token-radar-01): it reads the sealed
DefiLlama snapshot of every protocol at or above $5M TVL, works out which ones
still record no token and are not a wrapped or staked product of one that
trades, ranks them by what their launch would be worth, and hands in a web
dashboard that shows the board, a detail view for each protocol and the steps
to farm it.

![bounty](https://make.fun/badge/token-radar-01.svg)
![rank](https://make.fun/badge/token-radar-01/surebe/token-radar/rank.svg)
![reward](https://make.fun/badge/token-radar-01/surebe/token-radar/reward.svg)

## The model

Nothing on the board is a hand-kept list. Running `main.ts` fits both halves
of the ranking on the snapshot itself, every run, from the snapshot's own
figures:

- **Conditional value** — an ordinary-least-squares fit of `log10(market cap)`
  on `log10(TVL)` over the protocols whose token already trades and records a
  market cap: `log10(mcap) = a + b · log10(TVL)`. The slope comes out near
  0.52, not 1: value scales sub-linearly with TVL, so the flat
  TVL-times-a-multiple guess overvalues the giants several-fold. Each value is
  published with the fit's own leave-one-out miss as an honesty band
  (about ÷3.4 / ×3.4).
- **Launch odds** — a logistic fit of "a token is recorded" on log TVL,
  log age, winsorized 7-day growth and category, over all 758 protocols.
- **Implied value** — conditional value × launch odds. The dashboard prints
  the fitted coefficients and the out-of-sample validation (leave-one-out and
  walk-forward time splits, this model against the flat-multiple baseline,
  Brier scores for the odds) next to the board, computed by the same run.

Wrapped, staked, bridged and exchange products of tokens that already trade
are excluded by the snapshot's own watchlist rule applied without its $50M
floor: of 342 protocols that record no token, 141 are set aside as products
or exchange records and 201 genuine pre-token protocols are ranked, the whole
40-protocol watchlist among them.

## Farm plans

Every row carries a farm plan built from a per-category archetype (the
action, a season's transaction count, setup and upkeep minutes, a sensible
minimum capital) with stated assumptions printed on the page: a 10% drop
share of launch value to farmers, a 16-week season, 5%/yr opportunity cost,
and per-transaction gas priced on the cheapest chain the protocol runs on.
The verdict (FARM / MARGINAL / SKIP) is the plan's net dollars per hour of
farmer time under those assumptions.

## Running it

Node 22, standard library only, no network:

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/`
and `out/dossier.json` (the judge's summary, built with
`vendor/makefun-board.ts`). The program is deterministic: two runs write the
same bytes.

Layout: `main.ts` (the program), `lib/model.ts` (snapshot parsing, the two
fits, the exclusions, the farm economics, the board), `dashboard/` (the page:
`index.html`, `app.css`, `app.js`), `screenshots/` (the board, a detail view
and a filtered view, rendered from this dashboard), `vendor/` (the kit's
dossier library, byte for byte).
