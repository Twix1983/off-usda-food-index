// CLI for the food-index import (README.md §Running a build).
//   npm --prefix functions run food-index -- --source off --live
// Flags: --source off|usda · --dry-run · --live (required for a non-local
// host) · --input <file|dir> · --limit-bytes <n> · --min-count <n> ·
// --checks <file> · --keep-download · OFF's USDA cross-check: --branded <file>
// · --no-cross-check · --min-labels <n>
// Reads TYPESENSE_HOST + TYPESENSE_ADMIN_API_KEY from the repo-root .env.
import {IMPORT, type Source} from "./config";
import {isLocalHost, loadRootEnv, typesenseBaseUrl} from "./env";
import {runImport} from "./pipeline";

function args(argv: string[]): Map<string, string | true> {
  const m = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      m.set(a.slice(2), next);
      i++;
    } else m.set(a.slice(2), true);
  }
  return m;
}

async function main(): Promise<number> {
  loadRootEnv();
  const a = args(process.argv.slice(2));
  const source = a.get("source");
  if (source !== "off" && source !== "usda") {
    console.error("usage: food-index --source off|usda [--dry-run] [--live] …");
    return 2;
  }
  const dryRun = a.has("dry-run");
  const host = process.env.TYPESENSE_HOST ?? "";
  const baseUrl = host ? typesenseBaseUrl(host) : "";
  if (!dryRun) {
    if (!baseUrl || !process.env.TYPESENSE_ADMIN_API_KEY) {
      console.error("TYPESENSE_HOST and TYPESENSE_ADMIN_API_KEY must be set (repo-root .env)");
      return 2;
    }
    // Safety rail: only a deliberate --live run may touch a cloud cluster.
    if (!isLocalHost(baseUrl) && !a.has("live")) {
      console.error(`refusing to import into ${baseUrl} without --live`);
      return 2;
    }
  }
  const num = (k: string) => (typeof a.get(k) === "string" ? Number(a.get(k)) : undefined);
  const result = await runImport({
    source: source as Source,
    baseUrl,
    apiKey: process.env.TYPESENSE_ADMIN_API_KEY ?? "",
    dryRun,
    input: typeof a.get("input") === "string" ? a.get("input") as string : undefined,
    limitBytes: num("limit-bytes"),
    minCount: num("min-count"),
    checksFile: typeof a.get("checks") === "string" ? a.get("checks") as string : undefined,
    keepDownload: a.has("keep-download"),
    branded: typeof a.get("branded") === "string" ? a.get("branded") as string : undefined,
    crossCheck: !a.has("no-cross-check"),
    minLabels: num("min-labels"),
    workDir: IMPORT.cacheDir,
  });
  console.log(result.ok ? (result.switched ? "DONE — switched" : "DONE — dry run") :
    "FAILED — nothing switched");
  return result.ok ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
