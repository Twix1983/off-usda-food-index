// Every contestable number of the shared food module, each with its reason.
// Lives here (not src/config.ts) so src/food/ imports nothing from
// outside itself and can be published as-is (ODbL share-alike).

// Open Food Facts quality filters (README.md §How a build runs). Tuned on
// the first 1 GB of the 2026-09-24 dump (169k US products) — see the
// "Quality filters" notes there.
export const OFF_FILTERS = {
  // Pure fat is ~900 kcal/100 g, but US labels round: "130 kcal per 14 g" of
  // oil reads 929. 950 keeps honest oils and shortenings — 102 of 104 such
  // products matched USDA's label data (2026-09-25; the cap was 900).
  maxKcalPer100: 950,
  // A single macro can't exceed the 100 g it's measured in.
  maxMacroPer100: 100,
  // protein + carbs + fat per 100 g, with slack for label rounding.
  maxMacroSumPer100: 105,
  // Calories vs macros: kcal / (4p + 4c + 9f + 7 alcohol) must sit inside
  // this band. Asymmetric on purpose: fibre (~2 kcal/g) and polyols (~0–2.4)
  // make honest high-fibre / sugar-free bars read LOW (Quest ≈ 0.8), while
  // kJ typed into the kcal field reads ~4.2× HIGH. slackKcal keeps tiny
  // numbers (a 5 kcal drink) from failing on rounding alone.
  calorieRatioMin: 0.6,
  calorieRatioMax: 1.3,
  calorieSlackKcal: 20,
  // A serving above this is a data-entry error (grams or ml); fall back to 100 g.
  maxServingGrams: 2000,
} as const;

export const OFF_IMAGE = {
  base: "https://images.openfoodfacts.org/images/products",
  size: 200, // px — the thumb in search results
} as const;

// Short hash of brand + name + serving + nutrition: identical products listed
// under several barcodes share it, and search groups on it.
export const GROUP_KEY_HEX = 12;

export const KJ_PER_KCAL = 4.184;

// Only these per-100 bases are understood (ml is treated as grams).
export const PER_100_BASES = ["100g", "100ml"] as const;

// Repair for the biggest error class: per-100 g values entered as
// per-serving, which OFF then multiplies by 100 ÷ serving (a 25 g serving
// turns 540 kcal into 2,160). Scaling back by serving ÷ 100 gives what was
// typed. Applied ONLY when the values are impossible even allowing for label
// rounding, OFF says the data was entered per serving, a real serving of at
// least minServingGrams exists, and there's no alcohol; the result must then
// pass every check. Measured 2026-09-25 on 169k US products: 13,809 rescued
// (8.2%); of the 12,099 found in USDA's branded label data, 93.7% match on
// protein, carbs and fat (comparable kept products: 46%).
export const OFF_REPAIR = {
  overflowKcal: 1125, // kcal/100 g
  overflowMacro: 125, // g/100 g, any one macro
  overflowMacroSum: 130, // g/100 g, protein + carbs + fat
  minServingGrams: 5,
} as const;

// The USDA cross-check (crossCheck.ts; README.md §Quality filters):
// the same per-serving mistake, too small to look impossible — a 71 g pastry
// entered 400 per serving reads 563 kcal/100 g — or, on a serving over 100 g,
// too LOW (OFF divides instead of multiplying). The import compares a product
// with USDA's Branded Foods label for its barcode, as a DETECTOR only: the
// values kept are OFF's own scaled back by serving ÷ 100 (what was typed).
// Measured 2026-09-25 on 169k US products: 3,679 corrected (2.2%; 1,932 too
// high, 1,747 too low). Safety test — the same rule on products entered per
// 100 g, where the mistake can't happen: 7 "fixes" in 86,002 (0.08 per 1,000,
// vs 247 per 1,000 for per-serving entries).
export const USDA_CROSS_CHECK = {
  // 100 ÷ serving must be at least this far from 1 (a serving of 80 g or less,
  // or 125 g or more): nearer 100 g the mistake hides in label disagreement.
  minFactor: 1.25,
  // Same label: USDA's serving within ±10% of OFF's. USDA has serving errors
  // of its own, and one of those makes the same fingerprint on a correct record.
  servingPct: 0.1,
  // "Agrees with USDA": kcal within ±10%; protein, carbs and fat each within
  // ±15% or ±2 g (label rounding on small numbers).
  kcalPct: 0.1,
  macroPct: 0.15,
  macroAbs: 2,
  // A real change only: at least 30 kcal/100 g, on a label of at least 40 —
  // keeps near-zero drinks and rounding out.
  minKcalChange: 30,
  minUsdaKcal: 40,
} as const;
