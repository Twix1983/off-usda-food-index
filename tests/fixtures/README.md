# Test fixtures — real food data

- `off/dump-samples.jsonl` — Open Food Facts products from the 2026-09-24
  JSONL dump (US-tagged), one per edge case (`fixture` names the case —
  including the per-serving repair: `repaired_per_serving`,
  `repaired_new_format`, the unrepairable `drop_kcal_range`,
  `oil_under_950`, and the USDA cross-check's `cross_check_*` cases), trimmed
  to the fields the mapper reads
  (`src/food/off.ts`).
- `index-sample/` — a small real sample (OFF lines + USDA subsets + check
  lists) for the import script's tests against a local Typesense;
  `branded.json` holds the USDA Branded Foods labels of the two sample
  products the cross-check corrects (Sara Lee Butter Pound Cake, Amy's
  spinach pizza), plus an identical duplicate pair and a feed (GDSN) record.
- `off/live-api.jsonl` — Open Food Facts live API v3 responses
  (`/api/v3/product/{code}.json?fields=…`), pulled 2026-09-25 — the shape a
  client sends to a barcode lookup when it fetched the product itself.
- `usda/samples.json` — USDA FoodData Central records from the bulk JSON
  downloads (FNDDS 2024-10-31, SR Legacy 2018-04, Foundation 2026-04-30),
  trimmed to the nutrients the mapper reads.
- `usda/branded-samples.jsonl` — Branded Foods records from the 2026-04-30
  JSON release, in the release's own line format (the header line, `{…},`
  lines, the last product closing the file), trimmed to the fields the
  cross-check reads. One per case: a 12-digit UPC, a GTIN-14, an ml serving,
  a bad check digit, no energy, New Zealand, an mg serving, a GDSN and a
  Euromonitor record (feeds are never used), an identical and a conflicting
  duplicate pair, and the labels of the `cross_check_*` OFF fixtures.

Open Food Facts data © Open Food Facts contributors, under the Open Database
License (https://opendatacommons.org/licenses/odbl/1-0/); product images under
CC BY-SA. https://world.openfoodfacts.org

USDA FoodData Central data is public domain (CC0). https://fdc.nal.usda.gov
