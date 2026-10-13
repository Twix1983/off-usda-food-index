// The USDA cross-check (README.md §Quality filters). OFF_REPAIR
// undoes OFF's per-serving mistake when it makes impossible numbers; this
// catches it when it doesn't: believable numbers exactly 100 ÷ serving too
// high (a serving under 100 g) or too low (over 100 g). The second opinion is
// USDA FoodData Central's Branded Foods label for the same barcode (public
// domain, read at import only). It is a DETECTOR: the values kept are OFF's
// own, scaled back to what was typed; USDA's numbers are never stored — the
// ODbL "never mix" rule.
import {hasValidCheckDigit, normalizeBarcode} from "./barcode";
import {USDA_CROSS_CHECK} from "./config";
import type {UsdaLabel} from "./types";
import {nutrientReader, USDA_NUTRIENTS} from "./usda";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  (v && typeof v === "object" && !Array.isArray(v) ? v as Json : {});
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

// The release also holds New Zealand labels; our index is US products.
const US_MARKETS = ["United States", "US"];
// Only labels USDA transcribed from the printed panel (Label Insight). The
// manufacturer feeds (GDSN, Euromonitor) carry the mirror of OFF's mistake —
// per-serving numbers filed as per-100 g (Dum Dums at 50 kcal/100 g) — which
// makes the same fingerprint on a correct OFF product. Measured 2026-09-25:
// in the per-100 g-entered safety test, 5 false fixes in 85,247 Label
// Insight labels vs 16 in 1,043 from the feeds.
const DATA_SOURCES = ["LI"];
// Serving units that match the per-100 basis (grams or millilitres). Labels
// served in mg, IU or mcg are supplements.
const SERVING_UNITS = ["g", "GRM", "GM", "ml", "MLT"];

export interface BrandedLabel {
  id: string; // the normalized barcode (house style)
  fdcId: number;
  label: UsdaLabel;
}

// One product of the Branded Foods JSON release → its label, or null when it
// can't serve as a trustworthy second opinion.
export function brandedLabel(food: unknown): BrandedLabel | null {
  const f = obj(food);
  if (!US_MARKETS.includes(String(f.marketCountry)) ||
    !DATA_SOURCES.includes(String(f.dataSource))) return null;
  const fdcId = num(f.fdcId);
  const id = typeof f.gtinUpc === "string" ? normalizeBarcode(f.gtinUpc) : null;
  if (fdcId === undefined || !id || !hasValidCheckDigit(id)) return null;
  const servingGrams = num(f.servingSize);
  if (servingGrams === undefined || servingGrams <= 0 ||
    !SERVING_UNITS.includes(String(f.servingSizeUnit))) return null;
  const read = nutrientReader(f);
  const kcal100 = read(USDA_NUTRIENTS.kcal);
  const protein100 = read(USDA_NUTRIENTS.protein);
  const carbs100 = read(USDA_NUTRIENTS.carbs);
  const fat100 = read(USDA_NUTRIENTS.fat);
  if (kcal100 === undefined || protein100 === undefined || carbs100 === undefined ||
    fat100 === undefined) return null;
  return {id, fdcId, label: {kcal100, protein100, carbs100, fat100, servingGrams}};
}

interface Per100 {
  kcal100: number;
  protein100: number;
  carbs100: number;
  fat100: number;
}

// Within pct of the reference (or abs, whichever is looser).
const near = (value: number, ref: number, pct: number, abs = 0) =>
  Math.abs(value - ref) <= Math.max(pct * Math.abs(ref), abs);

function agrees(v: Per100, label: Per100): boolean {
  const c = USDA_CROSS_CHECK;
  return near(v.kcal100, label.kcal100, c.kcalPct) &&
    near(v.protein100, label.protein100, c.macroPct, c.macroAbs) &&
    near(v.carbs100, label.carbs100, c.macroPct, c.macroAbs) &&
    near(v.fat100, label.fat100, c.macroPct, c.macroAbs);
}

// Two labels for one barcode are usable only when they agree (then the newer
// one is kept); otherwise the barcode has no trustworthy second opinion.
export function labelsAgree(a: UsdaLabel, b: UsdaLabel): boolean {
  return agrees(a, b) && near(a.servingGrams, b.servingGrams, USDA_CROSS_CHECK.servingPct);
}

// The factor to scale OFF's per-100 values by (serving ÷ 100), or null to
// leave the product as it is. `v` holds OFF's raw per-100 values; the caller
// (off.ts) has already checked the mistake is possible — entered per serving,
// a real serving, no alcohol — and that the scaled values pass the filters.
export function crossCheckFactor(v: Per100, servingGrams: number, label: UsdaLabel):
  number | null {
  const c = USDA_CROSS_CHECK;
  const mistake = 100 / servingGrams; // what OFF's mistake multiplied by
  if (mistake < c.minFactor && mistake > 1 / c.minFactor) return null;
  if (!near(label.servingGrams, servingGrams, c.servingPct)) return null; // not the same label
  if (label.kcal100 < c.minUsdaKcal || near(v.kcal100, label.kcal100, c.kcalPct)) return null;
  const f = servingGrams / 100;
  const scaled = {kcal100: v.kcal100 * f, protein100: v.protein100 * f,
    carbs100: v.carbs100 * f, fat100: v.fat100 * f};
  if (Math.abs(scaled.kcal100 - v.kcal100) < c.minKcalChange) return null;
  return agrees(scaled, label) ? f : null;
}
