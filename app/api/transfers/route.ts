import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const donorBN = params.get("donorBN") ?? null;
  const doneeBN = params.get("doneeBN") ?? null;
  const limit = Math.min(parseInt(params.get("limit") ?? "50"), 200);

  // Build conditions dynamically
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (donorBN) { conditions.push(`donor_bn = $${paramIdx++}`); values.push(donorBN); }
  if (doneeBN) { conditions.push(`donee_bn = $${paramIdx++}`); values.push(doneeBN); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get total count and transfer rows in parallel
  const [totalRows, transferRows] = await Promise.all([
    query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM t3010_transfers ${where}`, values),
    query<{
      donor_bn: string | null; donee_bn: string | null; donee_name: string | null;
      total_gifts: number | null; associated: string | null; city: string | null;
      province: string | null;
    }>(
      `SELECT donor_bn, donee_bn, donee_name, total_gifts, associated, city, province
       FROM t3010_transfers ${where}
       ORDER BY total_gifts DESC NULLS LAST LIMIT $${paramIdx}`,
      [...values, limit],
    ),
  ]);

  const transfers = transferRows.map((r) => ({
    donorBN: String(r.donor_bn ?? ""),
    doneeBN: String(r.donee_bn ?? ""),
    doneeName: String(r.donee_name ?? ""),
    totalGifts: r.total_gifts != null ? Number(r.total_gifts) : null,
    associated: String(r.associated ?? ""),
    city: String(r.city ?? ""),
    province: String(r.province ?? ""),
  }));

  // Detect reciprocal transfers
  const reciprocalFlags: Array<{ bnA: string; bnB: string; aToB: number | null; bToA: number | null }> = [];
  const checked = new Set<string>();

  for (const t of transfers) {
    if (!t.doneeBN || !t.donorBN) continue;
    const pairKey = [t.donorBN, t.doneeBN].sort().join("|");
    if (checked.has(pairKey)) continue;
    checked.add(pairKey);

    const reverseRows = await query<{ total_gifts: number | null }>(
      `SELECT total_gifts FROM t3010_transfers WHERE donor_bn = $1 AND donee_bn = $2 LIMIT 1`,
      [t.doneeBN, t.donorBN],
    );

    if (reverseRows.length > 0) {
      reciprocalFlags.push({
        bnA: t.donorBN,
        bnB: t.doneeBN,
        aToB: t.totalGifts,
        bToA: reverseRows[0]!.total_gifts != null ? Number(reverseRows[0]!.total_gifts) : null,
      });
    }
  }

  return NextResponse.json({
    transfers,
    total: totalRows[0]?.n ?? 0,
    reciprocalFlags,
  });
}
