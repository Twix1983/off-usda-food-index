// Downloads. Open Food Facts' 13 GB dump comes in IMPORT.downloadParts ranged
// pieces fetched at once (one connection manages ~0.5 MB/s; 16 manage ~8),
// each resumable. The pieces are never joined on disk: readParts() streams
// them in order, straight into the decompressor.
import {createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {PassThrough, Readable} from "node:stream";
import {pipeline} from "node:stream/promises";

import {IMPORT, USER_AGENT} from "./config";

interface Meta {
  url: string;
  size: number;
  lastModified: string;
  parts: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function head(url: string): Promise<{url: string; size: number; lastModified: string}> {
  const res = await fetch(url, {method: "HEAD", redirect: "follow",
    headers: {"User-Agent": USER_AGENT}});
  if (!res.ok) throw new Error(`HEAD ${url} → ${res.status}`);
  return {url: res.url, size: Number(res.headers.get("content-length")),
    lastModified: res.headers.get("last-modified") ?? ""};
}

async function fetchRange(url: string, file: string, start: number, end: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const have = existsSync(file) ? statSync(file).size : 0;
    if (have >= end - start + 1) return;
    try {
      const res = await fetch(url, {headers: {"Range": `bytes=${start + have}-${end}`,
        "User-Agent": USER_AGENT}});
      if (res.status !== 206 || !res.body) throw new Error(`range → ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file, {flags: "a"}));
    } catch (err) {
      if (attempt >= IMPORT.downloadRetries) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

// Returns the ordered part files; reuses complete parts of the SAME dump.
export async function downloadInParts(url: string, dir: string,
  log: (m: string) => void): Promise<string[]> {
  mkdirSync(dir, {recursive: true});
  const info = await head(url);
  if (!info.size) throw new Error("the server gave no Content-Length");
  const metaFile = join(dir, "meta.json");
  const meta: Meta = {url: info.url, size: info.size, lastModified: info.lastModified,
    parts: IMPORT.downloadParts};
  if (existsSync(metaFile)) {
    const old = JSON.parse(readFileSync(metaFile, "utf8")) as Meta;
    if (old.size !== meta.size || old.lastModified !== meta.lastModified ||
      old.parts !== meta.parts) {
      log("a newer dump is out — discarding the old partial download");
      rmSync(dir, {recursive: true, force: true});
      mkdirSync(dir, {recursive: true});
    }
  }
  writeFileSync(metaFile, JSON.stringify(meta));
  const chunk = Math.ceil(meta.size / meta.parts);
  const files = Array.from({length: meta.parts}, (_, i) =>
    join(dir, `part-${String(i).padStart(2, "0")}`));
  log(`downloading ${(meta.size / 1e9).toFixed(1)} GB in ${meta.parts} parts…`);
  const t0 = Date.now();
  const timer = setInterval(() => {
    const got = files.reduce((a, f) => a + (existsSync(f) ? statSync(f).size : 0), 0);
    const mbs = got / 1e6 / ((Date.now() - t0) / 1000);
    log(`  ${(100 * got / meta.size).toFixed(0)}% (${mbs.toFixed(1)} MB/s)`);
  }, 30_000);
  try {
    await Promise.all(files.map((f, i) =>
      fetchRange(meta.url, f, i * chunk, Math.min(meta.size, (i + 1) * chunk) - 1)));
  } finally {
    clearInterval(timer);
  }
  const total = files.reduce((a, f) => a + statSync(f).size, 0);
  if (total !== meta.size) throw new Error(`download incomplete: ${total} of ${meta.size} bytes`);
  return files;
}

// The parts, in order, as one byte stream.
export function readParts(files: string[]): Readable {
  const out = new PassThrough();
  (async () => {
    for (const f of files) await pipeline(createReadStream(f), out, {end: false});
    out.end();
  })().catch((err) => out.destroy(err));
  return out;
}

// One file, one connection. Written under `<file>.part` and renamed only when
// complete, so a cut-off download is never mistaken for a cached file.
export async function downloadFile(url: string, file: string): Promise<void> {
  const part = `${file}.part`;
  const res = await fetch(url, {headers: {"User-Agent": USER_AGENT}});
  if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  const expected = res.headers.get("content-encoding") ? 0 :
    Number(res.headers.get("content-length") ?? 0);
  const got = statSync(part).size;
  if (expected && got !== expected) {
    rmSync(part, {force: true});
    throw new Error(`download incomplete: ${got} of ${expected} bytes (${url})`);
  }
  renameSync(part, file);
}

// A large single file in ranged parts (as downloadInParts), joined into
// `file` — the parts are resumable, the file appears only when complete.
export async function downloadFileInParts(url: string, file: string,
  log: (m: string) => void): Promise<void> {
  const dir = `${file}.parts`;
  const parts = await downloadInParts(url, dir, log);
  const part = `${file}.part`;
  await pipeline(readParts(parts), createWriteStream(part));
  renameSync(part, file);
  rmSync(dir, {recursive: true, force: true});
}
