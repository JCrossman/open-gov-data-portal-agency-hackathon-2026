import { normalizeWhitespace } from "./helpers.js";
import type { DatastoreSearchResult } from "./datastore.js";

export interface FormattedGrant {
  recipient: string;
  operatingName: string;
  businessNumber: string;
  value: number | null;
  agreementType: string;
  department: string;
  program: string;
  province: string;
  city: string;
  startDate: string;
  endDate: string;
  description: string;
}

export function parseGrants(records: Array<Record<string, unknown>>): FormattedGrant[] {
  return records.map((record) => ({
    recipient: norm(record.recipient_legal_name),
    operatingName: norm(record.recipient_operating_name),
    businessNumber: norm(record.recipient_business_number),
    value: parseNumeric(record.agreement_value),
    agreementType: describeAgreementType(norm(record.agreement_type)),
    department: norm(record.owner_org_title).split("|")[0]?.trim() ?? "",
    program: norm(record.prog_name_en),
    province: norm(record.recipient_province),
    city: norm(record.recipient_city),
    startDate: norm(record.agreement_start_date).slice(0, 10),
    endDate: norm(record.agreement_end_date).slice(0, 10),
    description: norm(record.description_en),
  }));
}

export function sortGrantsByValue(grants: FormattedGrant[], direction: "asc" | "desc" = "desc"): FormattedGrant[] {
  return [...grants].sort((a, b) => {
    const aVal = a.value ?? -1;
    const bVal = b.value ?? -1;
    return direction === "desc" ? bVal - aVal : aVal - bVal;
  });
}

export function formatGrantsSearchText(
  result: DatastoreSearchResult,
  grants: FormattedGrant[],
  options?: { query?: string | undefined; sortedBy?: string | undefined },
): string {
  const lines: string[] = [];
  lines.push("Government of Canada Grants & Contributions");
  lines.push("");

  if (options?.query) {
    lines.push(`Search: "${options.query}"`);
  }

  lines.push(`Total matching records: ${fmt(result.total)} | Showing: ${fmt(grants.length)}`);
  if (options?.sortedBy) {
    lines.push(`Sorted by: ${options.sortedBy}`);
  }

  if (grants.length === 0) {
    lines.push("");
    lines.push("No grants matched the search criteria.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("| Recipient | BN | Value | Department | Program | Province | Start Date | Type |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const grant of grants) {
    lines.push(
      `| ${trunc(grant.recipient, 30)} | ${grant.businessNumber || "—"} | ${fmtDollars(grant.value)} | ${trunc(grant.department, 25)} | ${trunc(grant.program, 25)} | ${grant.province} | ${grant.startDate} | ${grant.agreementType} |`,
    );
  }

  const values = grants.map((g) => g.value).filter((v): v is number => v !== null);
  if (values.length > 0) {
    lines.push("");
    lines.push("Summary:");
    lines.push(`- Value range: ${fmtDollars(Math.min(...values))} to ${fmtDollars(Math.max(...values))}`);
    lines.push(`- Total value shown: ${fmtDollars(values.reduce((a, b) => a + b, 0))}`);
    const depts = new Set(grants.map((g) => g.department).filter(Boolean));
    lines.push(`- Departments: ${fmt(depts.size)}`);
    const programs = new Set(grants.map((g) => g.program).filter(Boolean));
    lines.push(`- Programs: ${fmt(programs.size)}`);
  }

  if (result.total > grants.length) {
    lines.push("");
    lines.push(`${fmt(result.total - grants.length)} more records available.`);
  }

  lines.push("");
  lines.push("Data limitation: This dataset covers proactive disclosure grants and contributions. Some large government expenditures (contribution agreements through arm's-length agencies like SDTC, advance purchase agreements, and transfers through foundations) may not appear in this dataset. Cross-reference with contracts data and open data catalog for a fuller picture.");

  return lines.join("\n");
}

function describeAgreementType(code: string): string {
  const labels: Record<string, string> = { G: "Grant", C: "Contribution", O: "Other" };
  return labels[code] ?? code;
}

function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function norm(value: unknown): string {
  return normalizeWhitespace(String(value ?? ""));
}

function trunc(value: string, max: number): string {
  const v = value.replace(/\|/g, "\\|");
  return v.length <= max ? v : v.substring(0, max - 1) + "…";
}

function fmtDollars(value: number | null): string {
  if (value === null) return "—";
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}`;
}

function fmt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
