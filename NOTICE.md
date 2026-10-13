# Data licences

The code in this repository is MIT licensed (see `LICENSE`). The data it
reads and builds is not part of the code, and keeps its own licences:

- **Open Food Facts** — the product database is © Open Food Facts
  contributors, available under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/);
  its individual contents under the
  [Database Contents License](https://opendatacommons.org/licenses/dbcl/1-0/);
  product images under [CC BY-SA](https://creativecommons.org/licenses/by-sa/3.0/).
  https://world.openfoodfacts.org
- **USDA FoodData Central** — public domain (CC0 1.0).
  https://fdc.nal.usda.gov

This repository publishes the method used to build a derived database from
Open Food Facts (ODbL share-alike): the mapping, filters and import steps.
The small samples under `tests/fixtures/` are excerpts of both sources,
under the same licences (`tests/fixtures/README.md`).

The Open Food Facts collection and the USDA collection are always kept
apart — no record mixes the two. USDA's Branded Foods labels are read during
an import only to detect one kind of Open Food Facts entry mistake; no USDA
value is written into an Open Food Facts record.
