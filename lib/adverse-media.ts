/**
 * Types and helpers for the Challenge 10 external adverse-media pipeline.
 *
 * The severity taxonomy below is the authoritative set. Every record in the
 * `adverse_media` table must carry exactly one of these values. The UI should
 * group/filter by this enum, never by free-form upstream category strings.
 */

export const ADVERSE_MEDIA_SEVERITIES = [
  "sanctions",
  "fraud",
  "regulatory_action",
  "criminal_investigation",
  "safety_incident",
  "filing_lapse",
] as const;

export type AdverseMediaSeverity = (typeof ADVERSE_MEDIA_SEVERITIES)[number];

export interface AdverseMediaSource {
  id: string;
  name: string;
  url?: string | null;
  category: AdverseMediaSeverity;
  description?: string | null;
}

export interface AdverseMediaRecord {
  source_id: string;
  source_record_id: string | null;
  severity: AdverseMediaSeverity;
  entity_name_raw: string;
  entity_name_normalized: string;
  bn_prefix_guess: string | null;
  source_url: string | null;
  published_at: string | null; // ISO date
  summary: string | null;
  raw: unknown;
}

export interface AdverseMediaMatch {
  adverse_media_id: number;
  matched_source: "charity" | "vendor" | "grant_recipient";
  matched_entity_name: string;
  matched_bn: string | null;
  match_method: "exact_bn" | "exact_name" | "vector_cosine";
  confidence: number;
}

/**
 * Canonical name normalization used for exact-name matching against
 * funded-entity names (vendors, grant recipients, charity legal names).
 * Keep this in one place so ingestion and matching are symmetric.
 */
export function normalizeEntityName(raw: string): string {
  if (!raw) return "";
  let s = raw.toUpperCase();
  // Strip accents
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Replace punctuation (keep spaces between tokens)
  s = s.replace(/[.,'"`()\[\]{}/\\&+*@#$%^_=<>:;!?\-]/g, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  // Strip common legal suffixes (iterative — some names stack them)
  const SUFFIXES = [
    "LIMITED",
    "LIMITEE",
    "LIMITÉE",
    "LTD",
    "LTEE",
    "LTÉE",
    "INC",
    "INCORPORATED",
    "CORP",
    "CORPORATION",
    "CO",
    "COMPANY",
    "LLP",
    "LLC",
    "PLC",
    "SOCIETY",
    "ASSOCIATION",
    "FOUNDATION",
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of SUFFIXES) {
      if (s.endsWith(" " + suf)) {
        s = s.slice(0, s.length - suf.length - 1).trim();
        changed = true;
      }
    }
  }
  return s;
}

/**
 * Heuristic: if an upstream record exposes something that looks like a
 * Canadian Business Number (9-digit prefix, sometimes with an RR/RT/RC
 * suffix), extract the 9-digit prefix. Returns null when nothing plausible
 * is found. This is only a guess — match_method must record whether the
 * final link was made via BN or name/vector.
 */
export function extractBnPrefixGuess(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/\b(\d{9})\b/);
  return m ? m[1] : null;
}

export function isAdverseMediaSeverity(x: string): x is AdverseMediaSeverity {
  return (ADVERSE_MEDIA_SEVERITIES as readonly string[]).includes(x);
}
