// USDA FoodData Central bulk JSON (FNDDS "Survey", SR Legacy, Foundation) →
// a `usda` index record (README.md §USDA FoodData Central).
// Nutrient amounts are per 100 g edible portion; match on nutrient.id.
import {perServing, round1} from "./nutrition";
import type {MapResult, UsdaDropReason, UsdaRecord} from "./types";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  (v && typeof v === "object" && !Array.isArray(v) ? v as Json : {});
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export type UsdaDataType = UsdaRecord["dataType"];

const SOURCE_RANK: Record<UsdaDataType, number> = {fndds: 2, sr_legacy: 1, foundation: 0};

// FDC nutrient ids — also read by the USDA cross-check (crossCheck.ts).
export const USDA_NUTRIENTS = {
  kcal: [1008, 2048, 2047], // Energy; Foundation often lacks 1008 → Atwater specific, general
  protein: [1003],
  carbs: [1005, 1050], // by difference; Foundation sometimes only by summation
  fat: [1004],
  fibre: [1079],
} as const;
const N = USDA_NUTRIENTS;

export function nutrientReader(food: Json): (ids: readonly number[]) => number | undefined {
  const byId = new Map<number, number>();
  for (const fn of Array.isArray(food.foodNutrients) ? food.foodNutrients : []) {
    const id = num(obj(obj(fn).nutrient).id);
    const amount = num(obj(fn).amount);
    if (id !== undefined && amount !== undefined && !byId.has(id)) byId.set(id, amount);
  }
  return (ids) => {
    for (const id of ids) if (byId.has(id)) return byId.get(id);
    return undefined;
  };
}

// "Chicken breast, grilled without sauce, skin not eaten" stays as is; FNDDS's
// "not specified" segments ("NFS", "NS as to cooking method") are dropped
// wherever they sit; the first letter is capitalized.
export function tidyUsdaName(description: string): string {
  const parts = description.replace(/\s+/g, " ").trim().split(/\s*,\s*/)
    .filter((seg, i) => i === 0 || !/^(NFS|NS as to\b.*)$/i.test(seg));
  const t = parts.join(", ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

interface Portion {
  grams: number;
  label: string;
  seq: number;
}

const grams = (g: number) => `${round1(g)} g`;

// The default household portion, per dataset.
function defaultPortion(food: Json, type: UsdaDataType): Portion | undefined {
  const raw = (Array.isArray(food.foodPortions) ? food.foodPortions : []).map(obj);
  const seq = (p: Json) => num(p.sequenceNumber) ?? 999;
  const valid = raw.filter((p) => (num(p.gramWeight) ?? 0) > 0);

  if (type === "fndds") {
    // "Quantity not specified" (code 90000) is FNDDS's default amount; show
    // the real portion that weighs the same ("1 medium breast (120 g)").
    const qns = valid.find((p) => p.modifier === "90000");
    const named = valid.filter((p) => p !== qns && typeof p.portionDescription === "string")
      .sort((a, b) => seq(a) - seq(b));
    const pick = (qns && named.find((p) => p.gramWeight === qns.gramWeight)) ?? named[0];
    if (!pick) return undefined;
    const g = num(pick.gramWeight) as number;
    return {grams: g, label: `${pick.portionDescription} (${grams(g)})`, seq: seq(pick)};
  }

  if (type === "sr_legacy") {
    // measureUnit is always "undetermined"; the words live in `modifier`.
    const named = valid.map((p) => ({p, mod: String(p.modifier ?? "")
      .replace(/\s*From \d+$/i, "").trim()})).filter((x) => x.mod !== "")
      .sort((a, b) => seq(a.p) - seq(b.p));
    const pick = named.find((x) => /^medium\b/i.test(x.mod)) ?? named[0];
    if (!pick) return undefined;
    const g = num(pick.p.gramWeight) as number;
    const amount = num(pick.p.amount) ?? 1;
    return {grams: g, label: `${amount} ${pick.mod} (${grams(g)})`, seq: seq(pick.p)};
  }

  // Foundation: a real unit (cup, tbsp, "Banana"); RACC is a label reference
  // amount, shown only when nothing else exists.
  const units = valid.filter((p) => obj(p.measureUnit).name !== "RACC")
    .sort((a, b) => seq(a) - seq(b));
  const pick = units[0];
  if (pick) {
    const g = num(pick.gramWeight) as number;
    const amount = num(pick.amount) ?? num(pick.value) ?? 1;
    const unit = String(obj(pick.measureUnit).name ?? "").toLowerCase();
    const mod = typeof pick.modifier === "string" && pick.modifier ? `, ${pick.modifier}` : "";
    return {grams: g, label: `${amount} ${unit}${mod} (${grams(g)})`, seq: seq(pick)};
  }
  const racc = valid.find((p) => obj(p.measureUnit).name === "RACC");
  if (racc) {
    const g = num(racc.gramWeight) as number;
    return {grams: g, label: `1 serving (${grams(g)})`, seq: seq(racc)};
  }
  return undefined;
}

export function mapUsdaFood(food: unknown, type: UsdaDataType):
  MapResult<UsdaRecord, UsdaDropReason> {
  if (!food || typeof food !== "object") return {ok: false, reason: "null_record"};
  const f = obj(food);
  const fdcId = num(f.fdcId);
  const description = typeof f.description === "string" ? f.description : "";
  if (fdcId === undefined || description.trim().length < 2) return {ok: false, reason: "no_name"};

  const read = nutrientReader(f);
  const kcal100 = read(N.kcal);
  if (kcal100 === undefined) return {ok: false, reason: "no_kcal"};
  const protein100 = read(N.protein);
  const carbs100 = read(N.carbs);
  const fat100 = read(N.fat);
  if (protein100 === undefined || carbs100 === undefined || fat100 === undefined) {
    return {ok: false, reason: "no_macros"};
  }
  const fibre100 = read(N.fibre) ?? null;

  const portion = defaultPortion(f, type) ?? {grams: 100, label: "100 g", seq: 0};
  const at = (v: number) => perServing(v, portion.grams);
  const name = tidyUsdaName(description);
  return {ok: true, record: {
    id: String(fdcId),
    name,
    dataType: type,
    sourceRank: SOURCE_RANK[type],
    nameLength: name.length,
    servingGrams: round1(portion.grams),
    servingLabel: portion.label,
    kcal100: round1(kcal100),
    protein100: round1(protein100),
    carbs100: round1(carbs100),
    fat100: round1(fat100),
    fibre100: fibre100 === null ? null : round1(fibre100),
    kcal: Math.round(at(kcal100)),
    proteinG: round1(at(protein100)),
    carbsG: round1(at(carbs100)),
    fatG: round1(at(fat100)),
    fibreG: fibre100 === null ? null : round1(at(fibre100)),
  }};
}

// One record per name, FNDDS preferred (household portions and fibre on
// every food), then SR Legacy, then Foundation.
export function dedupeUsda(records: UsdaRecord[]): UsdaRecord[] {
  const best = new Map<string, UsdaRecord>();
  for (const r of records) {
    const key = r.name.toLowerCase();
    const cur = best.get(key);
    if (!cur || r.sourceRank > cur.sourceRank) best.set(key, r);
  }
  return [...best.values()];
}
