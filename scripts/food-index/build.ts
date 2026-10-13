// Map + filter a source into index records (JSONL), counting what's kept and
// dropped by reason. Uses the SAME mapper code as lookups do (src/food/).
import {execFileSync} from "node:child_process";
import {createReadStream, createWriteStream, readFileSync} from "node:fs";
import {createInterface} from "node:readline";
import type {Readable} from "node:stream";
import {createGunzip} from "node:zlib";

import {betterOffRecord, mapOffProduct} from "../../src/food/off";
import type {OffRecord, UsdaLabel, UsdaRecord} from "../../src/food/types";
import {dedupeUsda, mapUsdaFood, type UsdaDataType} from "../../src/food/usda";

export interface BuildReport {
  read: number;
  kept: number;
  dropped: Record<string, number>;
  merged: number; // OFF: ids that collided after normalization (kept the better one)
  repaired: number; // OFF: kept after undoing a per-serving inflation (OFF_REPAIR)
  truncated: boolean; // the input ended mid-file (only allowed for samples)
  crossCheck?: CrossCheckReport | {skipped: true}; // OFF only
}

// What the USDA cross-check changed (src/food/crossCheck.ts).
export interface CrossCheckReport {
  release?: string; // the label file (filled in by the pipeline)
  labels?: number; // usable labels read
  unusable?: number;
  conflicting?: number;
  fixedTooHigh: number; // serving under 100 g: OFF's numbers were too high
  fixedTooLow: number; // serving over 100 g: too low
  examples: Array<{id: string; name: string; servingGrams: number; kcal100Before: number;
    kcal100After: number; usdaKcal100: number}>; // the most-scanned fixes, for a read-through
}

const EXAMPLES = 10;

const count = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

async function writeJsonl(file: string, records: Iterable<object>): Promise<void> {
  const out = createWriteStream(file);
  for (const r of records) {
    if (!out.write(JSON.stringify(r) + "\n")) await new Promise((res) => out.once("drain", res));
  }
  await new Promise<void>((res, rej) => out.end((err?: Error | null) => err ? rej(err) : res()));
}

// OFF: a JSONL byte stream (gzipped or plain) → deduped records.
// `labels`: USDA Branded Foods labels for the cross-check (absent = skipped).
export async function buildOff(input: Readable, gzipped: boolean, outFile: string,
  opts: {allowTruncated: boolean; labels?: ReadonlyMap<string, UsdaLabel>}):
  Promise<BuildReport> {
  const report: BuildReport = {read: 0, kept: 0, dropped: {}, merged: 0, repaired: 0,
    truncated: false};
  const byId = new Map<string, OffRecord>();
  const stream = gzipped ? input.pipe(createGunzip()) : input;
  // .pipe() doesn't forward errors: a failed download part must end the read.
  if (stream !== input) input.on("error", (err) => stream.destroy(err));
  const lines = createInterface({input: stream, crlfDelay: Infinity});
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      report.read++;
      let product: unknown;
      try {
        product = JSON.parse(line);
      } catch {
        count(report.dropped, "bad_json");
        continue;
      }
      const r = mapOffProduct(product, {requireUs: true, labels: opts.labels});
      if (!r.ok) {
        count(report.dropped, r.reason);
        continue;
      }
      const prev = byId.get(r.record.id);
      if (prev) report.merged++;
      byId.set(r.record.id, prev ? betterOffRecord(prev, r.record) : r.record);
    }
  } catch (err) {
    // A partial sample (--limit-bytes) ends mid-gzip; a full download must not.
    if (!opts.allowTruncated) throw err;
    report.truncated = true;
  }
  report.kept = byId.size;
  const fixed: OffRecord[] = [];
  for (const r of byId.values()) {
    if (r.repaired === "overflow") report.repaired++;
    else if (r.repaired === "cross_check") fixed.push(r);
  }
  if (opts.labels) {
    const labels = opts.labels;
    report.crossCheck = {
      fixedTooHigh: fixed.filter((r) => r.servingGrams < 100).length,
      fixedTooLow: fixed.filter((r) => r.servingGrams > 100).length,
      examples: fixed.sort((a, b) => b.popularity - a.popularity).slice(0, EXAMPLES).map((r) => ({
        id: r.id, name: `${r.brand ? `${r.brand} ` : ""}${r.name}`, servingGrams: r.servingGrams,
        kcal100Before: Math.round(r.kcal100 * 100 / r.servingGrams),
        kcal100After: r.kcal100, usdaKcal100: labels.get(r.id)?.kcal100 ?? 0})),
    };
  }
  await writeJsonl(outFile, byId.values());
  return report;
}

// USDA: each file is a zip (downloaded) or a plain JSON file (test samples).
export async function buildUsda(files: Array<{path: string; type: UsdaDataType; key: string}>,
  outFile: string): Promise<BuildReport> {
  const report: BuildReport = {read: 0, kept: 0, dropped: {}, merged: 0, repaired: 0,
    truncated: false};
  const records: UsdaRecord[] = [];
  for (const f of files) {
    const text = f.path.endsWith(".zip") ?
      execFileSync("unzip", ["-p", f.path], {maxBuffer: 1024 * 1024 * 1024}).toString() :
      readFileSync(f.path, "utf8");
    const foods = (JSON.parse(text) as Record<string, unknown[]>)[f.key] ?? [];
    for (const food of foods) {
      report.read++;
      const r = mapUsdaFood(food, f.type);
      if (r.ok) records.push(r.record);
      else count(report.dropped, r.reason);
    }
  }
  const deduped = dedupeUsda(records);
  report.merged = records.length - deduped.length;
  report.kept = deduped.length;
  await writeJsonl(outFile, deduped);
  return report;
}

export function openFile(path: string): Readable {
  return createReadStream(path);
}
