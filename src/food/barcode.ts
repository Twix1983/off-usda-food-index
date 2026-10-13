// Barcode house style (README.md §How a build runs): Open Food Facts' own
// rule — strip leading zeros, pad 7 or fewer digits to 8 and 9–12 to 13 —
// plus one step OFF doesn't take: UPC-E is expanded to its UPC-A, so a small
// pack's 8-digit code and its full 12-digit code land on the same record.
// The import and every lookup use this one function, so they can't disagree.

// The scanner's symbology as a mobile scanner reports it (expo-camera's names).
export type ScanFormat =
  "ean13" | "ean8" | "upc_a" | "upc_e" | "itf14" | "code128" | "code39" | string;

// GS1 mod-10 check digit for the digits before it.
export function checkDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

export function hasValidCheckDigit(code: string): boolean {
  return /^\d{8,14}$/.test(code) &&
    checkDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

// UPC-E (number system + 6 digits + check) → UPC-A (12 digits), or null
// when it isn't a valid UPC-E. Accepts 6 (NS 0, no check), 7 (NS + 6) or 8.
export function expandUpcE(raw: string): string | null {
  if (!/^\d{6,8}$/.test(raw)) return null;
  const withNs = raw.length === 6 ? `0${raw}` : raw.slice(0, 7);
  const ns = withNs[0];
  if (ns !== "0" && ns !== "1") return null;
  const d = withNs.slice(1);
  const last = d[5];
  let body: string;
  if (last === "0" || last === "1" || last === "2") {
    body = `${ns}${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  } else if (last === "3") {
    body = `${ns}${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  } else if (last === "4") {
    body = `${ns}${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  } else {
    body = `${ns}${d.slice(0, 5)}0000${last}`;
  }
  const check = checkDigit(body);
  if (raw.length === 8 && Number(raw[7]) !== check) return null;
  return `${body}${check}`;
}

// Open Food Facts' normalization of a digits-only code, or null for codes
// OFF itself would reject (empty, > 14 digits once zeros are stripped).
export function offNormalize(digits: string): string | null {
  const stripped = digits.replace(/^0+/, "");
  if (stripped.length === 0 || stripped.length > 14) return null;
  if (stripped.length <= 7) return stripped.padStart(8, "0");
  if (stripped.length === 8) return stripped;
  if (stripped.length <= 12) return stripped.padStart(13, "0");
  return stripped; // 13 or 14
}

// With no format (the import), an 8-digit code that starts with 0 and checks
// out as UPC-E is read as UPC-E: real EAN-8 product codes don't start with 0
// (GS1 keeps that prefix for in-store use), and OFF stores UPC-E this way.
// Mostly-zero codes ("00001977") are short store codes OFF padded, not UPC-E.
function looksLikeUpcE(eight: string): boolean {
  return eight.length === 8 && eight[0] === "0" && eight.replace(/^0+/, "").length >= 6 &&
    expandUpcE(eight) !== null;
}

// UPC-A → the 13-digit house style (a leading 0, like EAN-13's US prefix).
const upcAto13 = (upcA: string): string => upcA.padStart(13, "0");

// The normalized id: 13 digits for UPC/EAN-13 (and UPC-E), 8 for EAN-8,
// 14 for a case-level GTIN. null when it isn't a product barcode we index.
export function normalizeBarcode(raw: string, format?: ScanFormat): string | null {
  const code = String(raw ?? "").trim();
  if (!/^\d{1,24}$/.test(code)) return null;
  // A scanner that says UPC-E hands over 6–8 digits (some pass the expanded
  // UPC-A instead — that takes the general path below).
  if (format === "upc_e" && code.length <= 8) {
    const upcA = expandUpcE(code);
    return upcA ? upcAto13(upcA) : null;
  }
  const off = offNormalize(code);
  if (off && format !== "ean8" && looksLikeUpcE(off)) {
    const upcA = expandUpcE(off);
    return upcA ? upcAto13(upcA) : off;
  }
  return off;
}

// Codes that name a store's own item, not a product: UPC number system 2
// (random weight — the price is inside the code, so every pack differs) and
// 4 (in-store use), and EAN-13 prefixes 20–29 (restricted circulation). They
// can't be looked up reliably, so the index never holds them.
export function isStoreCode(normalized: string): boolean {
  return normalized.length === 13 &&
    (normalized.startsWith("02") || normalized.startsWith("04") || normalized[0] === "2");
}
