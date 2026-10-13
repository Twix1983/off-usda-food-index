// The two index record shapes (one per Typesense collection — never mixed:
// Open Food Facts is ODbL, USDA is public domain) and the drop reasons the
// import report counts.

interface Macros {
  kcal: number; // per serving, rounded to a whole number
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number | null; // null = the source has no fibre value
}

interface Per100 {
  kcal100: number;
  protein100: number;
  carbs100: number;
  fat100: number;
  fibre100: number | null;
}

// A record in the `off` collection. id = the normalized barcode.
export interface OffRecord extends Macros, Per100 {
  id: string;
  barcode: string; // = id; the field search filters on
  name: string;
  brand?: string;
  servingGrams: number;
  servingLabel: string;
  imageUrl?: string;
  popularity: number; // OFF scan count, for ranking
  groupKey: string; // collapses one product listed under several barcodes
  // Set when the values were scaled back to a per-serving entry OFF had
  // multiplied by 100 ÷ serving: "overflow" when they were impossible
  // (food/config.ts OFF_REPAIR), "cross_check" when USDA's label for the
  // barcode showed it (USDA_CROSS_CHECK). Stored, not indexed.
  repaired?: "overflow" | "cross_check";
}

// A USDA Branded Foods label, read at import to cross-check an OFF product —
// never stored or shown (food/crossCheck.ts). Per 100 g, or 100 ml when the
// serving is in ml.
export interface UsdaLabel {
  kcal100: number;
  protein100: number;
  carbs100: number;
  fat100: number;
  servingGrams: number;
}

// A record in the `usda` collection. id = the fdcId.
export interface UsdaRecord extends Macros, Per100 {
  id: string;
  name: string;
  dataType: "fndds" | "sr_legacy" | "foundation";
  // Tie-break after text match: FNDDS names read like what people eat
  // ("Chicken breast, grilled"), SR Legacy / Foundation like lab samples.
  sourceRank: number;
  // Last tie-break: among equal matches the shorter name is the plainer food
  // ("Banana, raw" before "Banana nectar").
  nameLength: number;
  servingGrams: number;
  servingLabel: string;
}

export type OffDropReason =
  | "not_us" // not tagged United States (import only)
  | "bad_code" // not a product barcode
  | "store_code" // a store's own weigh-and-price or in-store code
  | "no_name"
  | "no_kcal" // no energy value at all
  | "estimated_nutrition" // OFF's own estimate, not a label
  | "no_macros" // none of protein, carbs, fat given
  | "kcal_range" // above what food can hold
  | "macro_range" // a macro below 0 or above 100 g per 100 g
  | "macro_sum" // macros add up past 100 g per 100 g
  | "calorie_mismatch"; // kcal disagrees with the macros (e.g. kJ typed as kcal)

export type UsdaDropReason = "null_record" | "no_name" | "no_kcal" | "no_macros";

export type MapResult<R, D> = {ok: true; record: R} | {ok: false; reason: D};
