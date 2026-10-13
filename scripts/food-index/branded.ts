// USDA FoodData Central Branded Foods labels, read for the cross-check
// (src/food/crossCheck.ts; README.md §How a build runs). The JSON
// release holds one product per line: a `{"BrandedFoods": [` header, then
// `{…},` lines, and the last product closes the file on its own line (`{…}]}`).
// Any line that doesn't parse fails the run — a format change must be seen.
import {spawn} from "node:child_process";
import {createReadStream} from "node:fs";
import {createInterface} from "node:readline";
import type {Readable} from "node:stream";

import {brandedLabel, labelsAgree} from "../../src/food/crossCheck";
import type {UsdaLabel} from "../../src/food/types";

export interface BrandedLabels {
  labels: Map<string, UsdaLabel>; // by normalized barcode
  read: number; // products in the file
  unusable: number; // not a trustworthy label (market, barcode, serving unit, missing values)
  conflicting: number; // barcodes dropped: two labels for one barcode disagree
}

const HEADER = "{\"BrandedFoods\": [";

// A zip streams through `unzip -p` (never unpacked on disk); anything else
// (a test sample) is read as it is. Also read by other tools
// (scripts/seed-foods/fdc.ts).
export function open(path: string): {stream: Readable; finished: () => Promise<void>; stop: () => void} {
  if (!path.endsWith(".zip")) {
    return {stream: createReadStream(path), finished: async () => undefined, stop: () => undefined};
  }
  const child = spawn("unzip", ["-p", path], {stdio: ["ignore", "pipe", "pipe"]});
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });
  const closed = new Promise<{code: number | null; err?: Error}>((res) => {
    child.once("error", (err) => res({code: null, err}));
    child.once("close", (code) => res({code}));
  });
  return {
    stream: child.stdout,
    finished: async () => {
      const {code, err} = await closed;
      if (err) throw err;
      if (code !== 0) throw new Error(`unzip ${path} exited ${code}: ${stderr.trim()}`);
    },
    stop: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}

export async function loadBrandedLabels(path: string): Promise<BrandedLabels> {
  const out: BrandedLabels = {labels: new Map(), read: 0, unusable: 0, conflicting: 0};
  const newest = new Map<string, number>(); // barcode → the fdcId kept
  const dropped = new Set<string>();
  const src = open(path);
  const lines = createInterface({input: src.stream, crlfDelay: Infinity});
  let n = 0;
  let ended = false;
  try {
    for await (const raw of lines) {
      n++;
      const line = raw.trim();
      if (!line || (n === 1 && line === HEADER)) continue;
      if (ended) throw new Error(`line ${n}: content after the file's closing product`);
      let body: string;
      if (line.endsWith(",")) body = line.slice(0, -1);
      else if (line.endsWith("]}")) {
        body = line.slice(0, -2);
        ended = true;
      } else throw new Error(`line ${n}: not a product line`);
      let food: unknown;
      try {
        food = JSON.parse(body);
      } catch {
        throw new Error(`line ${n}: not valid JSON`);
      }
      out.read++;
      const b = brandedLabel(food);
      if (!b) {
        out.unusable++;
        continue;
      }
      if (dropped.has(b.id)) continue;
      const kept = out.labels.get(b.id);
      if (!kept) {
        out.labels.set(b.id, b.label);
        newest.set(b.id, b.fdcId);
      } else if (!labelsAgree(kept, b.label)) {
        out.labels.delete(b.id);
        dropped.add(b.id);
      } else if (b.fdcId > (newest.get(b.id) ?? 0)) {
        out.labels.set(b.id, b.label);
        newest.set(b.id, b.fdcId);
      }
    }
    await src.finished();
    if (!ended) throw new Error(`${path}: no closing product line (a cut-off file?)`);
  } finally {
    src.stop();
  }
  out.conflicting = dropped.size;
  return out;
}
