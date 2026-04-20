/**
 * Vendor-name normalization — canonical rules used by procurement MVs
 * (Challenges 4, 5, 9) and any page/API that groups contracts by vendor.
 *
 * Why this file exists
 * --------------------
 * Federal proactive-disclosure contract data does NOT include a vendor
 * business number or any normalized vendor ID. The vendor_name column in
 * `contracts` is free-text, entered per-department, and the same legal
 * entity appears under dozens of spellings — e.g.:
 *   "DELOITTE INC.", "Deloitte LLP", "DELOITTE & TOUCHE LLP",
 *   "Deloitte Inc", "Samson Belair / Deloitte & Touche", ...
 *   "MICROSOFT CANADA INC.", "Microsoft Canada Inc.", "MICROSOFT
 *   LICENSING, GP", "Microsoft Corporation", ...
 *   "COFOMO OTTAWA", "Cofomo Inc", "COFOMO INC.", ...
 *
 * Without aggressive normalization, HHI, CR4/CR10, and "top vendors" are
 * underestimated (under-merging inflates vendor count and flattens
 * concentration).  Wave 1 used a minimal `UPPER + strip legal suffix`
 * expression. This module extends that with explicit family rules for the
 * major federal incumbents.
 *
 * Two consumers
 * -------------
 *   1.  Materialized views (built by scripts/optimize-db.ts) call the
 *       Postgres function `normalize_vendor_name(text) RETURNS text` whose
 *       body is defined below (NORMALIZE_VENDOR_SQL_BODY).
 *   2.  API/TS code that needs the same mapping at query time calls
 *       `normalizeVendorName(raw)` from this module.
 *
 * Both paths MUST produce identical output for any given input. The test
 * strategy is: for each family rule below, we ran a spot-check against the
 * live DB (`deloitte%`, `microsoft%`, `cofomo%`) and confirmed the rule
 * collapses the observed variants.
 */

// --- Family rules --------------------------------------------------------
//
// Each entry: if the base-normalized name matches `match` (regex, case-
// sensitive — base-normalized is already uppercase), replace the whole
// name with `canonical`. Rules are evaluated in order; first match wins.
//
// Keep this list conservative: only collapse when we are confident the
// variants are the same legal/economic actor. Joint ventures (e.g.
// "EMERION-COFOMO & FMC") are deliberately NOT collapsed into the
// member company — they are distinct procurement actors.

export interface VendorFamilyRule {
  canonical: string;
  // Postgres-flavoured regex (POSIX ERE). Must also be valid JS regex.
  match: string;
  note: string;
}

export const VENDOR_FAMILY_RULES: VendorFamilyRule[] = [
  {
    canonical: "DELOITTE",
    // Any name starting with "DELOITTE" OR "SAMSON BELAIR / DELOITTE"
    // (Quebec trade name of Deloitte & Touche prior to 2011 rebrand).
    match: "^(DELOITTE|SAMSON BELAIR.*DELOITTE)",
    note: "Deloitte umbrella — includes Deloitte Inc, LLP, & Touche, Consulting, Samson Belair/Deloitte.",
  },
  {
    canonical: "MICROSOFT",
    // Microsoft Canada Inc/Co, Microsoft Corporation, Microsoft Licensing GP,
    // Microsoft Ireland, Microsoft alone, etc.
    match: "^MICROSOFT($| )",
    note: "Microsoft umbrella — Canada subsidiary, Corporation, Licensing GP all roll up to Microsoft parent.",
  },
  {
    canonical: "COFOMO",
    // Bare Cofomo variants (Cofomo, Cofomo Inc, Cofomo Ottawa). Joint
    // ventures ("EMERION-COFOMO & FMC") stay distinct and are not matched
    // by the anchored regex.
    match: "^COFOMO( OTTAWA)?$",
    note: "Cofomo bare-name variants. Joint ventures deliberately excluded.",
  },
  {
    canonical: "IBM",
    match: "^(IBM|INTERNATIONAL BUSINESS MACHINES)($| )",
    note: "IBM / IBM Canada / International Business Machines.",
  },
  {
    canonical: "KPMG",
    match: "^KPMG($| )",
    note: "KPMG LLP, KPMG Canada, KPMG MSLP, etc.",
  },
  {
    canonical: "PWC",
    match: "^(PWC|PRICEWATERHOUSECOOPERS|PRICE WATERHOUSE COOPERS)($| )",
    note: "PwC / PricewaterhouseCoopers family.",
  },
  {
    canonical: "ERNST AND YOUNG",
    // "&" is replaced with "AND" during base normalization.
    match: "^(ERNST AND YOUNG|EY)($| )",
    note: "Ernst & Young / EY family.",
  },
  {
    canonical: "ACCENTURE",
    match: "^ACCENTURE($| )",
    note: "Accenture Inc, LLP, Canada, etc.",
  },
  {
    canonical: "CGI",
    match: "^(CGI|CONSEILLERS EN GESTION ET INFORMATIQUE)($| )",
    note: "CGI Group / CGI Information Systems / CGI Inc.",
  },
  {
    canonical: "BELL CANADA",
    // Bell Canada, Bell Mobility, Bell Media, Bell Solutions Techniques.
    match: "^BELL( CANADA| MOBILITY| MEDIA| SOLUTIONS)",
    note: "Bell Canada and subsidiaries.",
  },
  {
    canonical: "TELUS",
    match: "^TELUS($| )",
    note: "TELUS Communications, TELUS Health, etc.",
  },
  {
    canonical: "ROGERS",
    match: "^ROGERS( COMMUNICATIONS| MEDIA| WIRELESS)?",
    note: "Rogers Communications / Wireless / Media.",
  },
  {
    canonical: "SNC-LAVALIN",
    // After base normalization punctuation is dropped, so "SNC-LAVALIN"
    // becomes "SNC LAVALIN"; match both.
    match: "^(SNC LAVALIN|SNCLAVALIN|SNC-LAVALIN)",
    note: "SNC-Lavalin / AtkinsRéalis rebrand not yet applied to GC data.",
  },
];

// --- Base normalization -------------------------------------------------

/**
 * Postgres expression that implements the SAME normalization as
 * `normalizeVendorName` in TypeScript. Used to define the `normalize_vendor_name`
 * SQL function. Keep in sync with the TS implementation.
 *
 * Steps (applied in order):
 *   1. NULL / empty → NULL
 *   2. UPPER
 *   3. Replace `&` with ` AND `
 *   4. Replace any run of non-alphanumeric-or-space with a single space
 *   5. Collapse whitespace
 *   6. Strip trailing legal suffix tokens (INC, LTD, LLP, LLC, CORP,
 *      CORPORATION, LIMITED, INCORPORATED, CO, COMPANY, GP, LP, SRL,
 *      LTEE, LTÉE, SA, NV, BV, GMBH, PLC) — repeat up to 3 times to handle
 *      stacked suffixes like "DELOITTE INC LLP".
 *   7. trim
 *   8. Apply family rules via CASE expression.
 *
 * If you change this, rebuild `mv_*` via `node scripts/optimize-db.ts --force`.
 */
const BASE_SUFFIX_STRIP =
  // One iteration of suffix removal. Wrap in outer expression multiple times.
  `regexp_replace($1,
     '\\s+(INC|LTD|LLP|LLC|CORP|CORPORATION|LIMITED|INCORPORATED|CO|COMPANY|GP|LP|SRL|LTEE|LTÉE|SA|NV|BV|GMBH|PLC)\\s*$',
     '', 'i')`;

/**
 * SQL body for `CREATE FUNCTION normalize_vendor_name(text) RETURNS text`.
 * Uses only immutable string operations so the function is IMMUTABLE and
 * safe to index on.
 */
export const NORMALIZE_VENDOR_SQL_BODY = `
BEGIN
  IF $1 IS NULL OR btrim($1) = '' THEN
    RETURN NULL;
  END IF;

  -- Step 1-5: uppercase, ampersand, strip punctuation, collapse whitespace.
  DECLARE
    v text := upper(btrim($1));
  BEGIN
    v := regexp_replace(v, '&', ' AND ', 'g');
    v := regexp_replace(v, '[^A-Z0-9 ]+', ' ', 'g');
    v := regexp_replace(v, '\\s+', ' ', 'g');
    v := btrim(v);

    -- Step 6: strip trailing legal suffix tokens up to 3x (handles
    -- "DELOITTE INC LLP" style stacking).
    FOR i IN 1..3 LOOP
      v := regexp_replace(v,
        '\\s+(INC|LTD|LLP|LLC|CORP|CORPORATION|LIMITED|INCORPORATED|CO|COMPANY|GP|LP|SRL|LTEE|SA|NV|BV|GMBH|PLC)$',
        '', 'g');
    END LOOP;
    v := btrim(v);

    -- Step 8: family rules.
${VENDOR_FAMILY_RULES.map(
  (r) => `    IF v ~ '${r.match}' THEN RETURN '${r.canonical}'; END IF;`,
).join("\n")}

    RETURN v;
  END;
END;
`;
// Suppress "unused BASE_SUFFIX_STRIP" — we keep it as documentation of the
// regex used inline in the PL/pgSQL function above.
void BASE_SUFFIX_STRIP;

// --- TypeScript implementation ------------------------------------------

const LEGAL_SUFFIX_RE =
  /\s+(INC|LTD|LLP|LLC|CORP|CORPORATION|LIMITED|INCORPORATED|CO|COMPANY|GP|LP|SRL|LTEE|LTÉE|SA|NV|BV|GMBH|PLC)$/i;

export function normalizeVendorName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let v = raw.trim();
  if (v === "") return null;
  v = v.toUpperCase();
  v = v.replace(/&/g, " AND ");
  v = v.replace(/[^A-Z0-9 ]+/g, " ");
  v = v.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const next = v.replace(LEGAL_SUFFIX_RE, "").trim();
    if (next === v) break;
    v = next;
  }
  for (const rule of VENDOR_FAMILY_RULES) {
    if (new RegExp(rule.match).test(v)) {
      return rule.canonical;
    }
  }
  return v;
}
