// The checks a freshly built collection must pass before the alias moves
// (README.md §How a build runs, step 5). Barcodes and queries are real
// products picked 2026-09-25; `--checks <file>` swaps in another list (the
// local-Typesense tests use one that fits their small sample).
import {readFileSync} from "node:fs";

import {OFF_SORT, USDA_SORT} from "../../src/food/schema";
import type {Source} from "./config";
import type {TypesenseAdmin} from "./typesense";

export interface CheckList {
  // Each must resolve by exact barcode, with kcal per 100 g in range.
  // `crossCheck`: the range holds only after the USDA cross-check, so the
  // check is skipped when a run skips it (--no-cross-check).
  barcodes: Array<{code: string; kcal100: [number, number]; crossCheck?: boolean}>;
  // Each query's top `within` hits must include a name matching `expect`.
  queries: Array<{q: string; expect: string; within?: number}>;
}

export const DEFAULT_CHECKS: Record<Source, CheckList> = {
  off: {
    barcodes: [
      {code: "0888849000005", kcal100: [250, 400]}, // Quest Cookies & Cream bar
      {code: "0030000010204", kcal100: [330, 420]}, // Quaker Old Fashioned Oats
      {code: "0016000275287", kcal100: [330, 420]}, // Cheerios
      {code: "0689544001737", kcal100: [30, 80]}, // Fage Total 0%
      // Coca-Cola 20 oz bottle. (The 12 oz can, 0049000006346, was the first
      // choice until OFF volunteers re-tagged it Saint Martin-only — 2026-09-25,
      // B3's first live build — so the US filter rightly dropped it.)
      {code: "0049000000443", kcal100: [30, 50]},
      // Sara Lee Butter Pound Cake: OFF shows 459 (per-100 g values typed per
      // 76 g slice); the USDA cross-check puts it back at the label's ~349.
      {code: "0032100026314", kcal100: [320, 370], crossCheck: true},
    ],
    queries: [
      {q: "quest bar", expect: "(?i)quest|protein bar", within: 5},
      {q: "cheerios", expect: "(?i)cheerios", within: 3},
      {q: "cheerois", expect: "(?i)cheerios", within: 5}, // a typo
      {q: "greek yogurt", expect: "(?i)greek", within: 5},
    ],
  },
  usda: {
    barcodes: [],
    queries: [
      {q: "banana", expect: "(?i)^banana", within: 3},
      {q: "chicken breast", expect: "(?i)chicken,? breast", within: 3},
      {q: "egg", expect: "(?i)^egg", within: 5},
      {q: "brocoli", expect: "(?i)broccoli", within: 5}, // a typo
    ],
  },
};

export function loadChecks(file: string): CheckList {
  return JSON.parse(readFileSync(file, "utf8")) as CheckList;
}

// JS RegExp has no inline (?i); the lists use it for readability.
const regex = (p: string) => p.startsWith("(?i)") ? new RegExp(p.slice(4), "i") : new RegExp(p);

export async function runChecks(ts: TypesenseAdmin, collection: string, source: Source,
  list: CheckList, opts: {crossChecked: boolean} = {crossChecked: true}): Promise<string[]> {
  const failures: string[] = [];
  for (const b of list.barcodes) {
    if (b.crossCheck && !opts.crossChecked) continue;
    const res = await ts.search(collection, {q: "*", filter_by: `barcode:=${b.code}`, per_page: 1});
    const doc = res.hits[0]?.document;
    const kcal = Number(doc?.kcal100);
    if (!doc) failures.push(`barcode ${b.code}: not found`);
    else if (!(kcal >= b.kcal100[0] && kcal <= b.kcal100[1])) {
      failures.push(`barcode ${b.code}: kcal/100 g ${kcal} outside ${b.kcal100.join("–")}`);
    }
  }
  for (const q of list.queries) {
    const within = q.within ?? 3;
    const params: Record<string, string | number> = source === "off" ?
      {q: q.q, query_by: "name,brand", query_by_weights: "2,1", per_page: within,
        sort_by: OFF_SORT} :
      {q: q.q, query_by: "name", per_page: within, drop_tokens_threshold: 0,
        sort_by: USDA_SORT};
    const res = await ts.search(collection, params);
    const re = regex(q.expect);
    const hits = res.hits.map((h) => ({name: String(h.document.name),
      full: `${h.document.brand ?? ""} ${h.document.name}`.trim()}));
    if (!hits.some((h) => re.test(h.name) || re.test(h.full))) {
      failures.push(`query "${q.q}": top ${within} were [${hits.map((h) => h.full).join(" | ")}]`);
    }
  }
  return failures;
}
