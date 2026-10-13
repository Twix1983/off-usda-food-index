// Index record → the wire FoodItem (README.md §The FoodItem shape).
// Kept structural so this module depends on nothing outside src/food/.
import type {OffRecord, UsdaRecord} from "./types";

export interface FoodItemShape {
  name: string;
  brand?: string;
  serving: {grams: number; label?: string};
  kcal: number;
  proteinG: number;
  fibreG: number | null;
  carbsG: number;
  fatG: number;
  imageUrl?: string;
  barcode?: string;
  origin: "off" | "usda";
  originId: string;
}

export function offToFoodItem(r: OffRecord): FoodItemShape {
  return {
    name: r.name,
    ...(r.brand ? {brand: r.brand} : {}),
    serving: {grams: r.servingGrams, label: r.servingLabel},
    kcal: r.kcal, proteinG: r.proteinG, fibreG: r.fibreG, carbsG: r.carbsG, fatG: r.fatG,
    ...(r.imageUrl ? {imageUrl: r.imageUrl} : {}),
    barcode: r.barcode,
    origin: "off",
    originId: r.id,
  };
}

export function usdaToFoodItem(r: UsdaRecord): FoodItemShape {
  return {
    name: r.name,
    serving: {grams: r.servingGrams, label: r.servingLabel},
    kcal: r.kcal, proteinG: r.proteinG, fibreG: r.fibreG, carbsG: r.carbsG, fatG: r.fatG,
    origin: "usda",
    originId: r.id,
  };
}
