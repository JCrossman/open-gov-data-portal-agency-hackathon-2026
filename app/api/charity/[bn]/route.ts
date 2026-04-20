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
  _request: NextRequest,
  { params }: { params: Promise<{ bn: string }> },
) {
  const { bn } = await params;

  try {
    const [idRows, finRows, dirRows, compRows, progRows, grantsAggRows] = await Promise.all([
      query<{
        legal_name: string | null; account_name: string | null; category: string | null;
        designation: string | null; address: string | null; city: string | null;
        province: string | null; postal_code: string | null;
      }>(`SELECT legal_name, account_name, category, designation, address, city, province, postal_code FROM t3010_id WHERE bn = $1 LIMIT 1`, [bn]),
      query<{
        total_revenue: number | null; total_expenditure: number | null;
        gov_funding_federal: number | null; gov_funding_provincial: number | null;
        gov_funding_other: number | null; compensation: number | null;
        mgmt_admin_exp: number | null; raw_fields: string | null;
      }>(`SELECT total_revenue, total_expenditure, gov_funding_federal, gov_funding_provincial, gov_funding_other, compensation, mgmt_admin_exp, raw_fields FROM t3010_financial WHERE bn = $1 LIMIT 1`, [bn]),
      query<{
        last_name: string | null; first_name: string | null; position: string | null;
        at_arms_length: string | null; start_date: string | null;
      }>(`SELECT last_name, first_name, position, at_arms_length, start_date FROM t3010_directors WHERE bn = $1 LIMIT 50`, [bn]),
      query<{
        ft_employees: number | null; pt_employees: number | null; raw_fields: string | null;
      }>(`SELECT ft_employees, pt_employees, raw_fields FROM t3010_compensation WHERE bn = $1 LIMIT 1`, [bn]),
      query<{
        program_type: string | null; description: string | null;
      }>(`SELECT program_type, description FROM t3010_programs WHERE bn = $1 LIMIT 20`, [bn]),
      // Canonical verified-grants aggregate (lib/metrics.ts). Matches entity API + zombie MV.
      (() => {
        const prefix = toBnPrefix(bn);
        return prefix
          ? query<{ n: number; total_value: number; years_active: number }>(VERIFIED_GRANTS_SQL, [prefix])
          : Promise.resolve([{ n: 0, total_value: 0, years_active: 1 }] as { n: number; total_value: number; years_active: number }[]);
      })(),
    ]);

    const id = idRows[0];
    if (!id) {
      return NextResponse.json(
        { error: `No charity found with business number ${bn}. Ensure this is a registered charity BN.` },
        { status: 404 },
      );
    }

    const warnings: string[] = [];

    // Financials — canonical helpers from lib/metrics.ts
    let financials: {
      totalRevenue: number | null; totalExpenditure: number | null;
      governmentFunding: number | null; governmentFundingPct: number | null;
      otherRevenue: number | null;
      verifiedGrantsAnnual: number | null; verifiedGrantsPct: number | null;
      yearsActive: number;
      compensationTotal: number | null; compensationPct: number | null;
      fieldMap: Record<string, number | null>;
    } | null = null;

    const fin = finRows[0];
    if (fin) {
      const grantsAgg = annualizeGrants(
        grantsAggRows[0]?.total_value ?? 0,
        grantsAggRows[0]?.years_active ?? 1,
      );
      const m = buildCanonicalCharityMetrics(fin as T3010FinancialRow, grantsAgg);

      // Non-government "other revenue" bucket: 4130 (investment income) + 4140
      // (other revenue). Shown as a separate row, NEVER summed into gov funding.
      const otherRevNonGov = sumNullable(
        fin.gov_funding_provincial != null ? Number(fin.gov_funding_provincial) : null,
        fin.gov_funding_other != null ? Number(fin.gov_funding_other) : null,
      );

      let fieldMap: Record<string, number | null> = {};
      if (fin.raw_fields) {
        try { fieldMap = JSON.parse(fin.raw_fields); } catch { /* ignore */ }
      }

      financials = {
        totalRevenue: m.totalRevenue,
        totalExpenditure: m.totalExpenditure,
        governmentFunding: m.selfReportedGovRevenue,
        governmentFundingPct: m.selfReportedGovRevenuePct,
        otherRevenue: otherRevNonGov,
        verifiedGrantsAnnual: m.verifiedGrantsAnnual,
        verifiedGrantsPct: m.verifiedGrantsPct,
        yearsActive: m.yearsActive,
        compensationTotal: m.compensationTotal,
        compensationPct: m.compensationPct,
        fieldMap,
      };
    } else {
      warnings.push("No T3010 financial data found for this charity.");
    }

    // Directors
    const directors = dirRows.map((d) => ({
      lastName: String(d.last_name ?? ""),
      firstName: String(d.first_name ?? ""),
      position: String(d.position ?? ""),
      atArmsLength: String(d.at_arms_length ?? ""),
      startDate: String(d.start_date ?? ""),
    }));

    // Compensation
    let compensation: {
      fullTimeEmployees: number | null; partTimeEmployees: number | null;
      ranges: Array<{ range: string; count: number | null }>;
    } | null = null;

    const comp = compRows[0];
    if (comp) {
      let rawFields: Record<string, unknown> = {};
      if (comp.raw_fields) {
        try { rawFields = JSON.parse(comp.raw_fields); } catch { /* ignore */ }
      }
      const num = (key: string): number | null => {
        const v = rawFields[key];
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      compensation = {
        fullTimeEmployees: comp.ft_employees != null ? Number(comp.ft_employees) : null,
        partTimeEmployees: comp.pt_employees != null ? Number(comp.pt_employees) : null,
        ranges: [
          { range: "$1–$39,999", count: num("300") },
          { range: "$40,000–$79,999", count: num("305") },
          { range: "$80,000–$119,999", count: num("310") },
          { range: "$120,000–$159,999", count: num("315") },
          { range: "$160,000–$199,999", count: num("320") },
          { range: "$200,000–$249,999", count: num("325") },
          { range: "$250,000–$299,999", count: num("330") },
          { range: "$300,000–$349,999", count: num("335") },
          { range: "$350,000+", count: num("340") },
        ],
      };
    }

    // Programs
    const programs = progRows.map((p) => ({
      type: String(p.program_type ?? ""),
      description: String(p.description ?? ""),
    }));

    // Determine sub-category from category if available
    const categoryParts = String(id.category ?? "").split(" - ");
    const category = categoryParts[0]?.trim() ?? String(id.category ?? "");
    const subCategory = categoryParts.length > 1 ? categoryParts.slice(1).join(" - ").trim() : "";

    const profile = {
      bn,
      legalName: String(id.legal_name ?? ""),
      accountName: String(id.account_name ?? ""),
      category,
      subCategory,
      designation: String(id.designation ?? ""),
      address: String(id.address ?? ""),
      city: String(id.city ?? ""),
      province: String(id.province ?? ""),
      postalCode: String(id.postal_code ?? ""),
      financials,
      directors,
      compensation,
      programs,
      warnings,
    };

    return NextResponse.json(profile);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Charity not found" },
      { status: 404 },
    );
  }
}

function sumNullable(...values: Array<number | null>): number | null {
  const nonNull = values.filter((v): v is number => v !== null);
  return nonNull.length > 0 ? nonNull.reduce((a, b) => a + b, 0) : null;
}
