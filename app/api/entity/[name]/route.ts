import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import {
  VERIFIED_GRANTS_SQL,
  annualizeGrants,
  bnPrefix as toBnPrefix,
  buildCanonicalCharityMetrics,
  type T3010FinancialRow,
} from "@/lib/metrics";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const entityName = decodeURIComponent(name);
  let bn: string | null = request.nextUrl.searchParams.get("bn") ?? null;

  const warnings: string[] = [];

  // Auto-resolve name → BN via T3010 if no BN provided
  if (!bn && entityName) {
    const bnMatches = await query<{ bn: string; legal_name: string }>(
      `SELECT bn, legal_name FROM t3010_id WHERE legal_name ILIKE $1 LIMIT 10`,
      [`%${entityName}%`],
    );
    if (bnMatches.length === 1) {
      bn = bnMatches[0]!.bn;
      warnings.push(`Auto-resolved "${entityName}" to BN ${bn} (${bnMatches[0]!.legal_name}).`);
    } else if (bnMatches.length > 1) {
      bn = bnMatches[0]!.bn;
      warnings.push(
        `Found ${bnMatches.length} T3010 matches for "${entityName}". Using first match: BN ${bn} (${bnMatches[0]!.legal_name}). Other matches: ${bnMatches.slice(1).map((m) => m.bn + " " + m.legal_name).join("; ")}`,
      );
    }
  }

  // BN prefix for cross-referencing grants by business number (9-digit prefix)
  const bnPrefix = toBnPrefix(bn);

  // Parallel searches across all data sources
  // Grants are searched by BOTH name AND BN prefix to avoid undercounting
  const [grantsTotal, grantsRows, grantsByBnTotal, grantsByBnRows, contractsTotal, contractsRows, charityRows, tGiven, tReceived] =
    await Promise.all([
      // Grants count by name
      query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM grants WHERE recipient_legal_name ILIKE $1`,
        [`%${entityName}%`],
      ),
      // Grants top 10 by name
      query<{ id: number; agreement_value: number | null; owner_org_title: string | null; prog_name_en: string | null; agreement_start_date: string | null }>(
        `SELECT id, agreement_value, owner_org_title, prog_name_en, agreement_start_date
         FROM grants WHERE recipient_legal_name ILIKE $1
         ORDER BY agreement_value DESC NULLS LAST LIMIT 10`,
        [`%${entityName}%`],
      ),
      // Verified grants aggregate (canonical: lib/metrics.ts VERIFIED_GRANTS_SQL)
      bnPrefix
        ? query<{ n: number; total_value: number; years_active: number }>(
            VERIFIED_GRANTS_SQL,
            [bnPrefix],
          )
        : Promise.resolve([{ n: 0, total_value: 0, years_active: 1 }] as { n: number; total_value: number; years_active: number }[]),
      // Grants top 10 by BN prefix
      bnPrefix
        ? query<{ id: number; agreement_value: number | null; owner_org_title: string | null; prog_name_en: string | null; agreement_start_date: string | null; recipient_legal_name: string | null }>(
            `SELECT id, agreement_value, owner_org_title, prog_name_en, agreement_start_date, recipient_legal_name
             FROM grants
             WHERE recipient_business_number IS NOT NULL
               AND substr(recipient_business_number, 1, 9) = $1
             ORDER BY agreement_value DESC NULLS LAST LIMIT 10`,
            [bnPrefix],
          )
        : Promise.resolve([]),
      // Contracts count
      query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM contracts WHERE vendor_name ILIKE $1`,
        [`%${entityName}%`],
      ),
      // Contracts top 10
      query<{ contract_value: number | null; original_value: number | null; owner_org_title: string | null; description_en: string | null; contract_date: string | null; solicitation_procedure: string | null }>(
        `SELECT contract_value, original_value, owner_org_title, description_en, contract_date, solicitation_procedure
         FROM contracts WHERE vendor_name ILIKE $1
         ORDER BY effective_value DESC NULLS LAST LIMIT 10`,
        [`%${entityName}%`],
      ),
      // Charity profile (financials + identity)
      bn
        ? query<{
            total_revenue: number | null; gov_funding_federal: number | null;
            gov_funding_provincial: number | null; gov_funding_other: number | null;
            total_expenditure: number | null; compensation: number | null;
            mgmt_admin_exp: number | null; legal_name: string | null;
            category: string | null; director_count: number;
          }>(
            `SELECT f.total_revenue, f.gov_funding_federal, f.gov_funding_provincial,
                    f.gov_funding_other, f.total_expenditure, f.compensation, f.mgmt_admin_exp,
                    i.legal_name, i.category,
                    (SELECT COUNT(*)::int FROM t3010_directors WHERE bn = $1) AS director_count
             FROM t3010_financial f
             JOIN t3010_id i ON f.bn = i.bn
             WHERE f.bn = $1`,
            [bn],
          )
        : Promise.resolve([]),
      // Transfers given
      bn
        ? query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM t3010_transfers WHERE donor_bn = $1`, [bn])
        : Promise.resolve([{ n: 0 }] as { n: number }[]),
      // Transfers received
      bn
        ? query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM t3010_transfers WHERE donee_bn = $1`, [bn])
        : Promise.resolve([{ n: 0 }] as { n: number }[]),
    ]);

  // Merge name-based and BN-based grant results (BN search catches name variations)
  const nameGrantCount = grantsTotal[0]?.n ?? 0;
  const bnGrantCount = grantsByBnTotal[0]?.n ?? 0;
  // Canonical annualization (lib/metrics.ts). Matches mv_zombie_recipients.
  const grantsAgg = annualizeGrants(
    grantsByBnTotal[0]?.total_value ?? 0,
    grantsByBnTotal[0]?.years_active ?? 1,
  );

  // Use the higher count (BN-based usually catches more due to name variations)
  const effectiveGrantCount = Math.max(nameGrantCount, bnGrantCount);

  // Merge top grants: deduplicate by id, prefer BN-based results if they found more
  const mergedGrantMap = new Map<number, typeof grantsRows[0]>();
  for (const r of grantsRows) mergedGrantMap.set(r.id, r);
  for (const r of grantsByBnRows) {
    if (!mergedGrantMap.has(r.id)) mergedGrantMap.set(r.id, r);
  }
  const mergedGrantRows = Array.from(mergedGrantMap.values())
    .sort((a, b) => (Number(b.agreement_value) || 0) - (Number(a.agreement_value) || 0))
    .slice(0, 10);

  if (bnGrantCount > nameGrantCount && bnPrefix) {
    warnings.push(
      `Name search found ${nameGrantCount} grants, but BN prefix (${bnPrefix}) matched ${bnGrantCount} grants. ` +
      `This entity may receive grants under different name variations. Showing BN-matched total.`
    );
  }

  // Format grants (from merged name + BN results)
  const topGrants = mergedGrantRows
    .map((r) => ({
      value: r.agreement_value != null ? Number(r.agreement_value) : null,
      department: String(r.owner_org_title ?? "").split("|")[0]?.trim() ?? "",
      program: String(r.prog_name_en ?? ""),
      date: fmtDate(r.agreement_start_date),
    }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  // Format contracts
  const topContracts = contractsRows
    .map((r) => ({
      value: r.contract_value != null ? Number(r.contract_value) : (r.original_value != null ? Number(r.original_value) : null),
      department: String(r.owner_org_title ?? "").split("|")[0]?.trim() ?? "",
      description: String(r.description_en ?? ""),
      date: fmtDate(r.contract_date),
      solicitation: String(r.solicitation_procedure ?? ""),
    }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  // Build charity section
  let charity: {
    found: boolean;
    legalName: string | null;
    category: string | null;
    selfReportedGovRevenuePct: number | null;
    verifiedGrantsAnnual: number | null;
    verifiedGrantsPct: number | null;
    yearsActive: number;
    compensationPct: number | null;
    directorCount: number;
  } | null = null;

  if (bn && charityRows.length > 0) {
    const c = charityRows[0]!;
    const m = buildCanonicalCharityMetrics(c as T3010FinancialRow, grantsAgg);
    charity = {
      found: true,
      legalName: c.legal_name ?? null,
      category: c.category ?? null,
      selfReportedGovRevenuePct: m.selfReportedGovRevenuePct,
      verifiedGrantsAnnual: m.verifiedGrantsAnnual,
      verifiedGrantsPct: m.verifiedGrantsPct,
      yearsActive: m.yearsActive,
      compensationPct: m.compensationPct,
      directorCount: Number(c.director_count),
    };
  } else if (bn) {
    warnings.push("No T3010 charity record found for this business number.");
  }

  const dossier = {
    entityName: entityName || charity?.legalName || bn || "Unknown",
    businessNumber: bn,
    grants: { total: effectiveGrantCount, topGrants: topGrants.slice(0, 10) },
    contracts: { total: contractsTotal[0]?.n ?? 0, topContracts: topContracts.slice(0, 10) },
    charity,
    transfersGiven: { total: tGiven[0]?.n ?? 0 },
    transfersReceived: { total: tReceived[0]?.n ?? 0 },
    warnings,
  };

  return NextResponse.json(dossier);
}

function fmtDate(v: unknown): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().substring(0, 10);
  const s = String(v);
  // Already ISO-like
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  // Try parsing
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.substring(0, 10) : d.toISOString().substring(0, 10);
}
