// Typesense collection schemas. Only what search needs is indexed (indexed
// fields are what uses the cluster's memory); every other record field is
// stored and returned but not indexed.
export const OFF_SCHEMA_FIELDS = [
  {name: "name", type: "string"},
  {name: "brand", type: "string", optional: true},
  {name: "barcode", type: "string"}, // exact-match filter for barcode lookups
  {name: "groupKey", type: "string", facet: true}, // group_by requires a facet
  {name: "popularity", type: "int32"}, // ranking after text match
] as const;

export const USDA_SCHEMA_FIELDS = [
  {name: "name", type: "string"},
  {name: "sourceRank", type: "int32"}, // FNDDS first among equal text matches
  {name: "nameLength", type: "int32"}, // then the shorter (plainer) name
] as const;

// The generic-food ranking, shared by search and the import checks.
export const USDA_SORT = "_text_match:desc,sourceRank:desc,nameLength:asc";
export const OFF_SORT = "_text_match:desc,popularity:desc";

export function offCollectionSchema(name: string) {
  return {name, fields: [...OFF_SCHEMA_FIELDS], default_sorting_field: "popularity"};
}

export function usdaCollectionSchema(name: string) {
  return {name, fields: [...USDA_SCHEMA_FIELDS], default_sorting_field: "sourceRank"};
}
