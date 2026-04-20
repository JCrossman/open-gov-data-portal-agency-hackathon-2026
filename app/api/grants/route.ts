import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const recipient = params.get("recipient") ?? undefined;
  const department = params.get("department") ?? undefined;
  const recipientType = params.get("recipientType") ?? undefined;
  const province = params.get("province") ?? undefined;
  const sortBy = (params.get("sortBy") ?? "value") as "value" | "date";
  const limit = Math.min(parseInt(params.get("limit") ?? "20"), 100);

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (recipient) { conditions.push(`recipient_legal_name ILIKE $${paramIdx++}`); values.push(`%${recipient}%`); }
  if (department) { conditions.push(`owner_org_title ILIKE $${paramIdx++}`); values.push(`%${department}%`); }
  if (recipientType) { conditions.push(`recipient_type = $${paramIdx++}`); values.push(recipientType); }
  if (province) { conditions.push(`recipient_province = $${paramIdx++}`); values.push(province); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = sortBy === "date" ? "ORDER BY agreement_start_date DESC NULLS LAST" : "ORDER BY agreement_value DESC NULLS LAST";

  let total: number;
  if (conditions.length === 0) {
    const est = await query<{ n: number }>(`SELECT reltuples::int AS n FROM pg_class WHERE relname = 'grants'`);
    total = est[0]?.n ?? 0;
  } else {
    const totalRow = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM grants ${where}`, values);
    total = totalRow[0]?.n ?? 0;
  }

  const rows = await query(
    `SELECT recipient_legal_name, recipient_business_number, agreement_value,
            agreement_type, owner_org_title, prog_name_en,
            recipient_province, recipient_city, agreement_start_date
     FROM grants ${where} ${orderBy} LIMIT $${paramIdx}`,
    [...values, limit],
  );

  const grants = rows.map((r) => ({
    recipient: String(r.recipient_legal_name ?? ""),
    operatingName: "",
    businessNumber: String(r.recipient_business_number ?? ""),
    value: r.agreement_value != null ? Number(r.agreement_value) : null,
    agreementType: String(r.agreement_type ?? ""),
    department: String(r.owner_org_title ?? "").split("|")[0]?.trim() ?? "",
    program: String(r.prog_name_en ?? ""),
    province: String(r.recipient_province ?? ""),
    city: String(r.recipient_city ?? ""),
    startDate: r.agreement_start_date ? String(r.agreement_start_date).substring(0, 10) : "",
    endDate: "",
    description: "",
  }));

  return NextResponse.json({ total, showing: grants.length, sortedBy: sortBy, grants });
}
