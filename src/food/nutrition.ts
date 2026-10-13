// Shared arithmetic: per-100 → per-serving, rounding, the calorie check.
import {OFF_FILTERS} from "./config";

export const round1 = (n: number): number => Math.round(n * 10) / 10;

export function perServing(per100: number, grams: number): number {
  return (per100 * grams) / 100;
}

// Plausibility of one product's per-100 values; null = passes, else the
// first reason it fails. Alcohol counts 7 kcal/g in the calorie check.
export function nutritionProblem(v: {
  kcal100: number; protein100: number; carbs100: number; fat100: number;
  alcohol100?: number;
}): "kcal_range" | "macro_range" | "macro_sum" | "calorie_mismatch" | null {
  const f = OFF_FILTERS;
  if (v.kcal100 < 0 || v.kcal100 > f.maxKcalPer100) return "kcal_range";
  const macros = [v.protein100, v.carbs100, v.fat100];
  if (macros.some((m) => m < 0 || m > f.maxMacroPer100)) return "macro_range";
  if (macros.reduce((a, b) => a + b, 0) > f.maxMacroSumPer100) return "macro_sum";
  const fromMacros = 4 * v.protein100 + 4 * v.carbs100 + 9 * v.fat100 +
    7 * Math.max(0, v.alcohol100 ?? 0);
  const lo = fromMacros * f.calorieRatioMin - f.calorieSlackKcal;
  const hi = fromMacros * f.calorieRatioMax + f.calorieSlackKcal;
  if (v.kcal100 < lo || v.kcal100 > hi) return "calorie_mismatch";
  return null;
}
