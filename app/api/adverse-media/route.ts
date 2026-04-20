import { NextResponse } from "next/server";
import { querySafe } from "@/lib/db";
import {
  ADVERSE_MEDIA_SEVERITIES,
  isAdverseMediaSeverity,
  type AdverseMediaSeverity,
} from "@/lib/adverse-media";

export const revalidate = 3600;

interface MatchedRow {
  adverse_media_id: number;
  severity: AdverseMediaSeverity;
  source_id: string;
  source_url: string | null;
  published_at: string | null;
  entity_name_raw: string;
  summary: string | null;
  matched_source: string;
  matched_entity_name: string;
  matched_bn: string | null;
  match_method: string;
  confidence: string;
  grants_total: string | null;
  grants_count: string | null;
  contracts_total: string | null;
  contracts_count: string | null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sevParam = searchParams.get("severity");
  const methodParam = searchParams.get("method");
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 100), 1), 500);

  const severity = sevParam && isAdverseMediaSeverity(sevParam) ? sevParam : null;
  const method =
    methodParam && ["exact_bn", "exact_name", "vector_cosine"].includes(methodParam)
      ? methodParam
      : null;

  const severityCounts = await querySafe<{ severity: string; n: number }>(
    `SELECT severity, COUNT(*)::int AS n
     FROM adverse_media
     GROUP BY severity
     ORDER BY severity`,
  );

  const matchSummary = await querySafe<{
    match_method: string;
    total_matches: number;
    distinct_adverse: number;
  }>(
    `SELECT match_method,
            COUNT(*)::int AS total_matches,
            COUNT(DISTINCT adverse_media_id)::int AS distinct_adverse
     FROM adverse_media_matches
     GROUP BY match_method
     ORDER BY match_method`,
  );

  const params: unknown[] = [];
  const filters: string[] = [];
  if (severity) {
    params.push(severity);
    filters.push(`a.severity = $${params.length}`);
  }
  if (method) {
    params.push(method);
    filters.push(`m.match_method = $${params.length}`);
  }
  params.push(limit);
  const limitIdx = params.length;
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const matches = await querySafe<MatchedRow>(
    `
    WITH matched AS (
      SELECT a.id AS adverse_media_id,
             a.severity, a.source_id, a.source_url, a.published_at,
             a.entity_name_raw, a.summary,
             m.matched_source, m.matched_entity_name, m.matched_bn,
             m.match_method, m.confidence
      FROM adverse_media a
      JOIN adverse_media_matches m ON m.adverse_media_id = a.id
      ${whereClause}
    ),
    grant_totals AS (
      SELECT UPPER(m.matched_entity_name) AS key,
             SUM(g.agreement_value)::numeric AS total,
             COUNT(*)::int AS cnt
      FROM matched m
      JOIN grants g ON UPPER(g.recipient_legal_name) = UPPER(m.matched_entity_name)
      GROUP BY UPPER(m.matched_entity_name)
    ),
    contract_totals AS (
      SELECT UPPER(m.matched_entity_name) AS key,
             SUM(c.effective_value)::numeric AS total,
             COUNT(*)::int AS cnt
      FROM matched m
      JOIN contracts c ON UPPER(c.vendor_name) = UPPER(m.matched_entity_name)
      GROUP BY UPPER(m.matched_entity_name)
    )
    SELECT m.*,
           gt.total AS grants_total,
           gt.cnt   AS grants_count,
           ct.total AS contracts_total,
           ct.cnt   AS contracts_count
    FROM matched m
    LEFT JOIN grant_totals gt ON gt.key = UPPER(m.matched_entity_name)
    LEFT JOIN contract_totals ct ON ct.key = UPPER(m.matched_entity_name)
    ORDER BY
      COALESCE(gt.total, 0) + COALESCE(ct.total, 0) DESC,
      m.confidence DESC,
      m.published_at DESC NULLS LAST
    LIMIT $${limitIdx}
    `,
    params,
  );

  const headline = await querySafe<{ funded_flagged: number }>(
    `
    SELECT COUNT(*)::int AS funded_flagged FROM (
      SELECT DISTINCT UPPER(m.matched_entity_name) AS key
      FROM adverse_media_matches m
      WHERE EXISTS (SELECT 1 FROM grants g WHERE UPPER(g.recipient_legal_name) = UPPER(m.matched_entity_name))
         OR EXISTS (SELECT 1 FROM contracts c WHERE UPPER(c.vendor_name) = UPPER(m.matched_entity_name))
    ) t
    `,
  );

  return NextResponse.json({
    taxonomy: ADVERSE_MEDIA_SEVERITIES,
    severity_counts: severityCounts,
    match_summary: matchSummary,
    funded_flagged_count: headline[0]?.funded_flagged ?? 0,
    filters: { severity, method, limit },
    matches,
    disclaimer:
      "Data shown is the UNION of exact BN, exact normalized-name, and high-confidence pgvector matches. Adverse-media records are not proof of wrongdoing; see source_url for original listing.",
  });
}
