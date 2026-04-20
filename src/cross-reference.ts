import { datastoreSearch } from "./datastore.js";
import { CONTRACTS_MAIN_RESOURCE_ID, GRANTS_RESOURCE_ID, T3010_IDENTIFICATION_RESOURCE_ID } from "./constants.js";
import { lookupCharity } from "./charity-lookup.js";
import { searchCharityDirectors } from "./director-search.js";
import { searchCharityTransfers } from "./charity-transfers.js";
import { normalizeWhitespace } from "./helpers.js";
import { annualizeGrants, bnPrefix as toBnPrefix } from "./metrics.js";

export interface CharityBNMatch {
  bn: string;
  legalName: string;
  city: string;
  province: string;
}

export async function findCharityBN(name: string): Promise<CharityBNMatch[]> {
  const result = await datastoreSearch({
    resourceId: T3010_IDENTIFICATION_RESOURCE_ID,
    query: name,
    limit: 10,
    fields: ["BN", "Legal Name", "City", "Province"],
  });

  return result.records.map((rec) => ({
    bn: norm(rec.BN),
    legalName: norm(rec["Legal Name"]),
    city: norm(rec.City),
    province: norm(rec.Province),
  }));
}

export function formatCharityBNSearchText(name: string, matches: CharityBNMatch[]): string {
  const lines: string[] = [];
  lines.push(`Charity BN Lookup: "${name}"`);
  lines.push("");

  if (matches.length === 0) {
    lines.push("No registered charities found matching this name. The organization may not be a registered charity (corporations, port authorities, and for-profit entities won't appear in T3010 data).");
    return lines.join("\n");
  }

  lines.push(`Found ${matches.length} match(es):`);
  lines.push("");
  lines.push("| BN | Legal Name | City | Province |");
  lines.push("| --- | --- | --- | --- |");
  for (const match of matches) {
    lines.push(`| ${match.bn} | ${match.legalName} | ${match.city} | ${match.province} |`);
  }

  lines.push("");
  lines.push("Use the BN with lookup_charity to get the full T3010 profile (financials, directors, compensation, programs).");

  return lines.join("\n");
}

export interface EntityDossier {
  entityName: string;
  businessNumber: string | null;
  grants: { total: number; topGrants: Array<{ value: number | null; department: string; program: string; date: string }> };
  contracts: { total: number; topContracts: Array<{ value: number | null; department: string; description: string; date: string; solicitation: string }> };
  charity: {
    found: boolean;
    legalName: string | null;
    category: string | null;
    /** Self-reported T3010 Line 4120 as % of revenue (capped at 100). */
    governmentFundingPct: number | null;
    /** Annualized verified federal grants as % of revenue (capped at 100). */
    verifiedGrantsPct: number | null;
    /** Annualized verified federal grants ($/yr). */
    verifiedGrantsAnnual: number | null;
    /** Compensation / revenue — revenue denominator (matches lib/metrics.ts). */
    compensationPct: number | null;
    directorCount: number;
  } | null;
  transfersGiven: { total: number };
  transfersReceived: { total: number };
  warnings: string[];
}

export async function crossReferenceEntity(options: {
  entityName?: string | undefined;
  businessNumber?: string | undefined;
}): Promise<EntityDossier> {
  if (!options.entityName && !options.businessNumber) {
    throw new Error("Provide either entityName or businessNumber.");
  }

  const warnings: string[] = [];
  let bn = options.businessNumber ?? null;
  const name = options.entityName ?? "";

  // Auto-resolve name to BN via T3010 if no BN provided
  if (!bn && name) {
    const bnMatches = await findCharityBN(name);
    if (bnMatches.length === 1) {
      bn = bnMatches[0]!.bn;
      warnings.push(`Auto-resolved "${name}" to BN ${bn} (${bnMatches[0]!.legalName}).`);
    } else if (bnMatches.length > 1) {
      bn = bnMatches[0]!.bn;
      warnings.push(`Found ${bnMatches.length} T3010 matches for "${name}". Using first match: BN ${bn} (${bnMatches[0]!.legalName}). Other matches: ${bnMatches.slice(1).map((m) => m.bn + " " + m.legalName).join("; ")}`);
    }
  }

  // Parallel searches across all data sources
  const [grantsResult, contractsResult] = await Promise.all([
    name
      ? datastoreSearch({ resourceId: GRANTS_RESOURCE_ID, filters: { recipient_legal_name: name }, limit: 20, fields: ["agreement_value", "owner_org_title", "prog_name_en", "agreement_start_date", "recipient_business_number"] })
      : bn
        ? datastoreSearch({ resourceId: GRANTS_RESOURCE_ID, filters: { recipient_business_number: bn }, limit: 20, fields: ["agreement_value", "owner_org_title", "prog_name_en", "agreement_start_date", "recipient_legal_name"] })
        : null,
    name
      ? datastoreSearch({ resourceId: CONTRACTS_MAIN_RESOURCE_ID, filters: { vendor_name: name }, limit: 20, fields: ["contract_value", "original_value", "owner_org_title", "description_en", "contract_date", "solicitation_procedure"] })
      : null,
  ]);

  const topGrants = (grantsResult?.records ?? []).map((r) => ({
    value: parseNum(r.agreement_value),
    department: norm(r.owner_org_title).split("|")[0]?.trim() ?? "",
    program: norm(r.prog_name_en),
    date: norm(r.agreement_start_date).slice(0, 10),
  })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const topContracts = (contractsResult?.records ?? []).map((r) => ({
    value: parseNum(r.contract_value) ?? parseNum(r.original_value),
    department: norm(r.owner_org_title).split("|")[0]?.trim() ?? "",
    description: norm(r.description_en),
    date: norm(r.contract_date).slice(0, 10),
    solicitation: norm(r.solicitation_procedure),
  })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  // Charity lookup if BN provided.
  // Canonical metrics (src/metrics.ts): we pass a GrantsAggregate computed
  // from the grants we already pulled. For MCP the CKAN grants window is
  // limited to the fetched slice (name-based match), but the annualization
  // formula is identical to lib/metrics.ts / mv_zombie_recipients.
  let charity: EntityDossier["charity"] = null;
  if (bn) {
    try {
      const bnPrefix9 = toBnPrefix(bn);
      const grantRecordsForAgg = (grantsResult?.records ?? []).filter((r) => {
        if (!bnPrefix9) return true;
        const rbn = typeof r.recipient_business_number === "string" ? r.recipient_business_number : "";
        return rbn.length >= 9 ? rbn.substring(0, 9) === bnPrefix9 : true;
      });
      const grantsAgg = annualizeGrants(grantRecordsForAgg);
      const profile = await lookupCharity(bn, { grants: grantsAgg });
      charity = {
        found: true,
        legalName: profile.legalName,
        category: profile.category,
        governmentFundingPct: profile.financials?.governmentFundingPct ?? null,
        verifiedGrantsPct: profile.financials?.verifiedGrantsPct ?? null,
        verifiedGrantsAnnual: profile.financials?.verifiedGrantsAnnual ?? null,
        compensationPct: profile.financials?.compensationPct ?? null,
        directorCount: profile.directors.length,
      };
    } catch {
      warnings.push("No T3010 charity record found for this business number.");
    }
  }

  // Transfer lookups if BN provided
  let transfersGiven = { total: 0 };
  let transfersReceived = { total: 0 };
  if (bn) {
    try {
      const [given, received] = await Promise.all([
        searchCharityTransfers({ donorBN: bn, limit: 1 }),
        searchCharityTransfers({ doneeBN: bn, limit: 1 }),
      ]);
      transfersGiven = { total: given.total };
      transfersReceived = { total: received.total };
    } catch {
      warnings.push("Could not check charity transfer records.");
    }
  }

  return {
    entityName: name || charity?.legalName || bn || "Unknown",
    businessNumber: bn,
    grants: { total: grantsResult?.total ?? 0, topGrants: topGrants.slice(0, 10) },
    contracts: { total: contractsResult?.total ?? 0, topContracts: topContracts.slice(0, 10) },
    charity,
    transfersGiven,
    transfersReceived,
    warnings,
  };
}

export function formatEntityDossierText(dossier: EntityDossier): string {
  const lines: string[] = [];
  lines.push(`Entity Dossier: ${dossier.entityName}`);
  if (dossier.businessNumber) lines.push(`Business Number: ${dossier.businessNumber}`);
  lines.push("");

  // Grants
  lines.push(`## Federal Grants & Contributions: ${fmt(dossier.grants.total)} records`);
  if (dossier.grants.topGrants.length > 0) {
    lines.push("| Value | Department | Program | Date |");
    lines.push("| --- | --- | --- | --- |");
    for (const g of dossier.grants.topGrants) {
      lines.push(`| ${fmtDollars(g.value)} | ${trunc(g.department, 25)} | ${trunc(g.program, 25)} | ${g.date} |`);
    }
  }

  lines.push("");

  // Contracts
  lines.push(`## Federal Contracts: ${fmt(dossier.contracts.total)} records`);
  if (dossier.contracts.topContracts.length > 0) {
    lines.push("| Value | Department | Description | Date | Solicitation |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const c of dossier.contracts.topContracts) {
      lines.push(`| ${fmtDollars(c.value)} | ${trunc(c.department, 25)} | ${trunc(c.description, 30)} | ${c.date} | ${c.solicitation === "TN" ? "Sole-source" : c.solicitation} |`);
    }
  }

  // Charity profile
  if (dossier.charity?.found) {
    lines.push("");
    lines.push("## Registered Charity");
    lines.push(`Category: ${dossier.charity.category} | Directors: ${dossier.charity.directorCount}`);
    if (dossier.charity.verifiedGrantsAnnual !== null) {
      lines.push(`Verified federal grants (annualized): ${fmtDollars(dossier.charity.verifiedGrantsAnnual)}${dossier.charity.verifiedGrantsPct !== null ? ` — ${dossier.charity.verifiedGrantsPct.toFixed(1)}% of revenue` : ""}`);
    }
    if (dossier.charity.governmentFundingPct !== null) {
      lines.push(`Self-reported T3010 gov revenue (Line 4120): ${dossier.charity.governmentFundingPct.toFixed(1)}% of revenue`);
    }
    if (dossier.charity.compensationPct !== null) {
      lines.push(`Compensation: ${dossier.charity.compensationPct.toFixed(1)}% of revenue`);
    }
    const dependencyPct = dossier.charity.verifiedGrantsPct ?? dossier.charity.governmentFundingPct;
    if (dependencyPct !== null && dependencyPct > 70) {
      lines.push("⚠️ HIGH DEPENDENCY on government funding");
    }
  }

  // Transfers
  if (dossier.transfersGiven.total > 0 || dossier.transfersReceived.total > 0) {
    lines.push("");
    lines.push("## Charity-to-Charity Transfers");
    lines.push(`Gifts given to other charities: ${fmt(dossier.transfersGiven.total)} records`);
    lines.push(`Gifts received from other charities: ${fmt(dossier.transfersReceived.total)} records`);
  }

  if (dossier.warnings.length > 0) {
    lines.push("");
    lines.push("Caveats:");
    for (const w of dossier.warnings) lines.push(`- ${w}`);
  }

  return lines.join("\n");
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
  const v = value.replace(/[\\|]/g, "\\$&");
  return v.length <= max ? v : v.substring(0, max - 1) + "…";
}

function fmtDollars(value: number | null): string {
  if (value === null) return "—";
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}`;
}

function fmt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
