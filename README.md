# off-usda-food-index

Builds a [Typesense](https://typesense.org) search index of US foods from two
free sources, kept in two separate collections:

- **`off`** — packaged foods and their barcodes from
  [Open Food Facts](https://world.openfoodfacts.org) (products tagged United
  States that pass the quality filters below; one record per barcode);
- **`usda`** — generic foods ("banana", "chicken breast, grilled") from
  [USDA FoodData Central](https://fdc.nal.usda.gov): FNDDS, SR Legacy and
  Foundation, deduplicated by name.

Each build creates a new dated collection, checks it, and only then moves an
alias (`off`, `usda`) to it — a failed run changes nothing that's being
searched. Lookups query the aliases.

This is the method behind a derived Open Food Facts database, published under
the ODbL's share-alike terms. **No data is included** (see `NOTICE.md`).

## What's here

| Path | What it is |
|---|---|
| `src/food/` | The shared food module: barcode normalisation, the Open Food Facts and USDA mappers, the quality filters, the USDA cross-check, the collection schemas, and index record → the `FoodItem` shape. It imports nothing from outside itself, so the import and any lookup that maps a live Open Food Facts product use the same code. Every tunable number is in `src/food/config.ts`, with its reason. |
| `scripts/food-index/` | The import pipeline and its CLI (`run.ts` → `pipeline.ts`); the script's own numbers in `config.ts`; `local-typesense.sh` for a throwaway local server (macOS). |
| `tests/` | The mappers on real samples (`tests/fixtures/`), and the parallel downloader against a local HTTP server. |

## Requirements

- Node 22 or later, and `unzip` on the path.
- A Typesense server (30.x) and its **admin** key — the import creates
  collections and moves aliases. Search with a search-only key; never ship the
  admin key to a client.
- Disk and time: the Open Food Facts dump is ~13 GB (streamed, never
  unpacked on disk) and the USDA Branded Foods release 204 MB.
- Memory on the Typesense side: a build writes the new collection beside the
  live one, so the server needs room for two copies of `off` while it runs
  (~700k records; the live index used ~600 MiB on a 1 GB cluster, and a
  rebuild beside it ran out of memory).

## Running a build

```
npm install
cp .env.example .env        # TYPESENSE_HOST, TYPESENSE_ADMIN_API_KEY
npm run food-index -- --source usda          # generic foods: seconds
npm run food-index -- --source off --live    # packaged foods: ~1 hour
```

A host that isn't `localhost` is refused unless the run passes `--live` — the
rail against pointing a test at a real server. Each run prints its steps and
ends with `DONE — switched` or `FAILED — nothing switched`. Read the report
(`~/.cache/off-usda-food-index/reports/<collection>.json`): the kept/dropped
counts by reason (a sudden jump in one reason usually means Open Food Facts
changed its format) and the cross-check's line, `USDA cross-check: fixed N too
high + M too low` (about 0.5% of kept products; near zero means the label read
or the barcode join broke).

**Flags:** `--source off|usda` · `--dry-run` (stop after mapping; Typesense
untouched) · `--live` · `--input <file|dir>` (a local sample instead of
downloading) · `--limit-bytes <n>` (read only the start of a dump) ·
`--min-count <n>` · `--checks <file>` (your own barcode and query checks) ·
`--keep-download` · for the cross-check: `--branded <file>` (a local Branded
Foods zip or sample — required with `--input`), `--no-cross-check` (a
deliberate skip, logged loudly), `--min-labels <n>`.

**Refreshing.** Open Food Facts rebuilds its dump nightly; re-run the `off`
build when you want newer products. USDA's generic releases change rarely
(FNDDS about every two years; SR Legacy is frozen) — their dated file names
are in `scripts/food-index/config.ts`. The Branded Foods release (used only by
the cross-check) comes out about every six months; its download page can lag
the file itself, so check the file name for a later date and bump `BRANDED.url`.

**Locally:** `scripts/food-index/local-typesense.sh start` runs a throwaway
Typesense 30.2 on `localhost:8108` (the native macOS build; `stop` wipes it),
then:

```
TYPESENSE_HOST=http://localhost:8108 TYPESENSE_ADMIN_API_KEY=local-admin \
  npm run food-index -- --source usda
```

## How a build runs

1. **Download.**
   - Open Food Facts: the JSONL dump (`openfoodfacts-products.jsonl.gz`),
     fetched in 16 ranged parts at once (one connection can be slow), each
     resumable, streamed in order straight into the decompressor. Not the CSV
     (its export leaves most nutrients blank) and not Parquet: the JSONL lines
     have the same shape as the live API's product JSON, so one mapper serves
     the import and a live barcode lookup.
   - USDA: FDC's bulk JSON zips for FNDDS, SR Legacy and Foundation.
   - For an `off` run, USDA's **Branded Foods** labels too (the cross-check
     below), read first — before the long download — so a broken release
     fails the run with nothing touched.
2. **Map + filter** line by line with `src/food/`, the cross-check applied
   inside the mapper. Two products that normalise to one barcode keep the more
   complete record. Output: a JSONL file and the report.
3. **Clear leftovers:** any `off_*` / `usda_*` collection no alias points at
   (a failed earlier run) is deleted.
4. **Import** into the new collection (`<source>_<YYYYMMDD-HHmmss>`, bulk
   JSONL, `action=create`); any failed document fails the run.
5. **Check** the new collection before anything searches it: its count is no
   more than 5% below the live one's (or above a floor on a first run); known
   barcodes resolve with sane calories; known queries — including typos —
   find what they should (`scripts/food-index/checks.ts`).
6. **Switch** the alias, then delete the old collection and the dump.

## Quality filters

An Open Food Facts product is dropped, and counted by reason in the report,
when it has (`src/food/nutrition.ts`, thresholds in `src/food/config.ts`
`OFF_FILTERS`):

- no name, or no energy value at all;
- nutrition marked as Open Food Facts' own estimate rather than a label;
- more than 950 kcal per 100 g (US labels round: "130 kcal per 14 g" of oil
  reads 929, so the cap isn't 900);
- a macro below 0 or above 100 g per 100 g, or macros summing past 105 g;
- kcal outside 0.6–1.3× of 4·protein + 4·carbs + 9·fat + 7·alcohol (±20 kcal) —
  asymmetric on purpose: fibre- and sugar-alcohol-heavy products honestly read
  low, while kJ typed as kcal reads ~4.2× high;
- a store's own code (UPC number system 2 or 4, EAN-13 prefixes 20–29), or a
  code that isn't a barcode.

**The one repair** (`OFF_REPAIR`). The biggest error class is per-100 g values
entered as per-serving, which Open Food Facts then multiplies by 100 ÷ serving
(a 25 g serving turns 540 kcal into 2,160). When the values are impossible even
allowing for rounding, the product says its data was entered per serving (and
isn't the "as prepared" set), the serving is at least 5 g and there's no
alcohol, every per-100 value is scaled back by serving ÷ 100 — what was typed.
The result must then pass every filter, or the product is dropped with its
original reason. Repaired records carry `repaired: "overflow"`; when two
records share a barcode, the unrepaired one wins.

**The USDA cross-check** (`src/food/crossCheck.ts`, `USDA_CROSS_CHECK`). The
same mistake can be too small to look impossible (a pound cake typed per 76 g
slice reads 459 kcal/100 g instead of 349), or, on a serving over 100 g, too
low. For those, the import takes a second opinion: USDA FoodData Central's
Branded Foods label for the same barcode. A product is scaled by serving ÷ 100
only when the mistake is possible (the repair's gate), the factor is clear of
label noise (a serving of 80 g or less, or 125 g or more), USDA has a
trustworthy label (US market, transcribed from the printed panel, a valid check
digit, a serving in g or ml, all four macros, no conflicting record), USDA's
serving is within ±10% of Open Food Facts', the calories disagree by a real
amount, and the scaled values then agree with USDA on calories (±10%) and on
each macro (±15% or ±2 g) and pass every filter. Anything else is left alone.
The record gets `repaired: "cross_check"`. **No USDA number is ever written**:
the values kept are Open Food Facts' own, so the two sources never mix.

**Barcodes** (`src/food/barcode.ts`): Open Food Facts' own rule — strip leading
zeros, pad 7 or fewer digits to 8 and 9–12 digits to 13 — plus UPC-E expanded
to its UPC-A. Given the scanner's symbology the choice is exact; without it,
an 8-digit code starting with 0 that checks out as UPC-E is read as UPC-E.

## The FoodItem shape

Both collections map to one shape for search results and barcode lookups
(`src/food/toFoodItem.ts`). Macros are per **one serving**; `fibreG` is `null`
when the source has no fibre value (about one in five indexed Open Food Facts
products):

```ts
interface FoodItem {
  name: string; brand?: string
  serving: { grams: number; label?: string }   // label: "1 bar (49 g)"
  kcal: number; proteinG: number; fibreG: number | null; carbsG: number; fatG: number
  imageUrl?: string
  barcode?: string                             // normalised
  origin: 'off' | 'usda'                       // where the numbers came from
  originId: string                             // off: the barcode · usda: the fdcId
}
```

Open Food Facts nutrients are per 100 g (per 100 ml for drinks, treated as
grams); per-serving values are per-100 g × grams ÷ 100, kcal rounded to a whole
number and grams to one decimal. With no usable serving, the serving is 100 g.

## USDA FoodData Central

`src/food/usda.ts`: generic foods from FNDDS, SR Legacy and Foundation.
Nutrients are matched on `nutrient.id`, per 100 g; the serving is the
dataset's default household portion, with its description ("1 medium breast
(120 g)"), or 100 g when there's none. Names are tidied, and foods with the same name are merged
with FNDDS preferred (its names read like what people eat). Search ranks FNDDS
first, then the shorter name among equal matches ("Banana, raw" before
"Banana nectar").

## Tests

```
npm test            # the mappers on real samples; the downloader offline
npm run typecheck
```

## Licence

The code: MIT (`LICENSE`). The data it reads and builds: Open Food Facts under
the ODbL, USDA FoodData Central public domain (`NOTICE.md`). Food data ©
Open Food Facts contributors.
