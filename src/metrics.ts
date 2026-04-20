/**
 * Canonical funding-metric helpers (MCP server side).
 *
 * Mirrors lib/metrics.ts in the Next.js app. The two modules exist because
 * the MCP server reads records straight from the CKAN DataStore REST API
 * (keys are CRA field codes like "4120", "4540") whereas the web app reads
 * PostgreSQL columns (gov_funding_federal, compensation). Same definitions,
 * different parsers. See CLAUDE.md §"Engineering Standards — Data Accuracy"
 * and lib/metrics.ts for the full prose rationale.
 *
 * Canonical definitions (must match lib/metrics.ts exactly):
 *   Metric 1  Verified grants (annualized federal disbursements):
 *             SUM(agreement_value) / GREATEST(DISTINCT years, 1).
 *             BN prefix match = first 9 chars of business number.
 *             Grants window: agreement_start_date >= '2020-01-01',
 *             agreement_value > 0. Dependency % capped at 100.
 *   Metric 2  Self-reported T3010 gov revenue = CRA Line 4120 ONLY.
 *             Never sum 4130 (investment income) or 4140 (other revenue).
 *   Metric 3  Compensation ratio = COALESCE(4540, 5010) / 4200.
 *             Revenue denominator — matches mv_ghost_capacity and the
 *             web-app API so the same BN shows identical % everywhere.
 *             Not capped (deficit years can exceed 100%).
 */

export interface CanonicalCharityMetrics {
  totalRevenue: number | null;
  totalExpenditure: number | null;
  selfReportedGovRevenue: number | null;
  selfReportedGovRevenuePct: number | null;
  verifiedGrantsAnnual: number | null;
  verifiedGrantsPct: number | null;
  yearsActive: number;
  compensationTotal: number | null;
  compensationPct: number | null;
}

export interface GrantsAggregate {
  totalValue: number;
  yearsActive: number;
  annualized: number;
}

export function parseNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,\s]/g, "").trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function bnPrefix(bn: string | null | undefined): string | null {
  if (!bn) return null;
  const trimmed = bn.trim();
  if (trimmed.length < 9) return null;
  return trimmed.substring(0, 9);
}

export function capPct(pct: number | null): number | null {
  if (pct === null) return null;
  if (!Number.isFinite(pct)) return null;
  return Math.min(pct, 100);
}

export function annualizeGrants(records: ReadonlyArray<Record<string, unknown>>): GrantsAggregate {
  let total = 0;
  const years = new Set<number>();
  for (const r of records) {
    const v = parseNum(r.agreement_value);
    if (v === null || v <= 0) continue;
    const rawDate = r.agreement_start_date;
    const dateStr = typeof rawDate === "string" ? rawDate : rawDate == null ? "" : String(rawDate);
    if (dateStr.length < 4) continue;
    const yr = Number.parseInt(dateStr.substring(0, 4), 10);
    if (!Number.isFinite(yr) || yr < 2020) continue;
    total += v;
    years.add(yr);
  }
  const yearsActive = Math.max(years.size, 1);
  return { totalValue: total, yearsActive, annualized: total / yearsActive };
}

/**
 * Extract canonical T3010 financial metrics from a CKAN DataStore record
 * (keys are CRA field codes). Optionally combine with a pre-computed
 * grants aggregate for verified-grants metrics.
 */
export function buildCanonicalCharityMetrics(
  record: Record<string, unknown>,
  grants: GrantsAggregate | null,
): CanonicalCharityMetrics {
  const num = (code: string) => parseNum(record[code]);
  // Field codes (verified against CRA T3010 CKAN metadata):
  //   4120 = revenue from government (self-reported, any level)
  //   4130 = non-government transfers / investment income
  //   4140 = other revenue (unrealized gains, non-receipted, etc.)
  //   4200 = TOTAL REVENUE
  //   4540 = management/admin compensation
  //   5010 = management/admin expenditure (fallback for 4540)
  //   5100 = TOTAL EXPENDITURE
  const totalRevenue = num("4200");
  const totalExpenditure = num("5100");
  const selfReportedGovRevenue = num("4120");
  const compensationTotal = num("4540") ?? num("5010");

  const selfReportedGovRevenuePct =
    totalRevenue !== null && totalRevenue > 0 && selfReportedGovRevenue !== null
      ? capPct((selfReportedGovRevenue / totalRevenue) * 100)
      : null;

  const verifiedGrantsAnnual =
    grants !== null && grants.annualized > 0 ? grants.annualized : null;

  const verifiedGrantsPct =
    totalRevenue !== null && totalRevenue > 0 && verifiedGrantsAnnual !== null
      ? capPct((verifiedGrantsAnnual / totalRevenue) * 100)
      : null;

  // Metric 3: revenue denominator (see module docstring).
  const compensationPct =
    totalRevenue !== null && totalRevenue > 0 && compensationTotal !== null
      ? (compensationTotal / totalRevenue) * 100
      : null;

  return {
    totalRevenue,
    totalExpenditure,
    selfReportedGovRevenue,
    selfReportedGovRevenuePct,
    verifiedGrantsAnnual,
    verifiedGrantsPct,
    yearsActive: grants?.yearsActive ?? 1,
    compensationTotal,
    compensationPct,
  };
}

/** Short prompt-safe description of the canonical rules for AI/tool text. */
export const T3010_METRIC_PROMPT_NOTE =
  "Self-reported T3010 government revenue = CRA Line 4120 ONLY. Line 4130 " +
  "is investment income and Line 4140 is other revenue — never sum them into " +
  "'government funding'. For verified federal disbursements, aggregate the " +
  "grants table by substr(recipient_business_number, 1, 9); annualize as " +
  "SUM(agreement_value) / COUNT(DISTINCT fiscal_year). Cap dependency % at 100. " +
  "Compensation ratio uses total_revenue as the denominator (matches " +
  "mv_ghost_capacity).";
