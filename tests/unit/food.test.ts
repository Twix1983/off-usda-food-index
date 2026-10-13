// The shared food module on REAL samples (tests/fixtures/README.md).
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

import {describe, expect, it} from "vitest";

import {
  checkDigit,
  expandUpcE,
  isStoreCode,
  normalizeBarcode,
  offNormalize,
} from "../../src/food/barcode";
import {KJ_PER_KCAL} from "../../src/food/config";
import {brandedLabel, crossCheckFactor, labelsAgree} from "../../src/food/crossCheck";
import {betterOffRecord, mapOffProduct, offImageFolder} from "../../src/food/off";
import {offToFoodItem, usdaToFoodItem} from "../../src/food/toFoodItem";
import type {OffRecord, UsdaRecord} from "../../src/food/types";
import {dedupeUsda, mapUsdaFood, tidyUsdaName} from "../../src/food/usda";
import {loadBrandedLabels} from "../../scripts/food-index/branded";

const fx = (p: string) => resolve(__dirname, "../fixtures", p);
const jsonl = (p: string) => readFileSync(fx(p), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l));

type Product = Record<string, unknown> & {code: string};
const dump = new Map<string, Product>(
  jsonl("off/dump-samples.jsonl").map((l: {fixture: string; product: Product}) =>
    [l.fixture, l.product]));
const liveProducts = new Map<string, Product>(
  jsonl("off/live-api.jsonl").map((l: {requested: string; product: Product}) =>
    [l.requested, l.product]));
const usda = JSON.parse(readFileSync(fx("usda/samples.json"), "utf8")) as
  Record<"fndds" | "sr_legacy" | "foundation", unknown[]>;
// USDA Branded Foods products in the release's own line format, by fdcId.
const brandedLines = readFileSync(fx("usda/branded-samples.jsonl"), "utf8").trim().split("\n");
const branded = new Map<number, unknown>(brandedLines.slice(1).map((l) => {
  const food = JSON.parse(l.endsWith(",") ? l.slice(0, -1) : l.slice(0, -2));
  return [food.fdcId, food];
}));
const labelOf = (fdcId: number) => {
  const b = brandedLabel(branded.get(fdcId));
  if (!b) throw new Error(`no label for ${fdcId}`);
  return b.label;
};

const off = (p: unknown): OffRecord => {
  const r = mapOffProduct(p, {requireUs: true});
  if (!r.ok) throw new Error(`dropped: ${r.reason}`);
  return r.record;
};
const dropReason = (p: unknown) => {
  const r = mapOffProduct(p, {requireUs: true});
  return r.ok ? "kept" : r.reason;
};

describe("barcodes", () => {
  it("GS1 check digits", () => {
    expect(checkDigit("04900000634")).toBe(6);
    expect(checkDigit("001600027528")).toBe(7);
  });

  it("expands UPC-E (6, 7 or 8 digits) to UPC-A", () => {
    expect(expandUpcE("04963406")).toBe("049000006346"); // Coca-Cola 12 oz can
    expect(expandUpcE("0496340")).toBe("049000006346");
    expect(expandUpcE("496340")).toBe("049000006346");
    expect(expandUpcE("04963407")).toBeNull(); // wrong check digit
    expect(expandUpcE("24963406")).toBeNull(); // number system must be 0 or 1
  });

  it("follows OFF's own normalization", () => {
    expect(offNormalize("049000028911")).toBe("0049000028911"); // 12 → 13
    expect(offNormalize("00049000028911")).toBe("0049000028911"); // GTIN-14 with a leading 0
    expect(offNormalize("1977")).toBe("00001977"); // short → 8
    expect(offNormalize("10049000028918")).toBe("10049000028918"); // real GTIN-14 kept
    expect(offNormalize("0000")).toBeNull();
    expect(offNormalize("123456789012345")).toBeNull();
  });

  it("normalizes every scanner symbology to the house style", () => {
    const canned = "0049000006346";
    expect(normalizeBarcode("04963406", "upc_e")).toBe(canned); // small-pack UPC-E
    expect(normalizeBarcode("049000006346", "upc_a")).toBe(canned); // Android UPC-A
    expect(normalizeBarcode("0049000006346", "ean13")).toBe(canned); // iOS reports UPC-A as EAN-13
    expect(normalizeBarcode("00049000006346", "itf14")).toBe(canned);
    expect(normalizeBarcode("04963406")).toBe(canned); // the import: no format
    expect(normalizeBarcode("96385074", "ean8")).toBe("96385074"); // EAN-8 stays 8
    expect(normalizeBarcode("00001977")).toBe("00001977"); // a padded store code, not UPC-E
    expect(normalizeBarcode("12AB")).toBeNull();
    expect(normalizeBarcode("")).toBeNull();
  });

  it("a scan and OFF's stored code normalize to the same id, for every fixture", () => {
    const products = [...dump.values(), ...liveProducts.values()];
    for (const p of products) {
      const stored = normalizeBarcode(p.code);
      if (!stored) continue;
      // What a phone's scanner would report for this product's printed barcode.
      const digits = p.code.replace(/^0+/, "");
      const scans: Array<[string, string]> = [];
      if (p.code.length === 8 && expandUpcE(p.code)) scans.push([p.code, "upc_e"]);
      else if (digits.length <= 12 && p.code.length > 8) {
        scans.push([digits.padStart(12, "0"), "upc_a"], [digits.padStart(13, "0"), "ean13"]);
      } else if (digits.length === 13) scans.push([digits, "ean13"]);
      for (const [code, format] of scans) {
        expect(normalizeBarcode(code, format), `${p.code} as ${format}`).toBe(stored);
      }
    }
  });

  it("store-internal codes (random weight, in-store, restricted) are flagged", () => {
    expect(isStoreCode("0200098502091")).toBe(true);
    expect(isStoreCode("0400000004365")).toBe(true);
    expect(isStoreCode("2000000002603")).toBe(true);
    expect(isStoreCode("0049000006346")).toBe(false);
    expect(isStoreCode("96385074")).toBe(false);
  });
});

describe("Open Food Facts mapper — dump samples (both formats)", () => {
  it("old format: name, brand, serving, per-serving macros, 200 px image", () => {
    const p = dump.get("old_ok_image") as Product;
    const r = off(p);
    expect(r.id).toBe(normalizeBarcode(p.code));
    expect(r.barcode).toBe(r.id);
    expect(r.imageUrl).toMatch(new RegExp("^https://images\\.openfoodfacts\\.org/images/" +
      "products/\\d{3}/\\d{3}/\\d{3}/\\d+/front_[a-z]+\\.\\d+\\.200\\.jpg$"));
    expect(r.kcal).toBe(Math.round(r.kcal100 * r.servingGrams / 100));
  });

  it("new format (schema 1003+): values from nutrition.aggregated_set", () => {
    const p = dump.get("new_ok_image") as Product & {nutrition: {aggregated_set: {
      nutrients: Record<string, {value: number}>}}};
    const r = off(p);
    const n = p.nutrition.aggregated_set.nutrients;
    expect(r.protein100).toBeCloseTo(n.proteins.value, 1);
    expect(r.kcal100).toBeCloseTo(n["energy-kcal"].value, 1);
    expect(typeof p.serving_quantity).toBe("string"); // "85" — read as a number
    expect(r.servingGrams).toBe(Number(p.serving_quantity));
    expect(r.imageUrl).toContain("/front_");
  });

  it("per 100 ml drinks are treated as grams", () => {
    expect(dropReason(dump.get("new_per_100ml"))).toBe("kept");
  });

  it("no serving size → 100 g, labelled \"100 g\"", () => {
    const r = off(dump.get("no_serving"));
    expect(r.servingGrams).toBe(100);
    expect(r.servingLabel).toBe("100 g");
    expect(r.kcal).toBe(Math.round(r.kcal100));
  });

  it("kJ only → kcal = kJ ÷ 4.184 (never kJ read as kcal)", () => {
    const p = dump.get("kj_only") as Product & {nutriments: Record<string, number>};
    expect(p.nutriments["energy-kcal_100g"]).toBeUndefined();
    expect(off(p).kcal100).toBeCloseTo(p.nutriments["energy-kj_100g"] / KJ_PER_KCAL, 1);
  });

  it("missing fibre → null (kept, not zero)", () => {
    const r = off(dump.get("missing_fibre"));
    expect(r.fibre100).toBeNull();
    expect(r.fibreG).toBeNull();
  });

  it("a blank macro counts as 0 when the calories still agree", () => {
    expect(dropReason(dump.get("blank_macro_kept"))).toBe("kept");
  });

  it("a junk serving unit (%, kJ…) falls back to 100 g", () => {
    expect(off(dump.get("serving_unit_junk")).servingGrams).toBe(100);
  });

  it("alcohol counts 7 kcal/g in the calorie check", () => {
    expect(dropReason(dump.get("alcohol"))).toBe("kept");
  });

  it("an 8-digit UPC-E code is indexed under its expanded 13-digit id", () => {
    expect(off(dump.get("upc_e_8digit")).id).toHaveLength(13);
  });

  it("quality filters drop junk, each with its reason", () => {
    expect(dropReason(dump.get("drop_macro_sum"))).toBe("macro_sum");
    expect(dropReason(dump.get("drop_kcal_range"))).toBe("kcal_range"); // repair fails
    expect(dropReason(dump.get("drop_calorie_mismatch"))).toBe("calorie_mismatch");
    expect(dropReason(dump.get("drop_estimated"))).toBe("estimated_nutrition");
    expect(dropReason(dump.get("drop_store_code"))).toBe("store_code");
    expect(dropReason(dump.get("drop_no_name"))).toBe("no_name");
    expect(dropReason(dump.get("drop_no_kcal"))).toBe("no_kcal");
  });

  it("repair: per-100 g values entered per serving are scaled back (old format)", () => {
    // Canola Harvest spread, 14 g serving: OFF showed 4,590 kcal and 510 g fat
    // "per 100 g"; the label's real per-100 g values were typed per serving.
    const r = off(dump.get("repaired_per_serving"));
    expect(r.repaired).toBe("overflow");
    expect([r.kcal100, r.fat100, r.servingGrams, r.kcal, r.fatG])
      .toEqual([642.6, 71.4, 14, 90, 10]);
  });

  it("repair: the new format (source_per serving) too", () => {
    const r = off(dump.get("repaired_new_format")); // whole wheat tortillas, 45 g
    expect(r.repaired).toBe("overflow");
    expect(r.kcal100).toBeCloseTo(168.9, 1);
    expect(r.carbs100).toBeCloseTo(42.2, 1);
  });

  it("a repair that still fails a check keeps the ORIGINAL drop reason", () => {
    // Ritter Sport flakes: scaled back, the calories and macros still disagree.
    expect(dropReason(dump.get("drop_kcal_range"))).toBe("kcal_range");
    expect(dropReason(dump.get("drop_macro_sum"))).toBe("macro_sum");
  });

  it("honest oils up to 950 kcal/100 g are kept, unrepaired (label rounding)", () => {
    const r = off(dump.get("oil_under_950"));
    expect(r.kcal100).toBeGreaterThan(900);
    expect(r.repaired).toBeUndefined();
  });

  it("the repair gate: never per-100 g entries, tiny or missing servings, or alcohol", () => {
    const base = dump.get("repaired_per_serving") as Product & {nutriments: object};
    expect(dropReason({...base, nutrition_data_per: "100g"})).toBe("kcal_range");
    expect(dropReason({...base, serving_quantity: 3})).toBe("kcal_range");
    expect(dropReason({...base, serving_quantity: null})).toBe("kcal_range");
    expect(dropReason({...base, nutriments: {...base.nutriments, alcohol_100g: 5}}))
      .toBe("kcal_range");
  });

  it("an unrepaired record beats a repaired twin on the same barcode", () => {
    const repaired = off(dump.get("repaired_per_serving"));
    const {repaired: _r, ...clean} = repaired;
    expect(betterOffRecord(repaired, {...clean, fibre100: null})).not.toHaveProperty("repaired");
    expect(_r).toBe("overflow");
  });

  it("one product under two barcodes shares a group key", () => {
    const a = off(dump.get("duplicate_1"));
    const b = off(dump.get("duplicate_2"));
    expect(a.id).not.toBe(b.id);
    expect(a.groupKey).toBe(b.groupKey);
  });

  it("the US tag is required for the import only", () => {
    const p = {...(dump.get("old_ok_image") as Product), countries_tags: ["en:france"]};
    expect(dropReason(p)).toBe("not_us");
    expect(mapOffProduct(p, {requireUs: false}).ok).toBe(true);
  });
});

describe("Open Food Facts mapper — live API products (the off_live path)", () => {
  it("maps every live product, with sane numbers", () => {
    for (const [code, p] of liveProducts) {
      const r = mapOffProduct(p, {requireUs: false});
      expect(r.ok, code).toBe(true);
      if (!r.ok) continue;
      expect(r.record.kcal).toBeGreaterThanOrEqual(0);
      expect(r.record.servingGrams).toBeGreaterThan(0);
    }
  });

  it("Quest bars pass the calorie check despite their fibre", () => {
    for (const code of ["0888849000012", "0888849000005"]) {
      const r = off(liveProducts.get(code));
      expect(r.brand?.toLowerCase()).toBe("quest");
      expect(r.proteinG).toBeGreaterThan(15);
    }
  });

  it("the Coke can's UPC-E and UPC-A records collapse onto one id", () => {
    // OFF holds them as two products (and tags neither US).
    const live = (code: string) => {
      const r = mapOffProduct(liveProducts.get(code), {requireUs: false});
      if (!r.ok) throw new Error(r.reason);
      return r.record;
    };
    const upcE = live("04963406");
    const upcA = live("049000006346");
    expect(upcE.id).toBe("0049000006346");
    expect(upcA.id).toBe("0049000006346");
    // Each image stays in OFF's own folder for the code OFF stored.
    if (upcE.imageUrl) expect(upcE.imageUrl).toContain("/000/000/496/3406/");
    expect([upcE, upcA]).toContain(betterOffRecord(upcE, upcA));
  });

  it("a prepared-only product (ready-to-drink shake) uses its prepared values", () => {
    const r = off(liveProducts.get("0643843714927"));
    expect(r.brand?.toLowerCase()).toBe("premier protein");
    expect(r.servingGrams).toBe(325);
    expect(r.proteinG).toBeGreaterThanOrEqual(25);
  });

  it("image folders follow OFF's split rule (padded to 13, split 3/3/3/rest)", () => {
    expect(offImageFolder("0049000006346")).toBe("004/900/000/6346");
    expect(offImageFolder("04963406")).toBe("000/000/496/3406");
  });
});

describe("USDA mapper — real FNDDS, SR Legacy and Foundation records", () => {
  const map = (type: "fndds" | "sr_legacy" | "foundation", i: number) =>
    mapUsdaFood(usda[type][i], type);
  const rec = (type: "fndds" | "sr_legacy" | "foundation", i: number): UsdaRecord => {
    const r = map(type, i);
    if (!r.ok) throw new Error(r.reason);
    return r.record;
  };

  it("FNDDS: the named portion that matches \"Quantity not specified\"", () => {
    const banana = rec("fndds", 0);
    expect(banana.name).toBe("Banana, raw");
    expect(banana.servingLabel).toBe("1 banana (126 g)"); // QNS weighs 126 g
    expect(banana.fibreG).not.toBeNull();
    const chicken = rec("fndds", 1);
    expect(chicken.servingLabel).toBe("1 medium breast (120 g)");
    expect(chicken.proteinG).toBeGreaterThan(30);
  });

  it("FNDDS: an empty nutrient list is dropped; \", NFS\" is trimmed", () => {
    expect(map("fndds", 2)).toEqual({ok: false, reason: "no_kcal"});
    expect(rec("fndds", 3).name).toBe("Milk");
  });

  it("SR Legacy: prefers the medium portion; strips \"From 19191\" junk", () => {
    expect(rec("sr_legacy", 0).servingLabel).toMatch(/^1 medium .*\(118 g\)$/);
    expect(rec("sr_legacy", 1).servingLabel).toBe("1 medium (44 g)");
    expect(rec("sr_legacy", 2).servingLabel).not.toContain("From");
    expect(rec("sr_legacy", 3).servingLabel).toBe("100 g"); // no portions at all
    expect(rec("sr_legacy", 4).fibre100).toBeNull(); // no fibre value
  });

  it("Foundation: a null record, kcal fallbacks, no energy, RACC-only", () => {
    expect(map("foundation", 0)).toEqual({ok: false, reason: "null_record"});
    expect(rec("foundation", 1).servingLabel).toBe("1 cup, chopped (76 g)");
    expect(rec("foundation", 2).kcal100).toBeGreaterThan(0); // Atwater (2048), no 1008
    expect(map("foundation", 3)).toEqual({ok: false, reason: "no_kcal"}); // table salt
    expect(rec("foundation", 4).servingLabel).toMatch(/^1 serving \(\d+(\.\d)? g\)$/);
  });

  it("names are tidied and deduped, FNDDS preferred", () => {
    expect(tidyUsdaName("  milk,  NFS ")).toBe("Milk");
    expect(tidyUsdaName("Chicken, NS as to part")).toBe("Chicken");
    expect(tidyUsdaName("Chicken breast, NS as to cooking method, skin not eaten"))
      .toBe("Chicken breast, skin not eaten");
    const a = rec("fndds", 0);
    const b = {...rec("sr_legacy", 0), name: "Banana, raw"};
    expect(dedupeUsda([b, a])).toEqual([a]);
  });
});

describe("index record → FoodItem", () => {
  it("off: barcode + originId = the normalized code; brand and image carried", () => {
    const r = off(liveProducts.get("0888849000005"));
    const item = offToFoodItem(r);
    expect(item).toMatchObject({origin: "off", originId: r.id, barcode: r.id,
      serving: {grams: r.servingGrams, label: r.servingLabel}});
  });

  it("usda: originId = fdcId, no brand, barcode or image", () => {
    const r = mapUsdaFood(usda.fndds[0], "fndds");
    if (!r.ok) throw new Error("dropped");
    const item = usdaToFoodItem(r.record);
    expect(item).toMatchObject({origin: "usda", originId: "2709224"});
    expect(item.brand ?? item.barcode ?? item.imageUrl).toBeUndefined();
  });
});

describe("USDA Branded Foods labels (the cross-check's second opinion)", () => {
  it("a label: the normalized barcode, per-100 values and the serving", () => {
    expect(brandedLabel(branded.get(1106312))).toEqual({id: "0076014101088", fdcId: 1106312,
      label: {kcal100: 117, protein100: 0, carbs100: 26.7, fat100: 0, servingGrams: 30}});
    expect(brandedLabel(branded.get(1121591))?.id).toBe("10030800005346"); // a GTIN-14
    // A 15 ml serving (ml matches the per-100 ml basis); a 14-digit GTIN padded with zeros.
    expect(brandedLabel(branded.get(2493047)))
      .toMatchObject({id: "0070641000394", label: {servingGrams: 15}});
  });

  it("unusable: a bad check digit, no energy, New Zealand, a serving in mg, and every " +
    "manufacturer-feed record (GDSN, Euromonitor)", () => {
    for (const fdcId of [1106915, 1111683, 2182643, 2493024, 344646, 2756397]) {
      expect(brandedLabel(branded.get(fdcId))).toBeNull();
    }
  });

  it("two labels for one barcode agree only on the same numbers and serving", () => {
    // Orange juice under its UPC-E and its UPC-A: the same label.
    expect(labelsAgree(labelOf(540078), labelOf(577058))).toBe(true);
    // A UPC-E and a UPC-A that USDA files as two different cream cheeses.
    expect(labelsAgree(labelOf(497082), labelOf(963249))).toBe(false);
    expect(labelsAgree(labelOf(577058), {...labelOf(577058), servingGrams: 240})).toBe(false);
  });

  it("the loader reads the release's lines; a duplicate keeps the newest, a conflict drops",
    async () => {
      const b = await loadBrandedLabels(fx("usda/branded-samples.jsonl"));
      expect({read: b.read, unusable: b.unusable, conflicting: b.conflicting, kept: b.labels.size})
        .toEqual({read: brandedLines.length - 1, unusable: 6, conflicting: 1, kept: 9});
      expect(b.labels.get("0025000000249")).toEqual(labelOf(577058));
      expect(b.labels.has("0021000007523")).toBe(false);
      expect(b.labels.get("0076014101088")).toEqual(labelOf(1106312));
    });

  it("a zip streams through unzip; a bad line, a cut-off file or a broken zip fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "branded-"));
    const zip = join(dir, "sample.zip");
    execFileSync("zip", ["-jq", zip, fx("usda/branded-samples.jsonl")]);
    expect((await loadBrandedLabels(zip)).read).toBe(brandedLines.length - 1);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, [brandedLines[0], brandedLines[1], "{not json},",
      brandedLines[brandedLines.length - 1]].join("\n"));
    await expect(loadBrandedLabels(bad)).rejects.toThrow(/line 3: not valid JSON/);
    const cut = join(dir, "cut.json");
    writeFileSync(cut, brandedLines.slice(0, -1).join("\n"));
    await expect(loadBrandedLabels(cut)).rejects.toThrow(/no closing product line/);
    const broken = join(dir, "broken.zip");
    writeFileSync(broken, "not a zip");
    await expect(loadBrandedLabels(broken)).rejects.toThrow(/unzip .* exited/);
  });
});

describe("the cross-check rule (crossCheckFactor)", () => {
  // A 71 g pastry: the label says 284 kcal per pastry = 400 per 100 g. Typed
  // per serving as 400, OFF shows 563.4 per 100 g.
  const label = {kcal100: 400, protein100: 6, carbs100: 50, fat100: 20, servingGrams: 71};
  const off = {kcal100: 563.4, protein100: 8.5, carbs100: 70.4, fat100: 28.2};

  it("OFF's numbers exactly 100 ÷ serving too high → scale back by serving ÷ 100", () => {
    expect(crossCheckFactor(off, 71, label)).toBe(0.71);
  });

  it("the mirror case: a big serving, numbers too low → scale up", () => {
    // A 283 g frozen meal at 150 kcal/100 g, typed per serving: OFF shows 53.
    const meal = {kcal100: 150, protein100: 8, carbs100: 18, fat100: 5, servingGrams: 283};
    const f = crossCheckFactor({kcal100: 53, protein100: 2.8, carbs100: 6.4, fat100: 1.8}, 283,
      meal);
    expect(f).toBe(2.83);
  });

  it("leaves it alone when it can't be told apart from label noise or a USDA error", () => {
    expect(crossCheckFactor(off, 85, {...label, servingGrams: 85})).toBeNull(); // factor 1.18
    expect(crossCheckFactor(off, 71, {...label, servingGrams: 100})).toBeNull(); // not one label
    expect(crossCheckFactor(label, 71, label)).toBeNull(); // OFF already agrees
    expect(crossCheckFactor(off, 71, {...label, fat100: 10})).toBeNull(); // a macro disagrees
    // Near-zero drinks: a change under 30 kcal, or a label under 40, is rounding.
    const drink = {kcal100: 30, protein100: 0, carbs100: 7.5, fat100: 0, servingGrams: 240};
    expect(crossCheckFactor({kcal100: 12.5, protein100: 0, carbs100: 3.1, fat100: 0}, 240,
      drink)).toBeNull();
  });
});

describe("the USDA cross-check in the mapper (real products + their USDA labels)", () => {
  const labels = loadBrandedLabels(fx("usda/branded-samples.jsonl")).then((b) => b.labels);
  const withLabels = async (p: unknown): Promise<OffRecord> => {
    const r = mapOffProduct(p, {requireUs: true, labels: await labels});
    if (!r.ok) throw new Error(`dropped: ${r.reason}`);
    return r.record;
  };
  const values = (r: OffRecord) => [r.kcal100, r.protein100, r.carbs100, r.fat100];

  it("too high: Sara Lee pound cake (76 g) scaled back to its label", async () => {
    const before = off(dump.get("cross_check_too_high"));
    expect(values(before)).toEqual([459, 6.9, 72.7, 15.6]); // no labels: the live path
    const r = await withLabels(dump.get("cross_check_too_high"));
    expect(r.repaired).toBe("cross_check");
    expect(values(r)).toEqual([348.8, 5.3, 55.3, 11.9]); // USDA: 342 · 5.26 · 55.3 · 11.8
    expect([r.servingGrams, r.kcal]).toEqual([76, 265]);
    expect(r.groupKey).not.toBe(before.groupKey);
  });

  it("too low: Amy's spinach pizza (132 g) scaled up to its label", async () => {
    expect(off(dump.get("cross_check_too_low")).kcal100).toBe(172);
    const r = await withLabels(dump.get("cross_check_too_low"));
    expect(r.repaired).toBe("cross_check");
    expect(values(r)).toEqual([227, 9.1, 27.3, 9.1]);
    expect(r.kcal).toBe(300); // the label's 300 kcal per serving
  });

  it("left alone: an honest match, a reformulation, a serving mismatch, a feed label",
    async () => {
      for (const name of ["cross_check_honest", "cross_check_reformulated",
        "cross_check_serving_mismatch", "cross_check_feed_label"]) {
        expect(await withLabels(dump.get(name))).toEqual(off(dump.get(name)));
      }
    });

  it("the gate: never per-100 g entries, alcohol, or the as-prepared set", async () => {
    const base = dump.get("cross_check_too_high") as
      Product & {nutriments: Record<string, unknown>};
    const prepared = Object.fromEntries(Object.entries(base.nutriments)
      .map(([k, v]) => [k.replace(/_100g$/, "_prepared_100g"), v]));
    for (const p of [{...base, nutrition_data_per: "100g"},
      {...base, nutriments: {...base.nutriments, alcohol_100g: 5}},
      {...base, nutriments: prepared}]) {
      expect((await withLabels(p)).repaired).toBeUndefined();
    }
  });

  it("an honest twin beats a corrected one on the same barcode", async () => {
    const fixed = await withLabels(dump.get("cross_check_too_high"));
    const {repaired: _r, ...clean} = fixed;
    expect(betterOffRecord(fixed, clean)).not.toHaveProperty("repaired");
    expect(_r).toBe("cross_check");
  });
});
