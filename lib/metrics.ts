/**
 * Canonical funding-metric helpers (Next.js / web-app side).
 *
 * Every consumer (entity API, charity API, AI prompt schema, challenge pages,
 * MCP tool wrappers) MUST go through this module so the same entity shows
 * identical numbers across every surface. See CLAUDE.md §"Engineering
 * Standards — Data Accuracy", Rules 1-8.
 *
 * ---------------------------------------------------------------------------
 * Metric 1 — Verified grants (annualized federal disbursements)
 * ---------------------------------------------------------------------------
 *   Source:        `grants` table (real federal agreements).
 *   Cross-ref key: substr(recipient_business_number, 1, 9) — 9-digit BN
 *                  prefix, matches the methodology used by
 *                  mv_zombie_recipients and mv_ghost_capacity.
 *   Window:        agreement_start_date >= '2020-01-01', agreement_value > 0.
 *   Aggregation:   total = SUM(agreement_value)
 *                  yearsActive = GREATEST(COUNT(DISTINCT EXTRACT(YEAR FROM
 *                                agreement_start_date)), 1)
 *                  annualized = total / yearsActive
 *   Dependency %:  LEAST(annualized / total_revenue * 100, 100)
 *                  — capped at 100 per CLAUDE.md Rule 7.
 *
 * ---------------------------------------------------------------------------
 * Metric 2 — Self-reported T3010 government revenue
 * ---------------------------------------------------------------------------
 *   Source:        `t3010_financial.gov_funding_federal` === CRA T3010
 *                  Line 4120 only. Never sum 4130 or 4140.
 *   Rationale:     Line 4130 is investment income (mapped to the
 *                  misleadingly named `gov_funding_provincial` column) and
 *                  Line 4140 is "other revenue" (mapped to the misleadingly
 *                  named `gov_funding_other` column). See CLAUDE.md
 *                  "Known Data Quality Issues" for evidence (Sobey / Mastercard
 *                  Foundation benchmarks).
 *   Dependency %:  LEAST(gov_funding_federal / total_revenue * 100, 100).
 *   Caveat:        4120 is self-reported and conflates all levels of
 *                  government plus fee-for-service revenue. For real
 *                  federal disbursements, prefer Metric 1.
 *
 * ---------------------------------------------------------------------------
 * Metric 3 — Compensation ratio
 * ---------------------------------------------------------------------------
 *   Chosen denominator: total_revenue  (NOT total_expenditure).
 *   Reason:        (a) aligns with dependency ratios above so the same
 *                  entity's gov % and comp % are commensurable; (b) matches
 *                  `mv_ghost_capacity.comp_pct` in scripts/optimize-db.ts
 *                  which uses (mgmt_admin_exp | compensation) / total_revenue.
 *                  Picking expenditure would create drift between the ghost
 *                  challenge page and entity/charity profiles for the same BN.
 *   Source column: COALESCE(compensation, mgmt_admin_exp)
 *                  — i.e. CRA Line 4540 (total compensation) if present,
 *                  else Line 5010 (management/admin expenditure) as a
 *                  documented fallback. This mirrors the MV.
 *   Ratio:         compensationTotal / total_revenue * 100. NOT capped;
 *                  values > 100 legitimately occur in deficit-year filings
 *                  (see CLAUDE.md: "88 charities report compensation/admin
 *                  exceeding revenue").
 */

/** Raw T3010 financial row as stored in `t3010_financial`. */
export interface T3010FinancialRow {
  total_revenue: number | string | null;
  total_expenditure: number | string | null;
  /** CRA Line 4120 — self-reported government revenue. */
  gov_funding_federal: number | string | null;
  /** CRA Line 4130 — investment income (NOT provincial gov funding). */
  gov_funding_provincial?: number | string | null;
  /** CRA Line 4140 — other revenue (NOT municipal gov funding). */
  gov_funding_other?: number | string | null;
  /** CRA Line 4540 — total compensation (preferred). */
  compensation: number | string | null;
  /** CRA Line 5010 — management/admin expenditure (fallback). */
  mgmt_admin_exp: number | string | null;
}

/** Aggregated grant window for a single BN prefix. */
export interface GrantsAggregate {
  /** SUM(agreement_value) over the 2020+ window. */
  totalValue: number;
  /** GREATEST(COUNT DISTINCT year, 1). */
  yearsActive: number;
  /** SUM / yearsActive. */
  annualized: number;
}

/** Canonical charity-level metric bundle used by every consumer. */
export interface CanonicalCharityMetrics {
  totalRevenue: number | null;
  totalExpenditure: number | null;

  /** Metric 2 — CRA Line 4120 only. */
  selfReportedGovRevenue: number | null;
  /** Metric 2 as % of revenue, capped at 100. */
  selfReportedGovRevenuePct: number | null;

  /** Metric 1 — annualized federal grants (BN-prefix match). */
  verifiedGrantsAnnual: number | null;
  /** Metric 1 as % of revenue, capped at 100. */
  verifiedGrantsPct: number | null;
  /** Number of distinct fiscal years of grants used in the annualization. */
  yearsActive: number;

  /** Metric 3 numerator (compensation preferred, mgmt_admin_exp fallback). */
  compensationTotal: number | null;
  /** Metric 3 — comp / revenue * 100. NOT capped. */
  compensationPct: number | null;
}

/**
 * Canonical SQL fragment that aggregates the verified-grants window for a
 * 9-digit BN prefix. Returns one row: { n, total_value, years_active }.
 * Consumers parameterize the prefix as `$1`.
 */
export const VERIFIED_GRANTS_SQL = `
  SELECT COUNT(*)::int AS n,
         COALESCE(SUM(agreement_value), 0)::numeric AS total_value,
         GREATEST(
           COUNT(DISTINCT EXTRACT(YEAR FROM agreement_start_date)),
           1
         )::int AS years_active
  FROM grants
  WHERE recipient_business_number IS NOT NULL
    AND substr(recipient_business_number, 1, 9) = $1
    AND agreement_value > 0
    AND agreement_start_date >= '2020-01-01'
`;

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Extract a 9-digit BN prefix, or null if the input isn't usable. */
export function bnPrefix(bn: string | null | undefined): string | null {
  if (!bn) return null;
  const trimmed = bn.trim();
  if (trimmed.length < 9) return null;
  return trimmed.substring(0, 9);
}

/**
 * Annualize a grants aggregate. Both inputs should come from
 * VERIFIED_GRANTS_SQL (or its CKAN equivalent).
 */
export function annualizeGrants(totalValue: unknown, yearsActive: unknown): GrantsAggregate {
  const total = toNum(totalValue) ?? 0;
  const yearsRaw = toNum(yearsActive);
  const years = yearsRaw && yearsRaw > 0 ? yearsRaw : 1;
  return {
    totalValue: total,
    yearsActive: years,
    annualized: total / years,
  };
}

/** Cap a percentage at 100 (per CLAUDE.md Rule 7). Null-safe. */
export function capPct(pct: number | null): number | null {
  if (pct === null) return null;
  if (!Number.isFinite(pct)) return null;
  return Math.min(pct, 100);
}

/**
 * Compute the canonical compensation numerator from a T3010 financial row.
 * Line 4540 (total compensation) preferred, Line 5010 (mgmt/admin
 * expenditure) used as a fallback when 4540 is null — same rule as
 * mv_ghost_capacity.
 */
export function canonicalCompensation(fin: Pick<T3010FinancialRow, "compensation" | "mgmt_admin_exp">): number | null {
  const comp = toNum(fin.compensation);
  if (comp !== null) return comp;
  return toNum(fin.mgmt_admin_exp);
}

/**
 * Build the full canonical metric bundle for an entity. Call this in every
 * API route / page / MCP tool that displays these numbers.
 *
 *   grants: pre-aggregated from VERIFIED_GRANTS_SQL for the BN prefix.
 *           Pass null if no BN was resolved (grants metrics will be null).
 */
export function buildCanonicalCharityMetrics(
  fin: T3010FinancialRow,
  grants: GrantsAggregate | null,
): CanonicalCharityMetrics {
  const totalRevenue = toNum(fin.total_revenue);
  const totalExpenditure = toNum(fin.total_expenditure);
  const selfReportedGovRevenue = toNum(fin.gov_funding_federal);
  const compensationTotal = canonicalCompensation(fin);

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

/**
 * Short text block safe to paste into AI-prompt schemas describing T3010
 * financial columns and BN matching. Keeps the ask-route system prompt and
 * the MCP tool descriptions in sync on the canonical rules.
 */
export const T3010_METRIC_SCHEMA_NOTE = `
CRITICAL — T3010 financial field semantics (column names are MISLEADING):
  gov_funding_federal    = CRA Line 4120 — self-reported revenue from selling
                           goods/services to government (any level). This is
                           the ONLY column that reflects government revenue.
  gov_funding_provincial = CRA Line 4130 — INVESTMENT INCOME. NOT government
                           funding. Do NOT sum this with 4120.
  gov_funding_other      = CRA Line 4140 — OTHER REVENUE (unrealized gains,
                           non-receipted revenue). NOT government funding.
                           Do NOT sum this with 4120.
Never compute "total government funding" as 4120 + 4130 + 4140.

For verified federal disbursements (real agreements, not self-reported), use
the grants table cross-referenced by substr(recipient_business_number, 1, 9)
against substr(t3010.bn, 1, 9). Name-based ILIKE matching misses recipient
name variations and under-counts grants.

Annualize multi-year grants: SUM(agreement_value) /
  GREATEST(COUNT(DISTINCT EXTRACT(YEAR FROM agreement_start_date)), 1).

Cap any dependency percentage at 100%.

Compensation ratio = COALESCE(compensation, mgmt_admin_exp) / total_revenue
(revenue denominator — matches mv_ghost_capacity).
`.trim();
