// One import run (README.md §How a build runs): download → map + filter →
// clear leftovers → create a dated collection → import → checks → switch the
// alias → delete the old collection and the download. Any failure before the
// switch changes nothing for users: the alias still points at the old data.
import {createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {basename, join} from "node:path";
import {createInterface} from "node:readline";

import {offCollectionSchema, usdaCollectionSchema} from "../../src/food/schema";
import type {UsdaLabel} from "../../src/food/types";
import {loadBrandedLabels} from "./branded";
import {buildOff, buildUsda, openFile, type BuildReport, type CrossCheckReport} from "./build";
import {DEFAULT_CHECKS, loadChecks, runChecks} from "./checks";
import {BRANDED, IMPORT, SOURCES, type Source} from "./config";
import {downloadFile, downloadFileInParts, downloadInParts, readParts} from "./download";
import {TypesenseAdmin} from "./typesense";

export interface ImportOptions {
  source: Source;
  baseUrl: string; // Typesense, e.g. http://localhost:8108
  apiKey: string; // ADMIN key
  dryRun?: boolean; // stop after map + filter (no Typesense)
  input?: string; // a local file instead of downloading (OFF: .jsonl/.jsonl.gz; USDA: a dir)
  limitBytes?: number; // OFF: read only the first N bytes of the dump (a sample)
  minCount?: number; // overrides the source's first-run floor
  checksFile?: string; // overrides DEFAULT_CHECKS
  keepDownload?: boolean;
  // OFF: the USDA cross-check's label file — a local zip or sample instead of
  // the cached/downloaded release. Required with `input` (a sample run never
  // downloads it).
  branded?: string;
  crossCheck?: boolean; // OFF: false skips the cross-check (logged; the report says so)
  minLabels?: number; // overrides BRANDED.minLabels
  workDir?: string;
  now?: Date;
  log?: (m: string) => void;
}

export interface ImportResult {
  ok: boolean;
  collection?: string;
  switched: boolean;
  previous?: string | null;
  report: BuildReport;
  failures: string[];
  reportFile: string;
}

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

const BRANDED_PREFIX = "FoodData_Central_branded_food_json_";

// The pinned Branded Foods release, from cacheDir/fdc or downloaded once
// (~200 MB, in ranged parts); older releases are deleted when a new one lands.
async function brandedRelease(work: string, log: (m: string) => void): Promise<string> {
  const dir = join(work, "fdc");
  mkdirSync(dir, {recursive: true});
  const name = BRANDED.url.split("/").pop() as string;
  const zip = join(dir, name);
  if (!existsSync(zip)) {
    log(`downloading ${name} (once per USDA release)…`);
    await downloadFileInParts(BRANDED.url, zip, log);
    for (const f of readdirSync(dir)) {
      if (f.startsWith(BRANDED_PREFIX) && f !== name) {
        rmSync(join(dir, f), {recursive: true, force: true});
      }
    }
  }
  return zip;
}

// The cross-check's labels, before the long OFF download so a broken file
// fails fast; undefined = skipped on purpose.
async function crossCheckLabels(o: ImportOptions, work: string, log: (m: string) => void):
  Promise<{labels: ReadonlyMap<string, UsdaLabel>;
    info: Pick<CrossCheckReport, "release" | "labels" | "unusable" | "conflicting">} | undefined> {
  if (o.crossCheck === false) {
    log("WARNING — the USDA cross-check is SKIPPED (--no-cross-check): products with OFF's " +
      "per-serving mistake keep their wrong numbers in this build");
    return undefined;
  }
  if (o.input && !o.branded) {
    throw new Error("--input needs --branded <file> (or --no-cross-check): a sample run never " +
      "downloads the USDA Branded Foods release");
  }
  const file = o.branded ?? await brandedRelease(work, log);
  log(`reading USDA Branded Foods labels (${basename(file)})…`);
  const b = await loadBrandedLabels(file);
  const min = o.minLabels ?? BRANDED.minLabels;
  if (b.labels.size < min) {
    throw new Error(`only ${b.labels.size} usable USDA labels in ${file} (floor ${min}) — ` +
      "the Branded Foods file looks broken; nothing was touched");
  }
  const release = /(\d{4}-\d{2}-\d{2})/.exec(basename(file))?.[1] ?? basename(file);
  log(`${b.labels.size} labels (${b.read} products; ${b.unusable} unusable, ` +
    `${b.conflicting} barcodes with conflicting labels dropped)`);
  return {labels: b.labels, info: {release, labels: b.labels.size, unusable: b.unusable,
    conflicting: b.conflicting}};
}

async function* batches(file: string, size: number): AsyncGenerator<string> {
  const rl = createInterface({input: createReadStream(file), crlfDelay: Infinity});
  let buf: string[] = [];
  for await (const line of rl) {
    if (!line) continue;
    buf.push(line);
    if (buf.length >= size) {
      yield buf.join("\n");
      buf = [];
    }
  }
  if (buf.length) yield buf.join("\n");
}

export async function runImport(o: ImportOptions): Promise<ImportResult> {
  const log = o.log ?? ((m: string) => console.log(m));
  const src = SOURCES[o.source];
  const now = o.now ?? new Date();
  const work = o.workDir ?? IMPORT.cacheDir;
  mkdirSync(join(work, "reports"), {recursive: true});
  const collection = `${o.source}_${stamp(now)}`;
  const outFile = join(work, `${collection}.jsonl`);
  const reportFile = join(work, "reports", `${collection}.json`);
  const failures: string[] = [];
  let downloaded: string | undefined;

  // 1–2. Download (unless given a file) + map and filter.
  let report: BuildReport;
  if (o.source === "off") {
    const cross = await crossCheckLabels(o, work, log);
    let stream;
    let gz = true;
    if (o.input) {
      gz = o.input.endsWith(".gz");
      stream = o.limitBytes ?
        createReadStream(o.input, {end: o.limitBytes - 1}) : openFile(o.input);
    } else {
      downloaded = join(work, "off-dump");
      const parts = await downloadInParts(SOURCES.off.url, downloaded, log);
      stream = readParts(parts);
    }
    log("mapping + filtering…");
    report = await buildOff(stream, gz, outFile,
      {allowTruncated: Boolean(o.limitBytes), labels: cross?.labels});
    report.crossCheck = cross && report.crossCheck ?
      {...cross.info, ...report.crossCheck} : {skipped: true};
  } else {
    const dir = o.input ?? join(work, "fdc");
    mkdirSync(dir, {recursive: true});
    const files = [];
    for (const f of SOURCES.usda.files) {
      const name = f.url.split("/").pop() as string;
      const zip = join(dir, name);
      const plain = join(dir, `${f.key}.json`);
      if (o.input && existsSync(plain)) files.push({path: plain, type: f.type, key: f.key});
      else {
        if (!existsSync(zip)) {
          log(`downloading ${name}…`);
          await downloadFile(f.url, zip);
        }
        files.push({path: zip, type: f.type, key: f.key});
      }
    }
    log("mapping + deduping…");
    report = await buildUsda(files, outFile);
  }
  log(`read ${report.read}, kept ${report.kept} (repaired ${report.repaired}), merged ` +
    `${report.merged}, dropped ${JSON.stringify(report.dropped)}`);
  const cc = report.crossCheck;
  if (cc && "fixedTooHigh" in cc) {
    log(`USDA cross-check: fixed ${cc.fixedTooHigh} too high + ${cc.fixedTooLow} too low ` +
      "(examples in the report)");
  }

  const finish = (r: Omit<ImportResult, "report" | "reportFile">): ImportResult => {
    const result = {...r, report, reportFile};
    writeFileSync(reportFile, JSON.stringify({...result, at: now.toISOString()}, null, 2));
    log(`report: ${reportFile}`);
    return result;
  };
  if (o.dryRun) {
    log(`dry run: records in ${outFile}; Typesense untouched`);
    return finish({ok: true, switched: false, failures});
  }

  const ts = new TypesenseAdmin(o.baseUrl, o.apiKey);
  if (!(await ts.health())) throw new Error(`Typesense at ${o.baseUrl} is not healthy`);

  // 3. Clear leftovers: earlier builds no alias points at.
  const live = await ts.aliasTarget(src.alias);
  for (const c of await ts.collections()) {
    if (c.name.startsWith(`${o.source}_`) && c.name !== live) {
      log(`deleting leftover collection ${c.name}`);
      await ts.deleteCollection(c.name);
    }
  }

  // 4. Create + import.
  await ts.createCollection(o.source === "off" ?
    offCollectionSchema(collection) : usdaCollectionSchema(collection));
  log(`importing into ${collection}…`);
  let imported = 0;
  for await (const batch of batches(outFile, IMPORT.batchLines)) {
    const r = await ts.importJsonl(collection, batch);
    imported += r.ok;
    if (r.failed) {
      failures.push(`import: ${r.failed} documents failed (${r.errors.join("; ")})`);
      break;
    }
  }
  log(`imported ${imported}`);

  // 5. Checks — on the new collection, before anyone sees it.
  if (!failures.length) {
    const count = (await ts.collection(collection))?.num_documents ?? 0;
    if (live) {
      const liveCount = (await ts.collection(live))?.num_documents ?? 0;
      const floor = Math.floor(liveCount * (1 - IMPORT.maxCountDropPct / 100));
      if (count < floor) {
        failures.push(`count ${count} is more than ${IMPORT.maxCountDropPct}% below the live ` +
          `${live} (${liveCount})`);
      }
    } else {
      const min = o.minCount ?? src.minCount;
      if (count < min) failures.push(`count ${count} is below the first-run floor ${min}`);
    }
    const list = o.checksFile ? loadChecks(o.checksFile) : DEFAULT_CHECKS[o.source];
    failures.push(...await runChecks(ts, collection, o.source, list,
      {crossChecked: o.source !== "off" || o.crossCheck !== false}));
  }

  if (failures.length) {
    for (const f of failures) log(`CHECK FAILED — ${f}`);
    log(`nothing switched: "${src.alias}" still points at ${live ?? "(nothing)"}; ` +
      `${collection} is kept for inspection until the next run`);
    return finish({ok: false, collection, switched: false, previous: live, failures});
  }

  // 6. Switch, then clean up.
  await ts.upsertAlias(src.alias, collection);
  log(`alias "${src.alias}" → ${collection}`);
  if (live) {
    await ts.deleteCollection(live);
    log(`deleted the old collection ${live}`);
  }
  if (downloaded && !o.keepDownload) rmSync(downloaded, {recursive: true, force: true});
  rmSync(outFile, {force: true});
  return finish({ok: true, collection, switched: true, previous: live, failures});
}
