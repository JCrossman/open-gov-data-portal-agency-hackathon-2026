import { datastoreSearch } from "./datastore.js";
import {
  T3010_COMPENSATION_RESOURCE_ID,
  T3010_DIRECTORS_RESOURCE_ID,
  T3010_FINANCIAL_RESOURCE_ID,
  T3010_IDENTIFICATION_RESOURCE_ID,
  T3010_PROGRAMS_RESOURCE_ID,
} from "./constants.js";
import { normalizeWhitespace } from "./helpers.js";
import {
  buildCanonicalCharityMetrics,
  parseNum as canonicalParseNum,
  type CanonicalCharityMetrics,
  type GrantsAggregate,
} from "./metrics.js";

export interface CharityProfile {
  bn: string;
  legalName: string;
  accountName: string;
  category: string;
  subCategory: string;
  designation: string;
  address: string;
  city: string;
  province: string;
  postalCode: string;
  financials: CharityFinancials | null;
  directors: CharityDirector[];
  compensation: CharityCompensation | null;
  programs: CharityProgram[];
  warnings: string[];
}

export interface CharityFinancials {
  totalRevenue: number | null;
  totalExpenditure: number | null;
  /** CRA Line 4120 — self-reported government revenue (any level). */
  governmentFunding: number | null;
  /** 4120 / total_revenue, capped at 100. */
  governmentFundingPct: number | null;
  /** Non-gov revenue (4130 investment income + 4140 other revenue). */
  otherRevenue: number | null;
  /** Annualized verified federal grants (lib/metrics.ts Metric 1). */
  verifiedGrantsAnnual: number | null;
  /** verified annualized / total_revenue, capped at 100. */
  verifiedGrantsPct: number | null;
  yearsActive: number;
  compensationTotal: number | null;
  /** compensation / total_revenue (revenue denominator — see metrics.ts). */
  compensationPct: number | null;
  fieldMap: Record<string, number | null>;
}

export interface CharityDirector {
  lastName: string;
  firstName: string;
  position: string;
  atArmsLength: string;
  startDate: string;
}

export interface CharityCompensation {
  fullTimeEmployees: number | null;
  partTimeEmployees: number | null;
  ranges: Array<{ range: string; count: number | null }>;
}

export interface CharityProgram {
  type: string;
  description: string;
}

export async function lookupCharity(
  bn: string,
  options?: { grants?: GrantsAggregate | null },
): Promise<CharityProfile> {
  const warnings: string[] = [];

  const [idResult, finResult, dirResult, compResult, progResult] = await Promise.all([
    datastoreSearch({ resourceId: T3010_IDENTIFICATION_RESOURCE_ID, filters: { BN: bn }, limit: 1 }),
    datastoreSearch({ resourceId: T3010_FINANCIAL_RESOURCE_ID, filters: { BN: bn }, limit: 1 }),
    datastoreSearch({ resourceId: T3010_DIRECTORS_RESOURCE_ID, filters: { BN: bn }, limit: 50 }),
    datastoreSearch({ resourceId: T3010_COMPENSATION_RESOURCE_ID, filters: { BN: bn }, limit: 1 }),
    datastoreSearch({ resourceId: T3010_PROGRAMS_RESOURCE_ID, filters: { BN: bn }, limit: 20 }),
  ]);

  const id = idResult.records[0];
  if (!id) {
    throw new Error(`No charity found with business number ${bn}. Ensure this is a registered charity BN.`);
  }

  const financials = finResult.records[0]
    ? parseFinancials(finResult.records[0], options?.grants ?? null)
    : null;
  if (!financials) {
    warnings.push("No T3010 financial data found for this charity.");
  }

  const directors = dirResult.records.map(parseDirector);
  const compensation = compResult.records[0] ? parseCompensation(compResult.records[0]) : null;
  const programs = progResult.records.map(parseProgram);

  return {
    bn,
    legalName: norm(id["Legal Name"]),
    accountName: norm(id["Account Name"]),
    category: norm(id.Category),
    subCategory: norm(id["Sub Category"]),
    designation: norm(id.Designation),
    address: [norm(id["Address Line 1"]), norm(id["Address Line 2"])].filter(Boolean).join(", "),
    city: norm(id.City),
    province: norm(id.Province),
    postalCode: norm(id["Postal Code"]),
    financials,
    directors,
    compensation,
    programs,
    warnings,
  };
}

export function formatCharityProfileText(profile: CharityProfile): string {
  const lines: string[] = [];
  lines.push(`Charity Profile: ${profile.legalName}`);
  lines.push("");
  lines.push(`BN: ${profile.bn} | Category: ${profile.category} | Designation: ${profile.designation}`);
  lines.push(`Location: ${profile.city}, ${profile.province} ${profile.postalCode}`);
  if (profile.address) lines.push(`Address: ${profile.address}`);

  if (profile.financials) {
    const f = profile.financials;
    lines.push("");
    lines.push("Financial Summary:");
    lines.push(`- Total revenue: ${fmtDollars(f.totalRevenue)}`);
    lines.push(`- Total expenditure: ${fmtDollars(f.totalExpenditure)}`);
    lines.push(`- Government funding (Line 4120, self-reported): ${fmtDollars(f.governmentFunding)}${f.governmentFundingPct !== null ? ` (${f.governmentFundingPct.toFixed(1)}% of revenue)` : ""}`);
    if (f.verifiedGrantsAnnual !== null) {
      lines.push(`- Verified federal grants (annualized, BN-matched): ${fmtDollars(f.verifiedGrantsAnnual)}${f.verifiedGrantsPct !== null ? ` (${f.verifiedGrantsPct.toFixed(1)}% of revenue)` : ""}${f.yearsActive > 1 ? ` — averaged over ${f.yearsActive} years` : ""}`);
    }
    if (f.otherRevenue !== null) {
      lines.push(`- Other revenue (investments Line 4130 + other Line 4140, NOT government): ${fmtDollars(f.otherRevenue)}`);
    }
    lines.push(`- Compensation: ${fmtDollars(f.compensationTotal)}${f.compensationPct !== null ? ` (${f.compensationPct.toFixed(1)}% of revenue)` : ""}`);

    if (f.governmentFundingPct !== null && f.governmentFundingPct > 70) {
      lines.push(`⚠️ HIGH DEPENDENCY: Self-reported gov revenue is ${f.governmentFundingPct.toFixed(0)}% of revenue (Line 4120)`);
    }
    if (f.compensationPct !== null && f.compensationPct > 70) {
      lines.push(`⚠️ HIGH COMPENSATION: ${f.compensationPct.toFixed(0)}% of revenue goes to compensation`);
    }
  }

  if (profile.compensation) {
    const c = profile.compensation;
    lines.push("");
    lines.push("Compensation Breakdown:");
    const ftNote = c.fullTimeEmployees !== null && c.fullTimeEmployees > 500_000 ? " ⚠️ SUSPECT DATA — likely data entry error" : "";
    const ptNote = c.partTimeEmployees !== null && c.partTimeEmployees > 500_000 ? " ⚠️ SUSPECT DATA — likely data entry error" : "";
    lines.push(`- Full-time employees: ${c.fullTimeEmployees ?? "unknown"}${ftNote}`);
    lines.push(`- Part-time employees: ${c.partTimeEmployees ?? "unknown"}${ptNote}`);
    for (const range of c.ranges.filter((r) => r.count !== null && r.count > 0)) {
      lines.push(`- ${range.range}: ${range.count}`);
    }
  }

  if (profile.directors.length > 0) {
    lines.push("");
    lines.push(`Directors/Officers (${profile.directors.length}):`);
    for (const dir of profile.directors.slice(0, 15)) {
      lines.push(`- ${dir.firstName} ${dir.lastName} — ${dir.position}${dir.atArmsLength === "N" ? " (not at arm's length)" : ""}`);
    }
    if (profile.directors.length > 15) {
      lines.push(`- ...and ${profile.directors.length - 15} more`);
    }
  }

  if (profile.programs.length > 0) {
    lines.push("");
    lines.push("Programs:");
    for (const prog of profile.programs.slice(0, 5)) {
      lines.push(`- ${prog.type}: ${trunc(prog.description, 120)}`);
    }
  }

  if (profile.warnings.length > 0) {
    lines.push("");
    lines.push("Caveats:");
    for (const w of profile.warnings) lines.push(`- ${w}`);
  }

  return lines.join("\n");
}

function parseFinancials(
  record: Record<string, unknown>,
  grants: GrantsAggregate | null,
): CharityFinancials {
  // Canonical metrics (src/metrics.ts). Mirrors lib/metrics.ts exactly so
  // MCP responses and the web-app API always agree.
  //
  // CRA T3010 field codes used here:
  //   4120 = revenue from government (self-reported) — Metric 2
  //   4130 = investment income / non-government transfers (NOT gov)
  //   4140 = other revenue (NOT gov)
  //   4200 = TOTAL REVENUE
  //   4540 = management/admin compensation — Metric 3 numerator (preferred)
  //   5010 = management/admin expenditure — Metric 3 fallback
  //   5100 = TOTAL EXPENDITURE
  const m: CanonicalCharityMetrics = buildCanonicalCharityMetrics(record, grants);

  // Non-government "other revenue" bucket: 4130 + 4140. Always presented
  // SEPARATELY from government funding — never summed into it.
  const otherRevenue = sumNullable(
    canonicalParseNum(record["4130"]),
    canonicalParseNum(record["4140"]),
  );

  const fieldMap: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (/^\d{4}$/.test(key)) fieldMap[key] = canonicalParseNum(value);
  }

  return {
    totalRevenue: m.totalRevenue,
    totalExpenditure: m.totalExpenditure,
    governmentFunding: m.selfReportedGovRevenue,
    governmentFundingPct: m.selfReportedGovRevenuePct,
    otherRevenue,
    verifiedGrantsAnnual: m.verifiedGrantsAnnual,
    verifiedGrantsPct: m.verifiedGrantsPct,
    yearsActive: m.yearsActive,
    compensationTotal: m.compensationTotal,
    compensationPct: m.compensationPct,
    fieldMap,
  };
}

function sumNullable(...values: Array<number | null>): number | null {
  const nonNull = values.filter((v): v is number => v !== null);
  return nonNull.length > 0 ? nonNull.reduce((a, b) => a + b, 0) : null;
}

function parseDirector(record: Record<string, unknown>): CharityDirector {
  return {
    lastName: norm(record["Last Name"]),
    firstName: norm(record["First Name"]),
    position: norm(record.Position),
    atArmsLength: norm(record["At Arm's Length"]),
    startDate: norm(record["Start Date"]),
  };
}

function parseCompensation(record: Record<string, unknown>): CharityCompensation {
  const num = (key: string) => parseNum(record[key]);
  const ranges = [
    { range: "$1–$39,999", count: num("300") },
    { range: "$40,000–$79,999", count: num("305") },
    { range: "$80,000–$119,999", count: num("310") },
    { range: "$120,000–$159,999", count: num("315") },
    { range: "$160,000–$199,999", count: num("320") },
    { range: "$200,000–$249,999", count: num("325") },
    { range: "$250,000–$299,999", count: num("330") },
    { range: "$300,000–$349,999", count: num("335") },
    { range: "$350,000+", count: num("340") },
  ];
  return {
    fullTimeEmployees: num("370"),
    partTimeEmployees: num("380"),
    ranges,
  };
}

function parseProgram(record: Record<string, unknown>): CharityProgram {
  return {
    type: norm(record["Program Type"]),
    description: norm(record.Description),
  };
}

function parseNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,\s]/g, "").trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function norm(value: unknown): string {
  return normalizeWhitespace(String(value ?? ""));
}

function trunc(value: string, max: number): string {
  return value.length <= max ? value : value.substring(0, max - 1) + "…";
}

function fmtDollars(value: number | null): string {
  if (value === null) return "—";
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}`;
}
