// The monthly download's parallel, resumable fetch — offline, against a tiny
// local server that honours Range requests (as OFF's S3 does).
import {createServer, type Server} from "node:http";
import {existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {gzipSync} from "node:zlib";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {buildOff, openFile} from "../../scripts/food-index/build";
import {downloadFile, downloadFileInParts, downloadInParts, readParts}
  from "../../scripts/food-index/download";

const sample = readFileSync(resolve(__dirname, "../fixtures/index-sample/off-sample.jsonl"));
const body = gzipSync(sample);
let server: Server;
let url = "";
let rangeRequests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.includes("missing")) {
      res.writeHead(404).end();
      return;
    }
    const headers = {"Content-Length": String(body.length), "Last-Modified": "Thu, 24 Sep 2026"};
    if (req.method === "HEAD") {
      res.writeHead(200, headers).end();
      return;
    }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
    if (!m) {
      res.writeHead(200, headers).end(body);
      return;
    }
    rangeRequests++;
    const [start, end] = [Number(m[1]), Number(m[2])];
    const slice = body.subarray(start, end + 1);
    res.writeHead(206, {"Content-Length": String(slice.length),
      "Content-Range": `bytes ${start}-${end}/${body.length}`}).end(slice);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as {port: number};
  url = `http://127.0.0.1:${addr.port}/openfoodfacts-products.jsonl.gz`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("downloadInParts + readParts", () => {
  it("fetches ranged parts (resuming a half-done one), streams them in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "off-dump-"));
    // A previous run of the SAME dump got half of part 00 before dying.
    writeFileSync(join(dir, "meta.json"), JSON.stringify({url, size: body.length,
      lastModified: "Thu, 24 Sep 2026", parts: 16}));
    const chunk = Math.ceil(body.length / 16);
    writeFileSync(join(dir, "part-00"), body.subarray(0, Math.floor(chunk / 2)));

    const parts = await downloadInParts(url, dir, () => undefined);
    expect(parts).toHaveLength(16);
    expect(rangeRequests).toBe(16); // part 00 asked only for its missing half
    expect(Buffer.concat(parts.map((p) => readFileSync(p)))).toEqual(body);

    // Streamed through the real build step, it equals reading the plain file.
    const fromParts = await buildOff(readParts(parts), true, join(dir, "a.jsonl"),
      {allowTruncated: false});
    const plain = join(dir, "plain.jsonl");
    writeFileSync(plain, sample);
    const fromFile = await buildOff(openFile(plain), false, join(dir, "b.jsonl"),
      {allowTruncated: false});
    expect(fromParts).toEqual(fromFile);
  });

  it("a complete earlier download of the same dump is reused as is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "off-dump-"));
    await downloadInParts(url, dir, () => undefined);
    const before = rangeRequests;
    await downloadInParts(url, dir, () => undefined);
    expect(rangeRequests).toBe(before);
  });
});

describe("downloadFile + downloadFileInParts (the FDC zips)", () => {
  it("the file appears only when complete — no .part or parts left behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fdc-"));
    await downloadFile(url, join(dir, "one.zip"));
    await downloadFileInParts(url, join(dir, "parts.zip"), () => undefined);
    expect(readFileSync(join(dir, "one.zip"))).toEqual(body);
    expect(readFileSync(join(dir, "parts.zip"))).toEqual(body);
    expect(readdirSync(dir).sort()).toEqual(["one.zip", "parts.zip"]);
  });

  it("a failed download leaves nothing under the real name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fdc-"));
    const file = join(dir, "missing.zip");
    await expect(downloadFile(url.replace(/[^/]+$/, "missing.zip"), file)).rejects.toThrow(/404/);
    expect(existsSync(file)).toBe(false);
  });
});
