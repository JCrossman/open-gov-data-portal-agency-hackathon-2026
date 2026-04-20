import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { bnPrefix as toBnPrefix } from "@/lib/metrics";

interface RedFlag {
  source: string;
  severity: "high" | "medium" | "low";
  detail: string;
  challenge?: string;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const entityName = params.get("name");
  const bn = params.get("bn") ?? null;

  if (!entityName) {
    return NextResponse.json({ error: "name parameter required" }, { status: 400 });
  }

  const prefix = toBnPrefix(bn);
  const flags: RedFlag[] = [];

  // Charity status (for compatibility with existing consumers).
  let charityStatus: {
    found: boolean; category: string | null; designation: string | null;
    flagged: boolean; reason: string | null;
  } | null = null;

  if (bn) {
    const idRows = await query<{ designation: string | null; category: string | null }>(
      `SELECT designation, category FROM t3010_id WHERE bn = $1 LIMIT 1`,
      [bn],
    );
    if (idRows[0]) {
      const designation = String(idRows[0].designation ?? "");
      const category = String(idRows[0].category ?? "");
      const isRevoked = designation.toLowerCase().includes("revoked");
      const isAnnulled = designation.toLowerCase().includes("annulled");
      const isFlagged = isRevoked || isAnnulled;
      charityStatus = {
        found: true, category, designation,
        flagged: isFlagged,
        reason: isFlagged ? `Charity designation is "${designation}"` : null,
      };
      if (isFlagged) {
        flags.push({
          source: "CRA T3010 Charity Status",
          severity: "high",
          detail: `Charity designation: ${designation}`,
        });
      }
    } else {
      charityStatus = { found: false, category: null, designation: null, flagged: false, reason: null };
    }
  }

  // Run all MV-driven EXISTS checks in parallel. Each returns a boolean and
  // (where useful) a short evidence string. Failures are swallowed so missing
  // MVs do not break the screen.
  const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
    try { return await p; } catch { return fallback; }
  };

  const namePat = `%${entityName}%`;

  const [
    zombie, ghost, governance, threshold, followon, purposeCluster,
    adverseMedia, wrongdoingRows,
  ] = await Promise.all([
    // C1 — zombie cessation (true positive: BN deregistered + funded)
    prefix
      ? safe(query<{ cohort: string; total_grants_2020p: number; last_list_year: number | null }>(
          `SELECT cohort, total_grants_2020p, last_list_year
             FROM mv_zombie_recipients
            WHERE bn = $1
            ORDER BY CASE WHEN cohort='cessation' THEN 0 ELSE 1 END
            LIMIT 1`,
          [prefix],
        ), [])
      : Promise.resolve([] as { cohort: string; total_grants_2020p: number; last_list_year: number | null }[]),

    // C2 — ghost capacity (composite ghost_score >= 3)
    prefix
      ? safe(query<{ ghost_score: number; sig_no_employees: number; sig_pass_through: number }>(
          `SELECT ghost_score, sig_no_employees, sig_pass_through
             FROM mv_ghost_capacity
            WHERE bn = $1 LIMIT 1`,
          [prefix],
        ), [])
      : Promise.resolve([] as { ghost_score: number; sig_no_employees: number; sig_pass_through: number }[]),

    // C6 — related-party flow link (shared director with funding flow)
    prefix
      ? safe(query<{ name_x: string; name_y: string; transfer_xy: number; transfer_yx: number; joint_grants_value: number }>(
          `SELECT name_x, name_y, transfer_xy, transfer_yx, joint_grants_value
             FROM mv_governance_flow_links
            WHERE bn_x = $1 OR bn_y = $1
            ORDER BY rank_score DESC NULLS LAST LIMIT 1`,
          [prefix],
        ), [])
      : Promise.resolve([] as { name_x: string; name_y: string; transfer_xy: number; transfer_yx: number; joint_grants_value: number }[]),

    // C4 — threshold splitting (vendor-department pair clustered just below limit)
    safe(query<{ owner_org_title: string; label: string; contracts_in_window: number; total_in_window: number }>(
      `SELECT owner_org_title, label, contracts_in_window, total_in_window
         FROM mv_threshold_splitting
        WHERE normalized_vendor ILIKE $1
        ORDER BY contracts_in_window DESC LIMIT 1`,
      [namePat],
    ), []),

    // C4 — sole-source follow-on after a competitive win
    safe(query<{ owner_org_title: string; followon_tn_count: number; followon_tn_value: number }>(
      `SELECT owner_org_title, followon_tn_count, followon_tn_value
         FROM mv_same_vendor_followon
        WHERE normalized_vendor ILIKE $1
        ORDER BY followon_tn_value DESC NULLS LAST LIMIT 1`,
      [namePat],
    ), []),

    // C8 — purpose-cluster duplication (same recipient, multiple departments, same purpose)
    safe(query<{ purpose_cluster: string; n_departments: number; total_value: number }>(
      `SELECT purpose_cluster, n_departments, total_value
         FROM mv_purpose_cluster
        WHERE recipient_legal_name ILIKE $1 ${prefix ? "OR bn_prefix = $2" : ""}
        ORDER BY n_departments DESC, total_value DESC NULLS LAST LIMIT 1`,
      prefix ? [namePat, prefix] : [namePat],
    ), []),

    // C10 — adverse media match
    prefix
      ? safe(query<{ matched_entity_name: string; match_method: string; confidence: number | null }>(
          `SELECT matched_entity_name, match_method, confidence
             FROM adverse_media_matches
            WHERE substr(matched_bn,1,9) = $1
            ORDER BY confidence DESC NULLS LAST LIMIT 1`,
          [prefix],
        ), [])
      : safe(query<{ matched_entity_name: string; match_method: string; confidence: number | null }>(
          `SELECT matched_entity_name, match_method, confidence
             FROM adverse_media_matches
            WHERE matched_entity_name ILIKE $1
            ORDER BY confidence DESC NULLS LAST LIMIT 1`,
          [namePat],
        ), []),

    // Acts of Founded Wrongdoing (legacy, internal-government)
    safe(query<{ owner_org_title: string | null; raw_fields: string | null }>(
      `SELECT owner_org_title, raw_fields FROM wrongdoing WHERE owner_org_title ILIKE $1 LIMIT 5`,
      [namePat],
    ), []),
  ]);

  if (zombie[0] && zombie[0].cohort === "cessation") {
    flags.push({
      challenge: "C1 — Zombie Recipients",
      source: "mv_zombie_recipients",
      severity: "high",
      detail: `Cessation cohort: BN absent from CRA charity list since ${zombie[0].last_list_year ?? "unknown"} after receiving $${Number(zombie[0].total_grants_2020p ?? 0).toLocaleString()} in pre-cessation federal grants.`,
    });
  } else if (zombie[0] && zombie[0].cohort === "dependency_risk") {
    flags.push({
      challenge: "C1 — Zombie Recipients",
      source: "mv_zombie_recipients",
      severity: "medium",
      detail: `Dependency-risk signal: annualized federal grants ≥ 70% of total revenue. Not evidence of cessation — a forward-looking risk indicator.`,
    });
  }

  if (ghost[0] && Number(ghost[0].ghost_score) >= 3) {
    flags.push({
      challenge: "C2 — Ghost Capacity",
      source: "mv_ghost_capacity",
      severity: "high",
      detail: `Ghost-capacity composite score ${ghost[0].ghost_score}/6 (no employees=${ghost[0].sig_no_employees}, pass-through=${ghost[0].sig_pass_through}). Funded entity with little observable delivery capacity.`,
    });
  }

  if (governance[0]) {
    const txy = Number(governance[0].transfer_xy ?? 0);
    const tyx = Number(governance[0].transfer_yx ?? 0);
    const jg = Number(governance[0].joint_grants_value ?? 0);
    if (txy + tyx + jg > 0) {
      flags.push({
        challenge: "C6 — Related Parties",
        source: "mv_governance_flow_links",
        severity: "medium",
        detail: `Shared-director funding flow with ${governance[0].name_x === entityName ? governance[0].name_y : governance[0].name_x}: transfers $${(txy + tyx).toLocaleString()}, joint grant value $${jg.toLocaleString()}.`,
      });
    }
  }

  if (threshold[0] && Number(threshold[0].contracts_in_window) >= 2) {
    flags.push({
      challenge: "C4 — Threshold Splitting",
      source: "mv_threshold_splitting",
      severity: "medium",
      detail: `${threshold[0].contracts_in_window} contracts clustered just below the ${threshold[0].label} threshold with ${threshold[0].owner_org_title} (window total $${Number(threshold[0].total_in_window ?? 0).toLocaleString()}).`,
    });
  }

  if (followon[0] && Number(followon[0].followon_tn_count) > 0) {
    flags.push({
      challenge: "C4 — Sole-Source Follow-On",
      source: "mv_same_vendor_followon",
      severity: "medium",
      detail: `${followon[0].followon_tn_count} sole-source follow-on contracts after a competitive win with ${followon[0].owner_org_title} ($${Number(followon[0].followon_tn_value ?? 0).toLocaleString()}).`,
    });
  }

  if (purposeCluster[0] && Number(purposeCluster[0].n_departments) >= 2) {
    flags.push({
      challenge: "C8 — Duplicative Funding",
      source: "mv_purpose_cluster",
      severity: "low",
      detail: `Funded by ${purposeCluster[0].n_departments} departments for the same purpose ("${purposeCluster[0].purpose_cluster}"); aggregate $${Number(purposeCluster[0].total_value ?? 0).toLocaleString()}.`,
    });
  }

  if (adverseMedia[0]) {
    flags.push({
      challenge: "C10 — Adverse Media",
      source: "adverse_media_matches",
      severity: "high",
      detail: `Adverse-media match: "${adverseMedia[0].matched_entity_name}" via ${adverseMedia[0].match_method}${adverseMedia[0].confidence != null ? ` (confidence ${Number(adverseMedia[0].confidence).toFixed(2)})` : ""}.`,
    });
  }

  for (const rec of wrongdoingRows) {
    let detail = "";
    if (rec.raw_fields) {
      try {
        const raw = JSON.parse(rec.raw_fields);
        detail = String(raw.case_description_en ?? raw.findings_conclusions ?? "").substring(0, 200);
      } catch { /* ignore */ }
    }
    flags.push({
      source: "Acts of Founded Wrongdoing (internal-government)",
      severity: "medium",
      detail: detail || String(rec.owner_org_title ?? ""),
    });
  }

  return NextResponse.json({
    entityName,
    businessNumber: bn,
    governmentRedFlags: flags,
    charityStatus,
    webSearchResults: null,
    webSearchNote: null,
  });
}
