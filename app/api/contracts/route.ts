import { NextRequest, NextResponse } from "next/server";
import { query, count } from "@/lib/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const vendor = params.get("vendor") ?? undefined;
  const department = params.get("department") ?? undefined;
  const solicitationProcedure = params.get("solicitation") ?? undefined;
  const commodityType = params.get("commodity") ?? undefined;
  const sortBy = (params.get("sortBy") ?? "value") as "value" | "amendment_ratio" | "date";
  const limit = Math.min(parseInt(params.get("limit") ?? "20"), 100);

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (vendor) { conditions.push(`vendor_name ILIKE $${paramIdx++}`); values.push(`%${vendor}%`); }
  if (department) { conditions.push(`owner_org_title ILIKE $${paramIdx++}`); values.push(`%${department}%`); }
  if (solicitationProcedure) { conditions.push(`solicitation_procedure = $${paramIdx++}`); values.push(solicitationProcedure); }
  if (commodityType) { conditions.push(`commodity_type = $${paramIdx++}`); values.push(commodityType); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let orderBy: string;
  if (sortBy === "amendment_ratio") {
    orderBy = "ORDER BY amendment_ratio DESC NULLS LAST";
  } else if (sortBy === "date") {
    orderBy = "ORDER BY contract_date DESC NULLS LAST";
  } else {
    orderBy = "ORDER BY effective_value DESC NULLS LAST";
  }

  // Use table estimate for unfiltered count (instant) or exact count for filtered (slower but accurate)
  let total: number;
  if (conditions.length === 0) {
    const est = await query<{ n: number }>(`SELECT reltuples::int AS n FROM pg_class WHERE relname = 'contracts'`);
    total = est[0]?.n ?? 0;
  } else {
    const totalRow = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM contracts ${where}`, values);
    total = totalRow[0]?.n ?? 0;
  }

  const rows = await query(
    `SELECT vendor_name, contract_value, original_value, amendment_value,
            solicitation_procedure, owner_org_title, contract_date,
            commodity_type, description_en, instrument_type,
            effective_value, amendment_ratio
     FROM contracts ${where} ${orderBy} LIMIT $${paramIdx}`,
    [...values, limit],
  );

  const contracts = rows.map((r) => ({
    vendor: r.vendor_name ?? "",
    effectiveValue: r.effective_value != null ? Number(r.effective_value) : null,
    contractValue: r.contract_value != null ? Number(r.contract_value) : null,
    originalValue: r.original_value != null ? Number(r.original_value) : null,
    amendmentValue: r.amendment_value != null ? Number(r.amendment_value) : null,
    amendmentRatio: r.amendment_ratio != null ? Number(r.amendment_ratio) : null,
    department: String(r.owner_org_title ?? ""),
    date: r.contract_date ? String(r.contract_date).substring(0, 10) : "",
    description: String(r.description_en ?? ""),
    solicitation: String(r.solicitation_procedure ?? ""),
    commodityType: String(r.commodity_type ?? ""),
    instrumentType: String(r.instrument_type ?? ""),
  }));

  return NextResponse.json({ total, showing: contracts.length, sortedBy: sortBy, contracts });
}
