import { normalizeWhitespace } from "./helpers.js";
import type { DatastoreSearchResult } from "./datastore.js";

export interface FormattedContract {
  vendor: string;
  effectiveValue: number | null;
  contractValue: number | null;
  originalValue: number | null;
  amendmentValue: number | null;
  amendmentRatio: number | null;
  department: string;
  date: string;
  description: string;
  solicitation: string;
  commodityType: string;
  instrumentType: string;
}

export function formatContractsSearchText(
  result: DatastoreSearchResult,
  contracts: FormattedContract[],
  options?: {
    query?: string | undefined;
    sortedBy?: string | undefined;
  },
): string {
  const lines: string[] = [];
  lines.push("Government of Canada Contracts");
  lines.push("");

  if (options?.query) {
    lines.push(`Search: "${options.query}"`);
  }

  lines.push(`Total matching records: ${formatCount(result.total)} | Showing: ${formatCount(contracts.length)}`);

  if (options?.sortedBy) {
    lines.push(`Sorted by: ${options.sortedBy}`);
  }

  if (contracts.length === 0) {
    lines.push("");
    lines.push("No contracts matched the search criteria.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("| Vendor | Effective Value | Original | Amendment | Ratio | Department | Date | Solicitation |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const contract of contracts) {
    lines.push(
      `| ${truncate(contract.vendor, 30)} | ${formatDollars(contract.effectiveValue)} | ${formatDollars(contract.originalValue)} | ${formatDollars(contract.amendmentValue)} | ${formatRatio(contract.amendmentRatio)} | ${truncate(contract.department, 25)} | ${contract.date || ""} | ${describeSolicitation(contract.solicitation)} |`,
    );
  }

  const withAmendments = contracts.filter((c) => c.amendmentValue !== null && c.amendmentValue > 0);
  const soleSourced = contracts.filter((c) => c.solicitation === "TN");

  lines.push("");
  lines.push("Summary:");
  if (contracts.some((c) => c.effectiveValue !== null)) {
    const values = contracts.map((c) => c.effectiveValue).filter((v): v is number => v !== null);
    lines.push(`- Value range: ${formatDollars(Math.min(...values))} to ${formatDollars(Math.max(...values))}`);
    lines.push(`- Total value shown: ${formatDollars(values.reduce((a, b) => a + b, 0))}`);
  }
  lines.push(`- Sole-source (TN): ${formatCount(soleSourced.length)} of ${formatCount(contracts.length)} shown`);
  lines.push(`- With amendments: ${formatCount(withAmendments.length)} of ${formatCount(contracts.length)} shown`);

  if (withAmendments.length > 0) {
    const ratios = withAmendments.map((c) => c.amendmentRatio).filter((r): r is number => r !== null);
    if (ratios.length > 0) {
      const maxRatio = Math.max(...ratios);
      lines.push(`- Highest amendment ratio: ${formatRatio(maxRatio)}`);
    }
  }

  // Detect duplicate quarterly snapshots (same vendor + same original_value appearing multiple times)
  const snapshotGroups = detectQuarterlySnapshots(contracts);
  if (snapshotGroups.length > 0) {
    lines.push("");
    lines.push("⚠️ QUARTERLY SNAPSHOT WARNING:");
    lines.push("The following vendors have multiple rows that appear to be the same contract reported at different quarterly amendment stages (same original_value, growing contract_value). Do NOT sum these — only the highest contract_value represents the current total.");
    for (const group of snapshotGroups) {
      lines.push(`  ${group.vendor}: ${formatCount(group.count)} snapshots (original: ${formatDollars(group.originalValue)}, range: ${formatDollars(group.minValue)} → ${formatDollars(group.maxValue)})`);
    }
  }

  lines.push("");
  lines.push("Column guide:");
  lines.push("- Effective Value = contract_value if present, otherwise original_value + amendment_value");
  lines.push("- Original = the initial contract value before amendments");
  lines.push("- Amendment = additional value added through amendments");
  lines.push("- Ratio = amendment_value / original_value (flags amendment creep)");
  lines.push("- Solicitation: TN = sole-source, TC = competitive, TO = advance notice");

  if (result.total > contracts.length) {
    lines.push("");
    lines.push(`${formatCount(result.total - contracts.length)} more records available. Use limit/offset or add filters to narrow results.`);
  }

  return lines.join("\n");
}

export function parseContracts(records: Array<Record<string, unknown>>): FormattedContract[] {
  return records.map((record) => {
    const contractValue = parseNumeric(record.contract_value);
    const originalValue = parseNumeric(record.original_value);
    const amendmentValue = parseNumeric(record.amendment_value);

    const effectiveValue = contractValue ?? (
      originalValue !== null && amendmentValue !== null
        ? originalValue + amendmentValue
        : originalValue ?? amendmentValue
    );

    const amendmentRatio = originalValue !== null && originalValue > 0 && amendmentValue !== null
      ? amendmentValue / originalValue
      : null;

    return {
      vendor: normalizeWhitespace(String(record.vendor_name ?? "")),
      effectiveValue,
      contractValue,
      originalValue,
      amendmentValue,
      amendmentRatio,
      department: normalizeWhitespace(String(record.owner_org_title ?? "")),
      date: normalizeWhitespace(String(record.contract_date ?? "")).slice(0, 10),
      description: normalizeWhitespace(String(record.description_en ?? "")),
      solicitation: normalizeWhitespace(String(record.solicitation_procedure ?? "")),
      commodityType: normalizeWhitespace(String(record.commodity_type ?? "")),
      instrumentType: normalizeWhitespace(String(record.instrument_type ?? "")),
    };
  });
}

export function sortContractsByValue(contracts: FormattedContract[], direction: "asc" | "desc" = "desc"): FormattedContract[] {
  return [...contracts].sort((a, b) => {
    const aVal = a.effectiveValue ?? -1;
    const bVal = b.effectiveValue ?? -1;
    return direction === "desc" ? bVal - aVal : aVal - bVal;
  });
}

export function sortContractsByAmendmentRatio(contracts: FormattedContract[], direction: "asc" | "desc" = "desc"): FormattedContract[] {
  return [...contracts].sort((a, b) => {
    const aVal = a.amendmentRatio ?? -1;
    const bVal = b.amendmentRatio ?? -1;
    return direction === "desc" ? bVal - aVal : aVal - bVal;
  });
}

function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const cleaned = String(value).replace(/[$,\s]/g, "").trim();
  if (!cleaned) {
    return null;
  }

  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDollars(value: number | null): string {
  if (value === null) {
    return "—";
  }

  return `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value)}`;
}

function formatRatio(value: number | null): string {
  if (value === null) {
    return "—";
  }

  return `${value.toFixed(2)}×`;
}

function describeSolicitation(code: string): string {
  const labels: Record<string, string> = {
    TN: "Sole-source",
    TC: "Competitive",
    TO: "Advance notice",
  };

  return labels[code] ?? code;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value.replace(/\|/g, "\\|");
  }

  return (value.substring(0, max - 1) + "…").replace(/\|/g, "\\|");
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

interface SnapshotGroup {
  vendor: string;
  originalValue: number;
  count: number;
  minValue: number;
  maxValue: number;
}

function detectQuarterlySnapshots(contracts: FormattedContract[]): SnapshotGroup[] {
  // Group by vendor + originalValue — if the same vendor has 3+ rows with identical
  // originalValue but different effectiveValue, these are likely quarterly amendment snapshots
  const groups = new Map<string, { values: number[]; vendor: string; originalValue: number }>();

  for (const c of contracts) {
    if (c.originalValue === null || c.effectiveValue === null) continue;
    const key = `${c.vendor}|${c.originalValue}`;
    if (!groups.has(key)) {
      groups.set(key, { values: [], vendor: c.vendor, originalValue: c.originalValue });
    }
    groups.get(key)!.values.push(c.effectiveValue);
  }

  return Array.from(groups.values())
    .filter((g) => g.values.length >= 3)
    .map((g) => ({
      vendor: g.vendor,
      originalValue: g.originalValue,
      count: g.values.length,
      minValue: Math.min(...g.values),
      maxValue: Math.max(...g.values),
    }))
    .sort((a, b) => b.maxValue - a.maxValue);
}
