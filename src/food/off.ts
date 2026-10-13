// Open Food Facts product JSON → an `off` index record (README.md
// §How a build runs, "Open Food Facts → FoodItem"). Serves both the monthly import
// (JSONL dump lines) and the barcode fallback (the live API's product JSON,
// sent back by a client) — the two share one shape.
//
// The dump mixes two formats line by line: the old one (flat
// nutriments.<name>_100g, images.front_<lc>) and the new one (schema 1003+:
// nutrition.aggregated_set.nutrients.<name>.value with a per-value `source`,
// images.selected.front.<lc>). Both are read here.
import {createHash} from "node:crypto";

import {isStoreCode, normalizeBarcode} from "./barcode";
import {GROUP_KEY_HEX, KJ_PER_KCAL, OFF_FILTERS, OFF_IMAGE, OFF_REPAIR} from "./config";
import {crossCheckFactor} from "./crossCheck";
import {nutritionProblem, perServing, round1} from "./nutrition";
import type {MapResult, OffDropReason, OffRecord, UsdaLabel} from "./types";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json =>
  (v && typeof v === "object" && !Array.isArray(v) ? v as Json : {});

function num(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

interface Nutrient {
  value?: number;
  estimated: boolean;
  perServing: boolean; // OFF computed this per-100 value from a per-serving entry
}

// One nutrient per 100 g/ml, from whichever format the product uses.
// `prepared`: the values are the "as prepared" set (see below).
function reader(p: Json): {read: (name: string) => Nutrient; prepared: boolean} {
  const agg = obj(obj(p.nutrition).aggregated_set);
  const aggNutrients = obj(agg.nutrients);
  const newFormat = Object.keys(aggNutrients).length > 0 &&
    (agg.per === "100g" || agg.per === "100ml");
  const old = obj(p.nutriments);
  // Some ready-to-drink products carry ONLY "as prepared" values (e.g. a
  // Premier Protein shake). Use them when no as-sold energy exists at all —
  // one set or the other, never a mix.
  const hasSold = ["energy-kcal", "energy-kj", "energy"]
    .some((k) => num(old[`${k}_100g`]) !== undefined);
  const hasPrepared = ["energy-kcal", "energy-kj", "energy"]
    .some((k) => num(old[`${k}_prepared_100g`]) !== undefined);
  const suffix = !hasSold && hasPrepared ? "_prepared_100g" : "_100g";
  const oldPerServing = p.nutrition_data_per === "serving";
  const read = (name: string): Nutrient => {
    if (newFormat) {
      const n = obj(aggNutrients[name]);
      return {value: num(n.value), estimated: n.source === "estimate",
        perServing: n.source_per === "serving"};
    }
    return {value: num(old[`${name}${suffix}`]), estimated: false, perServing: oldPerServing};
  };
  return {read, prepared: !newFormat && suffix === "_prepared_100g"};
}

// kcal per 100: energy-kcal, else kJ ÷ 4.184 — never kJ read as kcal.
// (OFF keeps the generic `energy` value in kJ.)
function kcalPer100(read: (n: string) => Nutrient): Nutrient {
  const kcal = read("energy-kcal");
  if (kcal.value !== undefined) return kcal;
  for (const kjName of ["energy-kj", "energy"]) {
    const kj = read(kjName);
    if (kj.value !== undefined) return {...kj, value: kj.value / KJ_PER_KCAL};
  }
  return {estimated: false, perServing: false};
}

// `real` = the product states a usable serving (not our 100 g fallback).
function serving(p: Json): {grams: number; label: string; real: boolean} {
  const unit = p.serving_quantity_unit;
  const grams = num(p.serving_quantity);
  const unitOk = unit === undefined || unit === null || unit === "g" || unit === "ml";
  if (grams !== undefined && grams > 0 && grams <= OFF_FILTERS.maxServingGrams && unitOk) {
    const g = round1(grams);
    return {grams: g, label: text(p.serving_size, 60) ?? `${g} g`, real: true};
  }
  return {grams: 100, label: "100 g", real: false};
}

interface Per100Values {
  kcal100: number;
  protein100: number;
  carbs100: number;
  fat100: number;
  fibre100: number | null;
}

const validFibre = (v: number | undefined) =>
  v !== undefined && v >= 0 && v <= OFF_FILTERS.maxMacroPer100 ? v : null;

// Could OFF's per-serving mistake be in these values? Shared by the repair
// and the USDA cross-check: every used nutrient entered per serving (the "as
// prepared" set is described by other fields), a real serving of at least
// OFF_REPAIR.minServingGrams, and no alcohol (OFF stores it as % vol).
function scalable(perServing: boolean, prepared: boolean, s: {grams: number; real: boolean},
  alcohol: number | undefined): boolean {
  return perServing && !prepared && s.real && s.grams >= OFF_REPAIR.minServingGrams &&
    !(alcohol && alcohol > 0);
}

// The OFF_REPAIR overflow test: impossible even allowing for label rounding.
function overflows(v: Per100Values): boolean {
  const r = OFF_REPAIR;
  const macros = [v.protein100, v.carbs100, v.fat100];
  return v.kcal100 > r.overflowKcal || macros.some((m) => m > r.overflowMacro) ||
    macros.reduce((a, b) => a + b, 0) > r.overflowMacroSum;
}

// Every per-100 value times f (fibre from its raw value, then re-validated).
function scaled(v: Per100Values, fibreRaw: number | undefined, f: number): Per100Values {
  return {kcal100: v.kcal100 * f, protein100: v.protein100 * f, carbs100: v.carbs100 * f,
    fat100: v.fat100 * f, fibre100: validFibre(fibreRaw === undefined ? undefined : fibreRaw * f)};
}

// OFF's image folder rule: the stored code padded to 13 digits, split 3/3/3/rest.
export function offImageFolder(offCode: string): string {
  const padded = offCode.padStart(13, "0");
  const m = /^(\d{3})(\d{3})(\d{3})(\d+)$/.exec(padded);
  return m ? `${m[1]}/${m[2]}/${m[3]}/${m[4]}` : padded;
}

// The front image, 200 px — built from OFF's OWN stored code (its folder),
// not our normalized id. Prefers the product's language.
function frontImage(p: Json, offCode: string): string | undefined {
  const images = obj(p.images);
  const langs = [p.lc, p.lang, "en"].filter((l): l is string => typeof l === "string");
  const selected = obj(obj(images.selected).front); // new format
  const candidates: Array<[string, unknown]> = [];
  for (const l of langs) {
    candidates.push([l, obj(selected[l]).rev], [l, obj(images[`front_${l}`]).rev]);
  }
  for (const [k, v] of Object.entries(selected)) candidates.push([k, obj(v).rev]);
  for (const [k, v] of Object.entries(images)) {
    if (k.startsWith("front_")) candidates.push([k.slice(6), obj(v).rev]);
  }
  for (const [lang, rev] of candidates) {
    const r = num(rev);
    if (r !== undefined && /^[a-z]{2,3}$/.test(lang)) {
      const file = `front_${lang}.${r}.${OFF_IMAGE.size}.jpg`;
      return `${OFF_IMAGE.base}/${offImageFolder(offCode)}/${file}`;
    }
  }
  return undefined;
}

function groupKey(r: Omit<OffRecord, "groupKey">): string {
  const basis = [r.brand?.toLowerCase() ?? "", r.name.toLowerCase(), r.servingGrams,
    Math.round(r.kcal100), round1(r.protein100), round1(r.carbs100), round1(r.fat100)].join("|");
  return createHash("sha1").update(basis).digest("hex").slice(0, GROUP_KEY_HEX);
}

// `labels` (the import only): USDA Branded Foods labels by normalized barcode,
// for the cross-check. The live barcode fallback passes none.
export function mapOffProduct(product: unknown,
  opts: {requireUs: boolean; labels?: ReadonlyMap<string, UsdaLabel>}):
  MapResult<OffRecord, OffDropReason> {
  const p = obj(product);
  const drop = (reason: OffDropReason) => ({ok: false as const, reason});

  if (opts.requireUs && !(Array.isArray(p.countries_tags) &&
    p.countries_tags.includes("en:united-states"))) return drop("not_us");

  const offCode = typeof p.code === "string" ? p.code.trim() : String(p.code ?? "");
  const id = normalizeBarcode(offCode);
  if (!id) return drop("bad_code");
  if (isStoreCode(id)) return drop("store_code");

  const name = text(p.product_name_en, 120) ?? text(p.product_name, 120) ??
    text(p.generic_name_en, 120) ?? text(p.generic_name, 120);
  if (!name || name.length < 2) return drop("no_name");

  const {read, prepared} = reader(p);
  const kcal = kcalPer100(read);
  if (kcal.value === undefined) return drop("no_kcal");
  const protein = read("proteins");
  const carbs = read("carbohydrates");
  const fat = read("fat");
  if ([kcal, protein, carbs, fat].some((n) => n.estimated)) return drop("estimated_nutrition");
  // A blank macro counts as 0 (olive oil often lists only fat) — the calorie
  // check below still has to agree, so a real gap can't slip through.
  if (protein.value === undefined && carbs.value === undefined && fat.value === undefined) {
    return drop("no_macros");
  }
  const fibre = read("fiber");
  const fibreRaw = fibre.estimated ? undefined : fibre.value;
  let per100: Per100Values = {
    kcal100: kcal.value,
    protein100: protein.value ?? 0,
    carbs100: carbs.value ?? 0,
    fat100: fat.value ?? 0,
    fibre100: validFibre(fibreRaw),
  };
  const alcohol = read("alcohol").value;
  const s = serving(p);
  const enteredPerServing = [kcal, protein, carbs, fat].every((n) => n.value === undefined ||
    n.perServing);
  const canScale = scalable(enteredPerServing, prepared, s, alcohol);
  let repaired: OffRecord["repaired"];
  const problem = nutritionProblem({...per100, alcohol100: alcohol});
  if (problem) {
    // The one repair: undo OFF's per-serving inflation (OFF_REPAIR). A
    // repair that still fails any check keeps the ORIGINAL drop reason.
    const magnitude = problem === "kcal_range" || problem === "macro_range" ||
      problem === "macro_sum";
    if (!magnitude || !canScale || !overflows(per100)) return drop(problem);
    const fixed = scaled(per100, fibreRaw, s.grams / 100);
    if (nutritionProblem(fixed)) return drop(problem);
    per100 = fixed;
    repaired = "overflow";
  } else if (canScale && opts.labels?.has(id)) {
    // The USDA cross-check (crossCheck.ts): the same mistake, believable.
    const f = crossCheckFactor(per100, s.grams, opts.labels.get(id) as UsdaLabel);
    const fixed = f === null ? null : scaled(per100, fibreRaw, f);
    if (fixed && !nutritionProblem(fixed)) {
      per100 = fixed;
      repaired = "cross_check";
    }
  }

  const brand = typeof p.brands === "string" ? text(p.brands.split(",")[0], 60) : undefined;
  const at = (v: number) => perServing(v, s.grams);
  const base: Omit<OffRecord, "groupKey"> = {
    id,
    barcode: id,
    name,
    ...(brand ? {brand} : {}),
    servingGrams: s.grams,
    servingLabel: s.label,
    kcal100: round1(per100.kcal100),
    protein100: round1(per100.protein100),
    carbs100: round1(per100.carbs100),
    fat100: round1(per100.fat100),
    fibre100: per100.fibre100 === null ? null : round1(per100.fibre100),
    kcal: Math.round(at(per100.kcal100)),
    proteinG: round1(at(per100.protein100)),
    carbsG: round1(at(per100.carbs100)),
    fatG: round1(at(per100.fat100)),
    fibreG: per100.fibre100 === null ? null : round1(at(per100.fibre100)),
    popularity: Math.max(0, Math.round(num(p.unique_scans_n) ?? 0)),
  };
  const imageUrl = frontImage(p, offCode);
  if (imageUrl) base.imageUrl = imageUrl;
  const record: OffRecord = {...base, groupKey: groupKey(base)};
  if (repaired) record.repaired = repaired;
  return {ok: true, record};
}

// When two OFF products normalize to one id (a small pack stored under both
// its UPC-E and its UPC-A), keep the more complete record.
export function betterOffRecord(a: OffRecord, b: OffRecord): OffRecord {
  // An unrepaired record always beats a repaired twin.
  const score = (r: OffRecord) => (r.repaired ? 0 : 8) + (r.fibre100 !== null ? 4 : 0) +
    (r.imageUrl ? 2 : 0) + (r.servingLabel !== "100 g" ? 1 : 0) + r.popularity / 1e6;
  return score(b) > score(a) ? b : a;
}
