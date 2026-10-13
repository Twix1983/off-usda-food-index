// The import script's own numbers (README.md §How a build runs), each with
// its reason. The shared mapping code lives in src/food/.

export const SOURCES = {
  off: {
    alias: "off",
    // 302 → openfoodfacts-ds.s3.eu-west-3.amazonaws.com; rebuilt nightly, ~13 GB.
    url: "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz",
    // First run (no live collection to compare with): a floor well under the
    // expected ~800k US products, so a broken download can't go live.
    minCount: 500_000,
  },
  usda: {
    alias: "usda",
    // FDC bulk JSON, dated file names — update when FDC publishes a release
    // (FNDDS about every two years; SR Legacy is frozen).
    files: [
      {type: "fndds", key: "SurveyFoods",
        url: "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip"},
      {type: "sr_legacy", key: "SRLegacyFoods",
        url: "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip"},
      {type: "foundation", key: "FoundationFoods",
        url: "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip"},
    ],
    minCount: 10_000, // ~13k expected after dedupe
  },
} as const;

export type Source = keyof typeof SOURCES;

// USDA FoodData Central Branded Foods — manufacturers' label data, public
// domain — read by every OFF import for the cross-check, as a detector only
// (src/food/crossCheck.ts). The JSON release, not the CSV: half the
// download (204 MB vs 449 MB), one product per line with its own nutrients,
// and exactly the newest record per barcode (checked 2026-09-25: 432,556 of
// 432,559 identical to the CSV's newest). Dated file names: FDC publishes
// about twice a year (April, then October–December) — bump the date when it
// does (its download page lags; check the file name). Cached in cacheDir/fdc
// and kept between runs.
export const BRANDED = {
  url: "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_branded_food_json_2026-04-30.zip",
  // The 2026-04-30 release gives ~380k usable labels (US, Label Insight,
  // valid barcode and serving); a broken or half-read file can't pass this.
  minLabels: 300_000,
} as const;

export const IMPORT = {
  // A new build whose count falls more than this % below the live collection
  // is not switched in (a broken download or mapper bug shows up as a drop).
  maxCountDropPct: 5,
  batchLines: 5000, // documents per import request
  // OFF's download server gives ~0.5 MB/s per connection from here but ~8 MB/s
  // over 16 ranged connections (measured 2026-09-25): ~30 min for 13 GB.
  downloadParts: 16,
  downloadRetries: 6,
  cacheDir: `${process.env.HOME}/.cache/off-usda-food-index`,
} as const;

// Identifies us to Open Food Facts, as their API/data rules ask.
export const USER_AGENT = "off-usda-food-index/1.0 (+https://github.com/Twix1983/off-usda-food-index)";
