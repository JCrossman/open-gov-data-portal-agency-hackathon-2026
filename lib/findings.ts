import { querySafe } from "@/lib/db";

export type Findings = Record<string, string>;

const UNAVAILABLE = "Data unavailable";

function fmtMoney(n: number): string {
  if (!isFinite(n) || n <= 0) return "$0";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtCount(n: number): string {
  if (!isFinite(n) || n < 0) return "0";
  return n.toLocaleString("en-CA");
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? NaN : n;
}

/**
 * Builds the short "finding" summary for each challenge card.
 *
 * Per CLAUDE.md Challenge Alignment Rules, findings are labeled as signals,
 * leads, proxies, or placeholders when the underlying MV only answers a
 * subset of the full challenge prompt. Every query is guarded with an
 * explicit "Data unavailable" fallback (no silent zeros).
 */
export async function getChallengeFindings(): Promise<Findings> {
  const [
    zombie,
    ghost,
    funding,
    reciprocals,
    amendment,
    amendmentTop,
    services,
    vendorTop,
    related,
    policy,
    duplicative,
    duplicativeTop,
    commodity,
    wrongdoing,
  ] = await Promise.all([
    querySafe<{ n: number }>(`SELECT COUNT(*)::int AS n FROM mv_zombie_recipients`),
    querySafe<{ n: number }>(`SELECT COUNT(*)::int AS n FROM mv_ghost_capacity`),
    querySafe<{ total_transfers: number }>(`SELECT total_transfers FROM mv_funding_stats`),
    querySafe<{ n: number }>(`SELECT COUNT(*)::int AS n FROM mv_funding_reciprocals`),
    querySafe<{ n: number }>(`SELECT COUNT(*)::int AS n FROM mv_amendment_creep`),
    querySafe<{ vendor_name: string; original_value: string; effective_value: string; amendment_ratio: string }>(
      `SELECT vendor_name, original_value, effective_value, amendment_ratio
       FROM mv_amendment_creep ORDER BY effective_value DESC NULLS LAST LIMIT 1`,
    ),
    querySafe<{ total_value: string }>(`SELECT total_value FROM mv_service_contracts_count`),
    querySafe<{ display_name: string; total_value: string }>(
      `SELECT display_name, total_value FROM mv_vendor_concentration ORDER BY total_value DESC NULLS LAST LIMIT 1`,
    ),
    querySafe<{ total_multi_board: number }>(`SELECT total_multi_board FROM mv_related_parties_stats`),
    querySafe<{ bucket: string; total_value: string }>(
      `SELECT bucket, total_value FROM mv_policy_buckets`,
    ),
    querySafe<{ total_multi_dept: number }>(`SELECT total_multi_dept FROM mv_duplicative_stats`),
    querySafe<{ name: string; dept_count: number }>(
      `SELECT name, dept_count FROM mv_duplicative_funding ORDER BY dept_count DESC, total_value DESC LIMIT 1`,
    ),
    querySafe<{ code: string; total_value: string }>(
      `SELECT code, total_value FROM mv_contract_commodity`,
    ),
    querySafe<{ n: number }>(`SELECT COUNT(*)::int AS n FROM wrongdoing`),
  ]);

  const findings: Findings = {};

  // Challenge 1: Zombie Recipients — dependency signal, not proven disappearance
  findings["zombie-recipients"] = zombie[0]?.n
    ? `${fmtCount(zombie[0].n)} grant-verified recipients with ≥70% government dependency — dependency-risk signal, not proven cessation`
    : UNAVAILABLE;

  // Challenge 2: Ghost Capacity — signal only (high-dep + high-comp ratio)
  findings["ghost-capacity"] = ghost[0]?.n
    ? `${fmtCount(ghost[0].n)} organizations flagged on dependency + compensation-ratio signals (requires capacity verification)`
    : UNAVAILABLE;

  // Challenge 3: Funding Loops — reciprocal pairs only (subset of full challenge)
  if (reciprocals[0]?.n !== undefined && funding[0]?.total_transfers !== undefined) {
    findings["funding-loops"] =
      `${fmtCount(reciprocals[0].n)} reciprocal transfer pairs detected across ${fmtCount(funding[0].total_transfers)} T3010 transfers (reciprocals subset; cycles not yet analyzed)`;
  } else {
    findings["funding-loops"] = UNAVAILABLE;
  }

  // Challenge 4: Amendment Creep — one illustrative contract + total flagged count
  {
    const top = amendmentTop[0];
    const count = amendment[0]?.n;
    if (top && count !== undefined) {
      const orig = toNum(top.original_value);
      const eff = toNum(top.effective_value);
      const ratio = toNum(top.amendment_ratio);
      if (isFinite(orig) && isFinite(eff) && isFinite(ratio)) {
        findings["amendment-creep"] =
          `${top.vendor_name}: ${fmtMoney(orig)} → ${fmtMoney(eff)} (${ratio.toFixed(1)}x); ${fmtCount(count)} sole-source relationships flagged`;
      } else {
        findings["amendment-creep"] = `${fmtCount(count)} sole-source relationships flagged with >2× amendment growth`;
      }
    } else {
      findings["amendment-creep"] = UNAVAILABLE;
    }
  }

  // Challenge 5: Vendor Concentration — top service vendor and market share
  {
    const top = vendorTop[0];
    const market = toNum(services[0]?.total_value);
    const vendorValue = toNum(top?.total_value);
    if (top && isFinite(market) && market > 0 && isFinite(vendorValue)) {
      const pct = (vendorValue / market) * 100;
      findings["vendor-concentration"] =
        `${top.display_name} holds ${pct.toFixed(1)}% (${fmtMoney(vendorValue)}) of federal service contract value`;
    } else {
      findings["vendor-concentration"] = UNAVAILABLE;
    }
  }

  // Challenge 6: Related Parties — same-name matches are leads, not proven control
  findings["related-parties"] = related[0]?.total_multi_board
    ? `${fmtCount(related[0].total_multi_board)} same-name multi-board matches — leads requiring disambiguation, not proven related-party control`
    : UNAVAILABLE;

  // Challenge 7: Policy Misalignment — keyword-bucket proxy
  {
    if (policy.length) {
      const total = policy.reduce((a, r) => a + (toNum(r.total_value) || 0), 0);
      const housing = policy.find((r) => r.bucket === "Housing");
      const housingValue = toNum(housing?.total_value);
      if (total > 0 && isFinite(housingValue)) {
        const pct = (housingValue / total) * 100;
        findings["policy-misalignment"] =
          `Housing programs = ${pct.toFixed(1)}% of classified grants (keyword-bucket proxy, not policy-target alignment)`;
      } else {
        findings["policy-misalignment"] = UNAVAILABLE;
      }
    } else {
      findings["policy-misalignment"] = UNAVAILABLE;
    }
  }

  // Challenge 8: Duplicative Funding — multi-department overlap (not purpose-matched)
  {
    const top = duplicativeTop[0];
    const count = duplicative[0]?.total_multi_dept;
    if (top && count !== undefined) {
      findings["duplicative-funding"] =
        `${top.name} funded by ${top.dept_count} departments; ${fmtCount(count)} recipients span 2+ departments (overlap signal; not purpose-matched)`;
    } else {
      findings["duplicative-funding"] = UNAVAILABLE;
    }
  }

  // Challenge 9: Contract Intelligence — services share (snapshot only, not growth decomposition)
  {
    if (commodity.length) {
      const total = commodity.reduce((a, r) => a + (toNum(r.total_value) || 0), 0);
      const svc = commodity.find((r) => r.code === "S");
      const svcValue = toNum(svc?.total_value);
      if (total > 0 && isFinite(svcValue)) {
        const pct = (svcValue / total) * 100;
        findings["contract-intelligence"] =
          `Services = ${pct.toFixed(0)}% of categorized contract value (snapshot; cost-growth decomposition pending)`;
      } else {
        findings["contract-intelligence"] = UNAVAILABLE;
      }
    } else {
      findings["contract-intelligence"] = UNAVAILABLE;
    }
  }

  // Challenge 10: Adverse Media — internal wrongdoing dataset, labeled as placeholder
  findings["adverse-media"] = wrongdoing[0]?.n
    ? `${fmtCount(wrongdoing[0].n)} founded internal-wrongdoing cases (placeholder — external adverse-media pipeline pending)`
    : UNAVAILABLE;

  return findings;
}
