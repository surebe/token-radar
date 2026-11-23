// The token launch radar program.
//
// Reads the sealed snapshot, fits the value and odds models on it (lib/model.ts),
// ranks the genuine pre-token protocols, and writes the handover the judge
// reads: board.json, the dashboard with its data file, the screenshots, and
// dossier.json, the canonical summary built last by the kit's own library.
//
// Node's standard library only, no network, deterministic: the same snapshot
// in, the same bytes out, on every run.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier, DossierError } from './vendor/makefun-board.ts';
import { buildRadar, dataScript, parseSnapshot, SnapshotError } from './lib/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOSSIER_TEXT_MAX = 65_536;
const DOSSIER_MAX_BYTES = 1_572_864;

/** The snapshot's path: --input when given, else the sandbox's /input. */
function snapshotPath(argv: string[]): string {
  const at = argv.indexOf('--input');
  if (at !== -1) {
    const value = argv[at + 1];
    if (value === undefined) throw new SnapshotError('--input needs a path after it');
    return value;
  }
  return '/input/snapshot.json';
}

/** Copy a directory tree into the output, entries in name order. */
function copyTree(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

/** Run the radar. Returns the process exit code. */
function main(): number {
  try {
    const snapshot = parseSnapshot(readFileSync(snapshotPath(process.argv.slice(2)), 'utf8'));
    const { board, data } = buildRadar(snapshot);
    if (data.issues.length > 0) {
      for (const issue of data.issues) console.error(`board: ${issue}`);
      return 1;
    }
    const out = process.env.MAKEFUN_OUTPUT_DIR ?? 'out';
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'board.json'), `${JSON.stringify(board, null, 1)}\n`);
    writeFileSync(join(out, 'data.js'), dataScript(data));
    copyTree(join(HERE, 'dashboard'), join(out, 'dashboard'));
    copyTree(join(HERE, 'screenshots'), join(out, 'screenshots'));
    // The dossier goes last: it summarizes the output directory as it stands.
    let dossier: Uint8Array;
    try {
      dossier = buildDossier(out, { text_max_bytes: DOSSIER_TEXT_MAX });
    } catch (error) {
      if (error instanceof DossierError) {
        console.error(`dossier: ${error.message}`);
        return 1;
      }
      throw error;
    }
    writeFileSync(join(out, 'dossier.json'), dossier);
    if (dossier.byteLength > DOSSIER_MAX_BYTES) {
      console.error(`dossier: ${dossier.byteLength} bytes, over the ${DOSSIER_MAX_BYTES} byte cap`);
      return 1;
    }
    const c = data.counts;
    console.log(`snapshot: ${c.total} protocols as of ${data.as_of} (${data.source}, floor ${data.floor_usd})`);
    console.log(`accounting: ${c.launched} launched set aside, ${c.pretoken} record no token, ${c.excluded} excluded as products of launched tokens, ${c.ranked} ranked`);
    console.log(`watchlist: ${c.watchlist_covered}/${c.watchlist} on the board`);
    console.log(`value fit: log10(mcap) = ${data.model.value.intercept} + ${data.model.value.slope} * log10(TVL) on ${data.model.value.n} traded tokens; leave-one-out miss ${data.model.validation.loo_model} dex against the flat multiple's ${data.model.validation.loo_baseline}`);
    console.log(`odds fit: cross-validated Brier ${data.model.odds.brier_cv} against a base-rate ${data.model.odds.brier_base}`);
    console.log(`board: ${board.length} rows, top ${board[0]!.slug} at ${board[0]!.implied_value_usd}`);
    console.log(`dossier: ${dossier.byteLength} bytes`);
    return 0;
  } catch (error) {
    if (error instanceof SnapshotError) {
      console.error(`snapshot: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main();
