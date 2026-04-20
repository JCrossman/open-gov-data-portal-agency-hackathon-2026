import pg from "pg";
import { NORMALIZE_VENDOR_SQL_BODY } from "../lib/vendor-normalization";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=verify-full";

const MATERIALIZED_VIEWS: { name: string; sql: string }[] = [
  // Small tables first (fast) -----------------------------------------------

  // Challenge 10: Adverse Media — wrongdoing is just 228 rows
  // (no MV needed, but included for consistency)

  // Challenge 1: Zombie Recipients — two cohorts.
  //
  // Part A ("cessation"): recipients whose most recent T3010 filing (FPE) is
  //   >= 18 months old AND who received >= $1M in verified federal grants in
  //   the 3 years preceding that last filing. This is the literal Challenge 1
  //   prompt: "received large amounts of public funding and then ceased
  //   operations / stopped filing".
  //
  // Part B ("dependency_risk"): still-active filers (last FPE < 18 months)
  //   with >= 70% annualized verified grants / revenue. These are flagged as
  //   a FORWARD-LOOKING signal, not as confirmed cessation. The UI must
  //   label them accordingly (see app/challenges/zombie-recipients/page.tsx).
  //
  // Data caveats (must be surfaced in-UI):
  //   - FPE is sourced from the annual CKAN T3010 release (CKAN resource
  //     e545170c-3689-4833-b2a8-e9e83100ab59 via scripts/backfill-fpe.mjs).
  //     The current load covers 2024 FPEs only, so "stopped filing" will
  //     include charities simply awaiting their next year's file.
  //   - Government / publicly-funded institutions (provinces, universities,
  //     ministries, crown bodies) are excluded by name to avoid false
  //     "zombie" labels.
  //   - Verified grants use the real `grants` table with BN-prefix matching
  //     (substr(bn,1,9)); see lib/metrics.ts for the canonical methodology.
  // Challenge 1: Zombie Recipients. Multi-year T3010 data now loaded — cessation
  // is detected by true deregistration (BN absent from the latest CRA annual
  // List of Charities), not by FPE age alone. Two cohorts:
  //   - cessation: BN was registered in a prior CRA annual list but is NOT in
  //     the most recent (2024) list → genuinely deregistered. Filtered to
  //     recipients who received >= $1M in verified federal grants in the 3
  //     years preceding their last filing.
  //   - dependency_risk: Still present in 2024 CRA list with annualized
  //     verified federal grants >= 70% of most-recent-year revenue.
  // Government / publicly-funded institutions (provinces, universities,
  // ministries, crown bodies) excluded by name to avoid false labels.
  {
    name: "mv_zombie_recipients",
    sql: `
      WITH id_last_seen AS (
        SELECT substr(bn,1,9) AS bn_prefix, MAX(list_year) AS last_list_year
        FROM t3010_id_history GROUP BY substr(bn,1,9)
      ),
      fin_latest AS (
        SELECT DISTINCT ON (substr(bn,1,9))
               substr(bn,1,9) AS bn_prefix,
               total_revenue::numeric AS total_revenue,
               fpe
        FROM t3010_financial
        WHERE fpe IS NOT NULL
        ORDER BY substr(bn,1,9), fpe DESC
      ),
      grants_all AS (
        SELECT substr(recipient_business_number,1,9) AS bn_prefix,
               MAX(recipient_legal_name) AS grant_name,
               SUM(agreement_value)::numeric AS total_grants_2020p,
               COUNT(*)::int AS grant_count,
               GREATEST(COUNT(DISTINCT EXTRACT(YEAR FROM agreement_start_date)), 1)::int AS years_active,
               MAX(agreement_start_date) AS last_grant_date
        FROM grants
        WHERE recipient_business_number IS NOT NULL
          AND LENGTH(recipient_business_number) >= 9
          AND agreement_value > 0
          AND agreement_start_date >= '2017-01-01'
        GROUP BY substr(recipient_business_number,1,9)
      ),
      grants_pre_fpe AS (
        SELECT substr(g.recipient_business_number,1,9) AS bn_prefix,
               SUM(g.agreement_value)::numeric AS grants_3yr_pre_fpe
        FROM grants g
        JOIN fin_latest f ON substr(g.recipient_business_number,1,9) = f.bn_prefix
        WHERE g.agreement_value > 0
          AND f.fpe IS NOT NULL
          AND g.agreement_start_date BETWEEN (f.fpe - INTERVAL '3 years') AND f.fpe
        GROUP BY substr(g.recipient_business_number,1,9)
      ),
      gov_recipients AS (
        -- Exclude entities classified by funders as Government recipients (type G).
        -- These are provincial/municipal governments, crown corporations, and
        -- regional health authorities that may briefly appear in CRA filings but
        -- are not genuine charity recipients subject to the zombie-recipient test.
        SELECT substr(recipient_business_number,1,9) AS bn_prefix
        FROM grants
        WHERE recipient_business_number IS NOT NULL
          AND LENGTH(recipient_business_number) >= 9
          AND recipient_type = 'G'
        GROUP BY substr(recipient_business_number,1,9)
      ),
      id_by_prefix AS (
        SELECT DISTINCT ON (substr(bn,1,9)) substr(bn,1,9) AS bn_prefix,
               legal_name, designation, category
        FROM t3010_id
        ORDER BY substr(bn,1,9), CASE WHEN legal_name IS NOT NULL THEN 0 ELSE 1 END
      ),
      id_history_name AS (
        -- Fallback name for deregistered BNs (no longer in t3010_id)
        SELECT DISTINCT ON (substr(bn,1,9)) substr(bn,1,9) AS bn_prefix, legal_name
        FROM t3010_id_history
        WHERE legal_name IS NOT NULL AND legal_name <> ''
        ORDER BY substr(bn,1,9), list_year DESC
      ),
      joined AS (
        SELECT g.bn_prefix,
               COALESCE(i.legal_name, ih.legal_name, g.grant_name) AS legal_name,
               i.designation,
               i.category,
               f.total_revenue,
               f.fpe AS last_fpe,
               ils.last_list_year,
               (g.total_grants_2020p / g.years_active)::numeric AS gov_funding_annual,
               g.total_grants_2020p,
               g.grant_count,
               g.years_active,
               g.last_grant_date,
               COALESCE(gp.grants_3yr_pre_fpe, 0)::numeric AS grants_3yr_pre_fpe,
               LEAST((g.total_grants_2020p / g.years_active)
                     / NULLIF(f.total_revenue, 0) * 100, 100)::numeric AS gov_pct,
               CASE WHEN f.fpe IS NOT NULL
                    THEN (CURRENT_DATE - f.fpe) / 30.44
               END::numeric AS fpe_age_months
        FROM grants_all g
        LEFT JOIN fin_latest f ON g.bn_prefix = f.bn_prefix
        LEFT JOIN id_by_prefix i ON g.bn_prefix = i.bn_prefix
        LEFT JOIN id_history_name ih ON g.bn_prefix = ih.bn_prefix
        LEFT JOIN grants_pre_fpe gp ON g.bn_prefix = gp.bn_prefix
        LEFT JOIN id_last_seen ils ON g.bn_prefix = ils.bn_prefix
      )
      -- Part A (primary view): cessation cohort — BN absent from 2024 CRA list
      -- Stricter: BN must NOT be receiving grants after its last CRA filing year
      -- (allow 1-year lag for in-flight grant amendments). Without this filter, 
      -- BN-prefix collisions surface active recipients as "ceased" — e.g. ST 
      -- STEPHEN'S COMMUNITY HOUSE last_list_year=2020 but $105M in grants through
      -- 2025. Real cessation = no further grants flow after deregistration.
      SELECT bn_prefix AS bn, legal_name, designation, category, total_revenue,
             gov_funding_annual AS gov_funding, gov_pct, grant_count, years_active,
             total_grants_2020p, grants_3yr_pre_fpe, last_fpe, fpe_age_months,
             last_grant_date, last_list_year,
             'cessation'::text AS cohort
      FROM joined
      WHERE last_list_year IS NOT NULL
        AND last_list_year < 2024
        AND grants_3yr_pre_fpe >= 1000000
        AND (last_grant_date IS NULL
             OR EXTRACT(YEAR FROM last_grant_date) <= last_list_year + 1)
        AND bn_prefix NOT IN (SELECT bn_prefix FROM gov_recipients)
        AND COALESCE(legal_name,'') NOT ILIKE '%gouvernement%'
        AND COALESCE(legal_name,'') NOT ILIKE '%government of%'
        AND COALESCE(legal_name,'') NOT ILIKE 'province of %'
        AND COALESCE(legal_name,'') NOT ILIKE '%provincial government%'
        AND COALESCE(legal_name,'') NOT ILIKE '%ministry of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%ministère%'
        AND COALESCE(legal_name,'') NOT ILIKE '%department of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%sa majesté%'
        AND COALESCE(legal_name,'') NOT ILIKE '%his majesty%'
        AND COALESCE(legal_name,'') NOT ILIKE '%her majesty%'
        AND COALESCE(legal_name,'') NOT ILIKE '%university%'
        AND COALESCE(legal_name,'') NOT ILIKE '%université%'
        AND COALESCE(legal_name,'') NOT ILIKE '%college%'
        AND COALESCE(legal_name,'') NOT ILIKE '%collège%'
        AND COALESCE(legal_name,'') NOT ILIKE '%municipality of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%city of %'
        AND COALESCE(legal_name,'') NOT ILIKE '%ville de %'
        AND COALESCE(legal_name,'') NOT ILIKE '%health authority%'
        AND COALESCE(legal_name,'') NOT ILIKE '%régie de la santé%'
        AND COALESCE(legal_name,'') NOT ILIKE '%regional health%'
        AND COALESCE(legal_name,'') NOT ILIKE '%agence de la santé%'
        AND COALESCE(legal_name,'') NOT ILIKE '%crown corporation%'

      UNION ALL

      -- Part B: dependency_risk cohort — still registered, >= 70% annualized federal grants
      SELECT bn_prefix AS bn, legal_name, designation, category, total_revenue,
             gov_funding_annual AS gov_funding, gov_pct, grant_count, years_active,
             total_grants_2020p, grants_3yr_pre_fpe, last_fpe, fpe_age_months,
             last_grant_date, last_list_year,
             'dependency_risk'::text AS cohort
      FROM joined
      WHERE (last_list_year = 2024 OR last_list_year IS NULL)
        AND total_revenue > 500000
        AND gov_pct >= 70
        AND bn_prefix NOT IN (SELECT bn_prefix FROM gov_recipients)
        AND COALESCE(legal_name,'') NOT ILIKE '%gouvernement%'
        AND COALESCE(legal_name,'') NOT ILIKE '%government of%'
        AND COALESCE(legal_name,'') NOT ILIKE 'province of %'
        AND COALESCE(legal_name,'') NOT ILIKE '%provincial government%'
        AND COALESCE(legal_name,'') NOT ILIKE '%ministry of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%ministère%'
        AND COALESCE(legal_name,'') NOT ILIKE '%department of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%sa majesté%'
        AND COALESCE(legal_name,'') NOT ILIKE '%his majesty%'
        AND COALESCE(legal_name,'') NOT ILIKE '%her majesty%'
        AND COALESCE(legal_name,'') NOT ILIKE '%university%'
        AND COALESCE(legal_name,'') NOT ILIKE '%université%'
        AND COALESCE(legal_name,'') NOT ILIKE '%college%'
        AND COALESCE(legal_name,'') NOT ILIKE '%collège%'
        AND COALESCE(legal_name,'') NOT ILIKE '%municipality of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%city of %'
        AND COALESCE(legal_name,'') NOT ILIKE '%ville de %'
        AND COALESCE(legal_name,'') NOT ILIKE '%health authority%'
        AND COALESCE(legal_name,'') NOT ILIKE '%régie de la santé%'
        AND COALESCE(legal_name,'') NOT ILIKE '%regional health%'
        AND COALESCE(legal_name,'') NOT ILIKE '%agence de la santé%'
        AND COALESCE(legal_name,'') NOT ILIKE '%crown corporation%'
    `,
  },

  // Challenge 2: Ghost Capacity — composite capacity score.
  //
  // Six individual signals (each 0/1) summed into ghost_score 0..6:
  //   1. no/minimal employees (<= 1, or clearly-wrong > 500K capped to NULL)
  //   2. no program descriptions on file
  //   3. no usable physical address
  //   4. compensation-heavy        (comp_numerator/revenue >= 0.60)
  //   5. transfer-out pass-through (transfers_out/expenditure >= 0.60)
  //   6. no non-government revenue (revenue - self_reported_gov - verified_grants <= 0)
  //
  // Row is emitted only if ghost_score >= 3 — no single signal alone flags
  // an entity, per Challenge 2's constitutional guardrail.
  //
  // Carve-outs (NOT flagged):
  //   - Private foundations (designation='A') whose 4130 investment income
  //     is >= 30% of revenue — these are grant-making investment vehicles,
  //     not operational capacity entities.
  //   - Public foundations (designation='B') with the same investment
  //     pattern.
  //   - Trust / estate / testamentary legal names.
  //   - Government / publicly-funded institutions (same exclusion set as
  //     mv_zombie_recipients for consistency).
  //
  // Canonical metric alignment: comp_numerator = COALESCE(compensation,
  // mgmt_admin_exp) / total_revenue — matches lib/metrics.ts Metric 3 so the
  // same number shows on entity/charity profiles.
  {
    name: "mv_ghost_capacity",
    sql: `
      WITH fin_latest AS (
        SELECT DISTINCT ON (substr(bn,1,9))
               substr(bn,1,9) AS bn_prefix,
               total_revenue::numeric AS total_revenue,
               total_expenditure::numeric AS total_expenditure,
               gov_funding_federal::numeric AS self_reported_gov_rev,
               gov_funding_provincial::numeric AS investment_income_4130,
               gov_funding_other::numeric AS other_rev_4140,
               compensation::numeric AS compensation,
               mgmt_admin_exp::numeric AS mgmt_admin_exp,
               fpe
        FROM t3010_financial
        WHERE total_revenue IS NOT NULL AND total_revenue > 0
          AND fpe IS NOT NULL
        ORDER BY substr(bn,1,9), fpe DESC NULLS LAST
      ),
      comp_agg AS (
        SELECT substr(bn,1,9) AS bn_prefix,
               CASE WHEN (COALESCE(ft_employees,0) + COALESCE(pt_employees,0)) > 500000
                    THEN NULL
                    ELSE (COALESCE(ft_employees,0) + COALESCE(pt_employees,0))
               END::bigint AS employee_count
        FROM t3010_compensation
      ),
      comp_by_prefix AS (
        SELECT bn_prefix, MAX(employee_count) AS employee_count
        FROM comp_agg GROUP BY bn_prefix
      ),
      prog_agg AS (
        SELECT substr(bn,1,9) AS bn_prefix,
               BOOL_OR(description IS NOT NULL AND LENGTH(TRIM(description)) > 10)
                 AS has_program_desc
        FROM t3010_programs GROUP BY substr(bn,1,9)
      ),
      addr_agg_id AS (
        SELECT DISTINCT ON (substr(bn,1,9))
               substr(bn,1,9) AS bn_prefix,
               legal_name, designation, category,
               (COALESCE(address,'') <> '' AND COALESCE(city,'') <> '') AS has_address
        FROM t3010_id
        ORDER BY substr(bn,1,9), CASE WHEN legal_name IS NOT NULL THEN 0 ELSE 1 END
      ),
      addr_hist AS (
        SELECT DISTINCT ON (substr(bn,1,9))
               substr(bn,1,9) AS bn_prefix,
               legal_name AS hist_legal_name,
               designation AS hist_designation,
               category AS hist_category
        FROM t3010_id_history
        WHERE legal_name IS NOT NULL
        ORDER BY substr(bn,1,9), list_year DESC
      ),
      addr_grants AS (
        SELECT substr(recipient_business_number,1,9) AS bn_prefix,
               MAX(recipient_legal_name) AS grant_legal_name
        FROM grants
        WHERE recipient_business_number IS NOT NULL
          AND LENGTH(recipient_business_number) >= 9
          AND recipient_legal_name IS NOT NULL
        GROUP BY substr(recipient_business_number,1,9)
      ),
      addr_agg AS (
        SELECT COALESCE(i.bn_prefix, h.bn_prefix, g.bn_prefix) AS bn_prefix,
               COALESCE(i.legal_name, h.hist_legal_name, g.grant_legal_name) AS legal_name,
               COALESCE(i.designation, h.hist_designation) AS designation,
               COALESCE(i.category, h.hist_category) AS category,
               COALESCE(i.has_address, FALSE) AS has_address
        FROM addr_agg_id i
        FULL OUTER JOIN addr_hist h ON h.bn_prefix = i.bn_prefix
        FULL OUTER JOIN addr_grants g ON g.bn_prefix = COALESCE(i.bn_prefix, h.bn_prefix)
      ),
      grants_agg AS (
        SELECT substr(recipient_business_number,1,9) AS bn_prefix,
               SUM(agreement_value)::numeric AS total_grants_2020p,
               GREATEST(COUNT(DISTINCT EXTRACT(YEAR FROM agreement_start_date)), 1)::int AS years_active
        FROM grants
        WHERE recipient_business_number IS NOT NULL
          AND LENGTH(recipient_business_number) >= 9
          AND agreement_value > 0
          AND agreement_start_date >= '2020-01-01'
        GROUP BY substr(recipient_business_number,1,9)
      ),
      transfers_out AS (
        SELECT substr(donor_bn,1,9) AS bn_prefix,
               SUM(COALESCE(total_gifts,0))::numeric AS transfers_out_total
        FROM t3010_transfers
        WHERE donor_bn IS NOT NULL
        GROUP BY substr(donor_bn,1,9)
      ),
      feature AS (
        SELECT f.bn_prefix,
               a.legal_name, a.designation, a.category,
               f.total_revenue, f.total_expenditure,
               f.self_reported_gov_rev, f.investment_income_4130, f.other_rev_4140,
               f.compensation, f.mgmt_admin_exp, f.fpe,
               cp.employee_count,
               COALESCE(p.has_program_desc, FALSE) AS has_program_desc,
               COALESCE(a.has_address, FALSE) AS has_address,
               COALESCE(ga.total_grants_2020p, 0) AS total_grants_2020p,
               COALESCE(ga.years_active, 1) AS grant_years_active,
               (COALESCE(ga.total_grants_2020p,0) / GREATEST(COALESCE(ga.years_active,1),1))::numeric AS verified_grants_annual,
               COALESCE(tr.transfers_out_total, 0) AS transfers_out_total,
               COALESCE(f.compensation, f.mgmt_admin_exp, 0)::numeric AS comp_numerator
        FROM fin_latest f
        LEFT JOIN comp_by_prefix cp ON cp.bn_prefix = f.bn_prefix
        LEFT JOIN prog_agg p        ON p.bn_prefix = f.bn_prefix
        LEFT JOIN addr_agg a        ON a.bn_prefix = f.bn_prefix
        LEFT JOIN grants_agg ga     ON ga.bn_prefix = f.bn_prefix
        LEFT JOIN transfers_out tr  ON tr.bn_prefix = f.bn_prefix
      ),
      scored AS (
        SELECT *,
          (comp_numerator / NULLIF(total_revenue,0))::numeric AS compensation_pct,
          (transfers_out_total / NULLIF(total_expenditure,0))::numeric AS transfer_out_ratio,
          (COALESCE(total_revenue,0)
             - COALESCE(self_reported_gov_rev,0)
             - COALESCE(verified_grants_annual,0))::numeric AS non_gov_revenue,
          (employee_count IS NULL OR employee_count <= 1)                         AS sig_no_employees,
          (NOT COALESCE(has_program_desc,FALSE))                                  AS sig_no_programs,
          (NOT COALESCE(has_address,FALSE))                                       AS sig_no_address,
          (comp_numerator / NULLIF(total_revenue,0) >= 0.60)                      AS sig_comp_heavy,
          (transfers_out_total / NULLIF(total_expenditure,0) >= 0.60)             AS sig_pass_through,
          ((COALESCE(total_revenue,0) - COALESCE(self_reported_gov_rev,0)
             - COALESCE(verified_grants_annual,0)) <= 0)                          AS sig_no_non_gov_rev
        FROM feature
      )
      SELECT
        bn_prefix AS bn,
        legal_name, designation, category,
        total_revenue, total_expenditure,
        self_reported_gov_rev, investment_income_4130, other_rev_4140,
        comp_numerator AS compensation_total,
        employee_count,
        has_program_desc, has_address,
        verified_grants_annual, transfers_out_total, fpe,
        ROUND(LEAST(COALESCE(compensation_pct,0)*100, 100), 2) AS comp_pct,
        ROUND(COALESCE(compensation_pct,0)*100, 2) AS comp_pct_raw,
        ROUND(LEAST(COALESCE((self_reported_gov_rev + verified_grants_annual)/NULLIF(total_revenue,0),0)*100,100)::numeric, 2) AS gov_pct,
        ROUND(COALESCE(transfer_out_ratio,0)*100, 2) AS transfer_out_pct,
        non_gov_revenue,
        sig_no_employees, sig_no_programs, sig_no_address,
        sig_comp_heavy, sig_pass_through, sig_no_non_gov_rev,
        (sig_no_employees::int + sig_no_programs::int + sig_no_address::int
          + sig_comp_heavy::int + sig_pass_through::int + sig_no_non_gov_rev::int)::int AS ghost_score
      FROM scored
      WHERE total_revenue > 100000
        AND (sig_no_employees::int + sig_no_programs::int + sig_no_address::int
             + sig_comp_heavy::int + sig_pass_through::int + sig_no_non_gov_rev::int) >= 3
        AND NOT (
          designation IN ('A','B')
          AND COALESCE(investment_income_4130,0) / NULLIF(total_revenue,0) >= 0.30
        )
        AND COALESCE(legal_name,'') NOT ILIKE '%trust%'
        AND COALESCE(legal_name,'') NOT ILIKE '%estate of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%succession de%'
        AND COALESCE(legal_name,'') NOT ILIKE '%testamentary%'
        AND COALESCE(legal_name,'') NOT ILIKE '%gouvernement%'
        AND COALESCE(legal_name,'') NOT ILIKE '%government of%'
        AND COALESCE(legal_name,'') NOT ILIKE 'province of %'
        AND COALESCE(legal_name,'') NOT ILIKE '%ministry of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%ministère%'
        AND COALESCE(legal_name,'') NOT ILIKE '%department of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%sa majesté%'
        AND COALESCE(legal_name,'') NOT ILIKE '%his majesty%'
        AND COALESCE(legal_name,'') NOT ILIKE '%her majesty%'
        AND COALESCE(legal_name,'') NOT ILIKE '%university%'
        AND COALESCE(legal_name,'') NOT ILIKE '%université%'
        AND COALESCE(legal_name,'') NOT ILIKE '%college%'
        AND COALESCE(legal_name,'') NOT ILIKE '%collège%'
        AND COALESCE(legal_name,'') NOT ILIKE '%municipality of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%city of %'
        AND COALESCE(legal_name,'') NOT ILIKE '%ville de %'
        AND COALESCE(legal_name,'') NOT ILIKE '%health authority%'
        AND COALESCE(legal_name,'') NOT ILIKE '%regional integrated health%'
        AND COALESCE(legal_name,'') NOT ILIKE '%regional health%'
        AND COALESCE(legal_name,'') NOT ILIKE '%régie de la santé%'
        AND COALESCE(legal_name,'') NOT ILIKE '%health centre of%'
        AND COALESCE(legal_name,'') NOT ILIKE '%centre de santé%'
        AND COALESCE(legal_name,'') NOT ILIKE '%crown corporation%'
        AND COALESCE(legal_name,'') NOT ILIKE '%library service board%'
        AND COALESCE(legal_name,'') NOT ILIKE '%community services agency%'
        -- Exclude obvious CRA filing errors (compensation reported > 2x revenue
        -- = data quality issue, not ghost capacity). 88 such rows exist per
        -- CLAUDE.md notes; cap retained for residual borderline cases.
        AND COALESCE(comp_numerator,0) <= COALESCE(total_revenue,0) * 2
    `,
  },

  // Challenge 3: Funding Loops — stats (t3010_transfers ~344K)
  {
    name: "mv_funding_stats",
    sql: `
      SELECT COUNT(*)::int AS total_transfers,
             COALESCE(SUM(total_gifts),0)::numeric AS total_amount,
             COUNT(DISTINCT donor_bn)::int AS unique_donors,
             COUNT(DISTINCT donee_bn)::int AS unique_donees
      FROM t3010_transfers
    `,
  },

  // Challenge 3: Funding Loops — reciprocal pairs (self-join on ~344K)
  // Aggregate transfers per (donor, donee) pair first to avoid multi-year duplicates
  {
    name: "mv_funding_reciprocals",
    sql: `
      WITH agg AS (
        SELECT donor_bn, donee_bn, SUM(total_gifts)::numeric AS total_gifts
        FROM t3010_transfers
        WHERE donor_bn IS NOT NULL AND donee_bn IS NOT NULL
        GROUP BY donor_bn, donee_bn
      )
      SELECT a.donor_bn, a.donee_bn,
             COALESCE(ia.legal_name, a.donor_bn) AS donor_name,
             COALESCE(ib.legal_name, a.donee_bn) AS donee_name,
             a.total_gifts AS a_to_b,
             b.total_gifts AS b_to_a
      FROM agg a
      JOIN agg b ON a.donor_bn = b.donee_bn AND a.donee_bn = b.donor_bn
      LEFT JOIN t3010_id ia ON a.donor_bn = ia.bn
      LEFT JOIN t3010_id ib ON a.donee_bn = ib.bn
      WHERE a.donor_bn < a.donee_bn
        AND a.total_gifts > 0 AND b.total_gifts > 0
        AND substr(a.donor_bn, 1, 9) <> substr(a.donee_bn, 1, 9)
      ORDER BY (COALESCE(a.total_gifts, 0) + COALESCE(b.total_gifts, 0)) DESC NULLS LAST
    `,
  },

  // Challenge 3: Funding Loops — triangular cycles A→B→C→A
  //
  // Finds three-charity cycles where each leg's aggregate transfer is ≥ $100K
  // and all three BN-prefixes are distinct (not the same legal entity via
  // RR-account variants). Canonical ordering by bn_a prefix prevents a single
  // cycle from appearing 3× under rotation, and <> checks prevent self-loops.
  // Labeled as candidate loops only — structural normality is assigned in
  // mv_funding_loop_classification.
  {
    name: "mv_funding_triangles",
    sql: `
      WITH agg AS (
        SELECT donor_bn, donee_bn, SUM(total_gifts)::numeric AS amt
        FROM t3010_transfers
        WHERE donor_bn IS NOT NULL AND donee_bn IS NOT NULL
          AND total_gifts IS NOT NULL AND total_gifts >= 100000
        GROUP BY donor_bn, donee_bn
      ),
      id_p AS (
        SELECT DISTINCT ON (substr(bn,1,9)) substr(bn,1,9) AS bn_prefix, legal_name
        FROM t3010_id
        ORDER BY substr(bn,1,9), CASE WHEN legal_name IS NOT NULL THEN 0 ELSE 1 END
      )
      SELECT ab.donor_bn AS bn_a,
             ab.donee_bn AS bn_b,
             bc.donee_bn AS bn_c,
             COALESCE(ia.legal_name, ab.donor_bn) AS name_a,
             COALESCE(ib.legal_name, ab.donee_bn) AS name_b,
             COALESCE(ic.legal_name, bc.donee_bn) AS name_c,
             ab.amt AS a_to_b,
             bc.amt AS b_to_c,
             ca.amt AS c_to_a,
             LEAST(ab.amt, bc.amt, ca.amt)::numeric AS min_leg,
             (ab.amt + bc.amt + ca.amt)::numeric AS total_circled
      FROM agg ab
      JOIN agg bc ON ab.donee_bn = bc.donor_bn
      JOIN agg ca ON bc.donee_bn = ca.donor_bn AND ca.donee_bn = ab.donor_bn
      LEFT JOIN id_p ia ON substr(ab.donor_bn,1,9) = ia.bn_prefix
      LEFT JOIN id_p ib ON substr(ab.donee_bn,1,9) = ib.bn_prefix
      LEFT JOIN id_p ic ON substr(bc.donee_bn,1,9) = ic.bn_prefix
      WHERE substr(ab.donor_bn,1,9) < substr(ab.donee_bn,1,9)
        AND substr(ab.donor_bn,1,9) < substr(bc.donee_bn,1,9)
        AND substr(ab.donor_bn,1,9) <> substr(ab.donee_bn,1,9)
        AND substr(ab.donee_bn,1,9) <> substr(bc.donee_bn,1,9)
        AND substr(ab.donor_bn,1,9) <> substr(bc.donee_bn,1,9)
      ORDER BY total_circled DESC
    `,
  },

  // Challenge 3: Funding Loops — 4-node cycles A→B→C→D→A
  //
  // Depth capped at 4 (and per-leg threshold at $100K) to keep the self-join
  // cost tractable. Results are capped at top 1000 by total_circled. All
  // four BN-prefixes must be distinct; canonical ordering on bn_a prevents
  // cycle rotation duplicates.
  {
    name: "mv_funding_chains_4",
    sql: `
      WITH agg AS (
        SELECT donor_bn, donee_bn, SUM(total_gifts)::numeric AS amt
        FROM t3010_transfers
        WHERE donor_bn IS NOT NULL AND donee_bn IS NOT NULL
          AND total_gifts IS NOT NULL AND total_gifts >= 100000
        GROUP BY donor_bn, donee_bn
      ),
      id_p AS (
        SELECT DISTINCT ON (substr(bn,1,9)) substr(bn,1,9) AS bn_prefix, legal_name
        FROM t3010_id
        ORDER BY substr(bn,1,9), CASE WHEN legal_name IS NOT NULL THEN 0 ELSE 1 END
      ),
      cycles AS (
        SELECT ab.donor_bn AS bn_a,
               ab.donee_bn AS bn_b,
               bc.donee_bn AS bn_c,
               cd.donee_bn AS bn_d,
               ab.amt AS a_to_b,
               bc.amt AS b_to_c,
               cd.amt AS c_to_d,
               da.amt AS d_to_a
        FROM agg ab
        JOIN agg bc ON ab.donee_bn = bc.donor_bn
        JOIN agg cd ON bc.donee_bn = cd.donor_bn
        JOIN agg da ON cd.donee_bn = da.donor_bn AND da.donee_bn = ab.donor_bn
        WHERE substr(ab.donor_bn,1,9) < substr(ab.donee_bn,1,9)
          AND substr(ab.donor_bn,1,9) < substr(bc.donee_bn,1,9)
          AND substr(ab.donor_bn,1,9) < substr(cd.donee_bn,1,9)
          AND substr(ab.donor_bn,1,9) <> substr(ab.donee_bn,1,9)
          AND substr(ab.donee_bn,1,9) <> substr(bc.donee_bn,1,9)
          AND substr(bc.donee_bn,1,9) <> substr(cd.donee_bn,1,9)
          AND substr(ab.donor_bn,1,9) <> substr(bc.donee_bn,1,9)
          AND substr(ab.donor_bn,1,9) <> substr(cd.donee_bn,1,9)
          AND substr(ab.donee_bn,1,9) <> substr(cd.donee_bn,1,9)
      )
      SELECT c.bn_a, c.bn_b, c.bn_c, c.bn_d,
             COALESCE(ia.legal_name, c.bn_a) AS name_a,
             COALESCE(ib.legal_name, c.bn_b) AS name_b,
             COALESCE(ic.legal_name, c.bn_c) AS name_c,
             COALESCE(id4.legal_name, c.bn_d) AS name_d,
             c.a_to_b, c.b_to_c, c.c_to_d, c.d_to_a,
             LEAST(c.a_to_b, c.b_to_c, c.c_to_d, c.d_to_a)::numeric AS min_leg,
             (c.a_to_b + c.b_to_c + c.c_to_d + c.d_to_a)::numeric AS total_circled
      FROM cycles c
      LEFT JOIN id_p ia  ON substr(c.bn_a,1,9) = ia.bn_prefix
      LEFT JOIN id_p ib  ON substr(c.bn_b,1,9) = ib.bn_prefix
      LEFT JOIN id_p ic  ON substr(c.bn_c,1,9) = ic.bn_prefix
      LEFT JOIN id_p id4 ON substr(c.bn_d,1,9) = id4.bn_prefix
      ORDER BY total_circled DESC
      LIMIT 1000
    `,
  },

  // Challenge 3: Funding Loops — unified classification across reciprocal
  // pairs, triangles, and 4-chains. Classification is heuristic:
  //   structural_hierarchy → denominational / federated naming
  //     (Diocese / Archdiocese / Synod / Province of / Federation of /
  //      Conference of / Congregation).
  //   structural_platform  → donation-platform / federated-fundraiser naming
  //     (Benevity / CanadaHelps / United Way / Jewish Federation /
  //      Jewish Community Foundation / United Jewish Appeal / Community
  //      Foundation / Catholic Charities).
  //   reciprocal_pair      → 2-node loop with no structural match
  //     (default label for reciprocals — still a candidate, not abuse).
  //   possible_suspicious  → multi-node loop with no structural match.
  //
  // Every row must be treated as a CANDIDATE loop only, per the Challenge 3
  // guardrails in CLAUDE.md. Not proof of abuse.
  {
    name: "mv_funding_loop_classification",
    sql: `
      WITH recips AS (
        SELECT 'reciprocal'::text AS loop_type,
               ARRAY[donor_bn, donee_bn] AS bns,
               ARRAY[donor_name, donee_name] AS names,
               (COALESCE(a_to_b,0) + COALESCE(b_to_a,0))::numeric AS total_circled
        FROM mv_funding_reciprocals
      ),
      tris AS (
        SELECT 'triangle'::text AS loop_type,
               ARRAY[bn_a, bn_b, bn_c] AS bns,
               ARRAY[name_a, name_b, name_c] AS names,
               total_circled
        FROM mv_funding_triangles
      ),
      chains AS (
        SELECT 'chain4'::text AS loop_type,
               ARRAY[bn_a, bn_b, bn_c, bn_d] AS bns,
               ARRAY[name_a, name_b, name_c, name_d] AS names,
               total_circled
        FROM mv_funding_chains_4
      ),
      all_loops AS (
        SELECT * FROM recips
        UNION ALL SELECT * FROM tris
        UNION ALL SELECT * FROM chains
      )
      SELECT loop_type, bns, names, total_circled,
        CASE
          WHEN EXISTS (SELECT 1 FROM unnest(names) n
                       WHERE n ~* '(diocese|archdiocese|synod|province of|federation of|conference of|congregation of|presbytery|eparchy)')
            THEN 'structural_hierarchy'
          WHEN EXISTS (SELECT 1 FROM unnest(names) n
                       WHERE n ~* '(benevity|canadahelps|united way|united jewish appeal|jewish federation|jewish community foundation|community foundation of|catholic charities|y\\s?m\\s?c\\s?a|ywca)')
            THEN 'structural_platform'
          WHEN loop_type = 'reciprocal' THEN 'reciprocal_pair'
          ELSE 'possible_suspicious'
        END AS classification
      FROM all_loops
    `,
  },

  // Challenge 3: Funding Loops — top transfers
  {
    name: "mv_funding_top_transfers",
    sql: `
      SELECT t.donor_bn,
             COALESCE(i.legal_name, t.donor_bn) AS donor_name,
             t.donee_name, t.donee_bn,
             t.total_gifts::numeric AS total_gifts,
             t.province
      FROM t3010_transfers t
      LEFT JOIN t3010_id i ON t.donor_bn = i.bn
      WHERE t.total_gifts > 0
      ORDER BY t.total_gifts DESC NULLS LAST
      LIMIT 25
    `,
  },

  // Challenge 6: Related Parties — governance network model.
  //
  // person_key combines normalized first + last + initials. When initials are
  // NULL or blank the key collides on common names (disambiguated = false);
  // those rows are emitted as "leads" with a UI caveat, never as proof.
  //
  // Current-director filter (required by the Challenge 6 guardrails):
  //   1. directors.end_date IS NULL OR end_date > CURRENT_DATE - 12 months
  //   2. charity's latest T3010 financial filing (fpe) is ≥ CURRENT_DATE - 24
  //      months. A stale charity cannot have "current" directors regardless
  //      of the directors row's end_date.
  //
  // Scope: per mv_related_parties / mv_director_board_links, a person_key is
  // only counted once per bn_prefix even if they appear in multiple director
  // filings.
  {
    name: "mv_director_board_links",
    sql: `
      WITH latest_fpe AS (
        SELECT DISTINCT ON (substr(bn,1,9)) substr(bn,1,9) AS bn_prefix, fpe
        FROM t3010_financial
        ORDER BY substr(bn,1,9), fpe DESC NULLS LAST
      ),
      id_p AS (
        SELECT DISTINCT ON (substr(bn,1,9)) substr(bn,1,9) AS bn_prefix, legal_name
        FROM t3010_id
        ORDER BY substr(bn,1,9), CASE WHEN legal_name IS NOT NULL THEN 0 ELSE 1 END
      ),
      dirs AS (
        SELECT
          LOWER(TRIM(d.first_name)) || '|' ||
          LOWER(TRIM(d.last_name))  || '|' ||
          COALESCE(UPPER(TRIM(d.initials)), '') AS person_key,
          substr(d.bn,1,9) AS bn_prefix,
          d.position AS role,
          (d.initials IS NOT NULL AND TRIM(d.initials) <> '') AS disambiguated
        FROM t3010_directors d
        LEFT JOIN latest_fpe lf ON lf.bn_prefix = substr(d.bn,1,9)
        WHERE d.first_name IS NOT NULL AND d.last_name IS NOT NULL
          AND TRIM(d.first_name) <> '' AND TRIM(d.last_name) <> ''
          AND (d.end_date IS NULL OR d.end_date > CURRENT_DATE - INTERVAL '12 months')
          AND (lf.fpe IS NULL OR lf.fpe >= CURRENT_DATE - INTERVAL '24 months')
      )
      SELECT d.person_key,
             d.bn_prefix,
             COALESCE(MIN(i.legal_name), d.bn_prefix) AS charity_name,
             MIN(d.role) AS role,
             bool_or(d.disambiguated) AS disambiguated
      FROM dirs d
      LEFT JOIN id_p i ON i.bn_prefix = d.bn_prefix
      GROUP BY d.person_key, d.bn_prefix
    `,
  },

  // Challenge 6: Related Parties — same-person multi-board leads.
  // A "multi-board" row is a person_key sitting on ≥2 distinct charity
  // BN-prefixes under the current-director rule above. `disambiguated=false`
  // rows are common-name collisions and must be surfaced with a caveat.
  {
    name: "mv_director_multi_board",
    sql: `
      SELECT person_key,
             array_agg(DISTINCT bn_prefix) AS bn_prefixes,
             array_agg(DISTINCT charity_name) AS charities,
             COUNT(DISTINCT bn_prefix)::int AS board_count,
             bool_and(disambiguated) AS disambiguated
      FROM mv_director_board_links
      GROUP BY person_key
      HAVING COUNT(DISTINCT bn_prefix) >= 2
      ORDER BY board_count DESC
    `,
  },

  // Challenge 6: Related Parties — same-person BN pairs linked to actual
  // financial flows. For every pair (bn_x < bn_y) that share a director
  // person_key under mv_director_board_links, we surface:
  //   transfer_xy / transfer_yx — T3010 qualified-donee transfers (aggregate)
  //   joint_grants_count / joint_grants_value — grants where BOTH BNs received
  //     federal disbursements (sum of both sides' volume)
  //   shared_contract_value — best-effort: contracts whose normalized vendor
  //     name equals the charity's normalized legal name on either side. This
  //     is sparse (most charities don't appear as contract vendors); labeled
  //     accordingly in-UI.
  //
  // Rank signal = (transfer_xy + transfer_yx) + 0.5 * joint_grants_value.
  // Rows must be presented as leads, not proof of control — per Challenge 6
  // guardrails in CLAUDE.md.
  {
    name: "mv_governance_flow_links",
    sql: `
      WITH pairs AS (
        SELECT a.person_key,
               LEAST(a.bn_prefix, b.bn_prefix)    AS bn_x,
               GREATEST(a.bn_prefix, b.bn_prefix) AS bn_y,
               bool_and(a.disambiguated AND b.disambiguated) AS disambiguated
        FROM mv_director_board_links a
        JOIN mv_director_board_links b
          ON a.person_key = b.person_key
         AND a.bn_prefix < b.bn_prefix
        GROUP BY a.person_key, LEAST(a.bn_prefix, b.bn_prefix), GREATEST(a.bn_prefix, b.bn_prefix)
      ),
      id_p AS (
        SELECT DISTINCT ON (substr(bn,1,9)) substr(bn,1,9) AS bn_prefix, legal_name
        FROM t3010_id
        ORDER BY substr(bn,1,9), CASE WHEN legal_name IS NOT NULL THEN 0 ELSE 1 END
      ),
      txfer AS (
        SELECT substr(donor_bn,1,9) AS donor_p,
               substr(donee_bn,1,9) AS donee_p,
               SUM(total_gifts)::numeric AS amt
        FROM t3010_transfers
        WHERE donor_bn IS NOT NULL AND donee_bn IS NOT NULL
          AND total_gifts IS NOT NULL AND total_gifts > 0
        GROUP BY substr(donor_bn,1,9), substr(donee_bn,1,9)
      ),
      grants_agg AS (
        SELECT substr(recipient_business_number,1,9) AS bn_prefix,
               COUNT(*)::int AS n,
               SUM(agreement_value)::numeric AS val
        FROM grants
        WHERE recipient_business_number IS NOT NULL
          AND LENGTH(recipient_business_number) >= 9
          AND agreement_value > 0
        GROUP BY substr(recipient_business_number,1,9)
      ),
      contracts_agg AS (
        SELECT LOWER(normalize_vendor_name(vendor_name)) AS vnorm,
               SUM(effective_value)::numeric AS val
        FROM contracts
        WHERE effective_value > 0 AND vendor_name IS NOT NULL
        GROUP BY LOWER(normalize_vendor_name(vendor_name))
      )
      SELECT p.person_key,
             p.bn_x,
             p.bn_y,
             COALESCE(ix.legal_name, p.bn_x) AS name_x,
             COALESCE(iy.legal_name, p.bn_y) AS name_y,
             p.disambiguated,
             COALESCE(tx.amt, 0)::numeric AS transfer_xy,
             COALESCE(ty.amt, 0)::numeric AS transfer_yx,
             CASE WHEN gx.n IS NOT NULL AND gy.n IS NOT NULL
                  THEN (gx.n + gy.n) ELSE 0 END::int AS joint_grants_count,
             CASE WHEN gx.val IS NOT NULL AND gy.val IS NOT NULL
                  THEN (gx.val + gy.val) ELSE 0 END::numeric AS joint_grants_value,
             (COALESCE(cx.val, 0) + COALESCE(cy.val, 0))::numeric AS shared_contract_value,
             (COALESCE(tx.amt,0) + COALESCE(ty.amt,0)
              + 0.5 * CASE WHEN gx.val IS NOT NULL AND gy.val IS NOT NULL
                           THEN (gx.val + gy.val) ELSE 0 END)::numeric AS rank_score
      FROM pairs p
      LEFT JOIN id_p ix ON ix.bn_prefix = p.bn_x
      LEFT JOIN id_p iy ON iy.bn_prefix = p.bn_y
      LEFT JOIN txfer tx ON tx.donor_p = p.bn_x AND tx.donee_p = p.bn_y
      LEFT JOIN txfer ty ON ty.donor_p = p.bn_y AND ty.donee_p = p.bn_x
      LEFT JOIN grants_agg gx ON gx.bn_prefix = p.bn_x
      LEFT JOIN grants_agg gy ON gy.bn_prefix = p.bn_y
      LEFT JOIN contracts_agg cx ON cx.vnorm = LOWER(ix.legal_name)
      LEFT JOIN contracts_agg cy ON cy.vnorm = LOWER(iy.legal_name)
    `,
  },

  // Challenge 6: Related Parties — dashboard KPI stats. Under the new model
  // total_multi_board = DISTINCT person_keys sitting on ≥2 current boards.
  {
    name: "mv_related_parties_stats",
    sql: `
      SELECT COUNT(*)::int AS total_multi_board,
             COALESCE(MAX(board_count), 0)::int AS max_boards,
             COUNT(*) FILTER (WHERE disambiguated)::int AS total_disambiguated,
             (SELECT COUNT(*)::int FROM mv_governance_flow_links
              WHERE transfer_xy + transfer_yx > 0 OR joint_grants_value > 0)
               AS pairs_with_financial_edge
      FROM mv_director_multi_board
    `,
  },

  // Challenge 6: Related Parties — back-compat alias kept for any stale
  // consumers; same row shape as the legacy mv_related_parties. Superseded
  // by mv_director_multi_board + mv_governance_flow_links, but preserved so
  // `/api/ask` and any cached pages do not 404 during rollout.
  {
    name: "mv_related_parties",
    sql: `
      SELECT (split_part(person_key,'|',1)) AS first_name,
             (split_part(person_key,'|',2)) AS last_name,
             board_count::int AS org_count,
             bn_prefixes AS bns,
             charities,
             disambiguated
      FROM mv_director_multi_board
      ORDER BY board_count DESC
    `,
  },

  // Medium tables (contracts ~1.26M) ----------------------------------------

  // Challenge 4: Amendment Creep — sole-source count
  {
    name: "mv_sole_source_count",
    sql: `
      SELECT COUNT(*)::int AS n FROM contracts WHERE solicitation_procedure = 'TN'
    `,
  },

  // Challenge 4: Amendment Creep — flagged contracts, deduplicated by continuity key
  // Raw `contracts` has one row per quarterly snapshot/amendment. Collapsing by
  // (normalized_vendor, owner_org_title, original_value) and keeping the row with
  // the largest effective_value gives one row per contract relationship, so
  // downstream labels like "flagged contracts" are not inflated by amendment-history
  // rows. normalize_vendor_name() now applies the full family-rule normalization
  // (Deloitte, Microsoft, Cofomo, ...) from lib/vendor-normalization.ts.
  {
    name: "mv_amendment_creep",
    sql: `
      WITH keyed AS (
        SELECT
          -- reference_number is reused across different vendors in the
          -- proactive-disclosure feed (e.g. one Q3 ref number appears for
          -- both WORDLY and MDA SYSTEMS). Combine ref_number with the
          -- normalized vendor so amendments from one vendor are not
          -- mis-attributed to another.
          COALESCE(NULLIF(reference_number, ''), 'CKEY')
            || '|' || COALESCE(normalize_vendor_name(vendor_name), '?')
            || '|' || COALESCE(owner_org_title, '?')
            || '|' || COALESCE(original_value::text, '?') AS contract_key,
          vendor_name,
          normalize_vendor_name(vendor_name) AS normalized_vendor,
          owner_org_title,
          original_value::numeric  AS original_value,
          effective_value::numeric AS effective_value,
          amendment_value::numeric AS amendment_value,
          amendment_ratio::numeric AS amendment_ratio,
          contract_date,
          solicitation_procedure
        FROM contracts
        WHERE solicitation_procedure = 'TN'
      ),
      per_contract AS (
        SELECT
          contract_key,
          MAX(vendor_name)        AS vendor_name,
          MAX(normalized_vendor)  AS normalized_vendor,
          MAX(owner_org_title)    AS owner_org_title,
          MAX(original_value)     AS original_value,
          MAX(effective_value)    AS effective_value,
          MAX(amendment_ratio)    AS amendment_ratio,
          MAX(contract_date)      AS contract_date,
          COUNT(*) FILTER (WHERE COALESCE(amendment_value, 0) > 0)::int AS amendment_count
        FROM keyed
        GROUP BY contract_key
      ),
      vendor_amend_totals AS (
        SELECT normalized_vendor,
               SUM(amendment_count)::int AS vendor_amendment_total
        FROM per_contract
        GROUP BY normalized_vendor
      )
      SELECT pc.vendor_name,
             pc.normalized_vendor,
             pc.original_value,
             pc.effective_value,
             pc.amendment_ratio,
             pc.owner_org_title,
             pc.contract_date::text AS contract_date,
             pc.amendment_count,
             vat.vendor_amendment_total
      FROM per_contract pc
      JOIN vendor_amend_totals vat
        ON vat.normalized_vendor = pc.normalized_vendor
      -- Vendor must have at least 2 amendment events overall (across all
      -- their TN contracts) before any single contract is flagged. This
      -- removes one-off single-amendment cases from the creep cohort.
      WHERE vat.vendor_amendment_total >= 2
        AND pc.amendment_ratio > 2
        AND pc.effective_value > 500000
    `,
  },

  // Challenge 4: Contract-history reconstruction across quarterly snapshots.
  //
  // Data caveat: the `contracts` ingest does NOT include `reporting_period`,
  // so per-snapshot ordering is approximated by `contract_date`. The identity
  // key is:
  //   - reference_number when available (always populated in current load,
  //     499,959 distinct values across ~1.26M snapshot rows — this is the
  //     canonical contract identifier in proactive disclosure).
  //   - fallback continuity key (normalized_vendor, owner_org_title,
  //     original_value) otherwise.
  //
  // Missing source signals: reporting_period, limited_tendering_reason,
  // number_of_bids, country_of_vendor are not loaded in this ETL and are
  // therefore not surfaced. See ChallengePrompts.md / CLAUDE.md.
  {
    name: "mv_contract_history",
    sql: `
      WITH keyed AS (
        SELECT
          COALESCE(NULLIF(reference_number, ''),
                   'CKEY:' || COALESCE(normalize_vendor_name(vendor_name), '?') ||
                   '|' || COALESCE(owner_org_title, '?') ||
                   '|' || COALESCE(original_value::text, '?')) AS contract_key,
          normalize_vendor_name(vendor_name) AS normalized_vendor,
          vendor_name,
          owner_org_title,
          contract_date,
          original_value,
          effective_value,
          solicitation_procedure,
          amendment_ratio
        FROM contracts
        WHERE contract_date BETWEEN '2004-01-01' AND '2026-12-31'
      ),
      ordered AS (
        SELECT contract_key, normalized_vendor, owner_org_title, contract_date,
               original_value, effective_value, solicitation_procedure,
               ROW_NUMBER() OVER (PARTITION BY contract_key ORDER BY contract_date ASC, effective_value ASC NULLS FIRST) AS rn_asc,
               ROW_NUMBER() OVER (PARTITION BY contract_key ORDER BY contract_date DESC, effective_value DESC NULLS LAST) AS rn_desc,
               COUNT(*) OVER (PARTITION BY contract_key) AS snap_count
        FROM keyed
      ),
      first_row AS (
        SELECT contract_key, contract_date AS first_reported,
               solicitation_procedure AS initial_solicitation_procedure,
               original_value AS first_original_value
        FROM ordered WHERE rn_asc = 1
      ),
      last_row AS (
        SELECT contract_key, contract_date AS last_reported,
               solicitation_procedure AS final_solicitation_procedure,
               effective_value AS last_effective_value
        FROM ordered WHERE rn_desc = 1
      ),
      agg AS (
        SELECT contract_key,
               MAX(normalized_vendor) AS normalized_vendor,
               MAX(owner_org_title) AS owner_org_title,
               MAX(original_value)::numeric AS original_value,
               MAX(effective_value)::numeric AS max_effective_value,
               COUNT(*)::int AS amendment_count,
               MAX(snap_count) AS snap_count
        FROM ordered
        GROUP BY contract_key
      ),
      transitions AS (
        SELECT o.contract_key,
               string_agg(DISTINCT o.solicitation_procedure, '→'
                          ORDER BY o.solicitation_procedure) AS status_transitions
        FROM ordered o
        WHERE o.solicitation_procedure IS NOT NULL
        GROUP BY o.contract_key
      )
      SELECT a.contract_key,
             a.normalized_vendor,
             a.owner_org_title,
             f.first_reported::text AS first_reported,
             l.last_reported::text AS last_reported,
             a.original_value,
             a.max_effective_value,
             GREATEST(a.amendment_count - 1, 0) AS amendment_count,
             f.initial_solicitation_procedure,
             l.final_solicitation_procedure,
             COALESCE(t.status_transitions, '') AS status_transitions
      FROM agg a
      JOIN first_row f USING (contract_key)
      JOIN last_row l USING (contract_key)
      LEFT JOIN transitions t USING (contract_key)
      WHERE a.normalized_vendor IS NOT NULL
    `,
  },

  // Challenge 4: Competitive → sole-source transitions.
  //
  // Flags contracts whose EARLIEST observed solicitation procedure was
  // competitive (TC / TO / AC / OB / open bidding) but whose LATEST observed
  // procedure is sole-source (TN), OR whose status_transitions string
  // introduces TN after a competitive code. Source: mv_contract_history.
  //
  // This is an amendment-history signal. We filter to contracts with
  // meaningful value (max_effective_value > $100K) to suppress noise.
  {
    name: "mv_competitive_to_sole_source",
    sql: `
      SELECT contract_key,
             normalized_vendor,
             owner_org_title,
             first_reported,
             last_reported,
             original_value,
             max_effective_value,
             amendment_count,
             initial_solicitation_procedure,
             final_solicitation_procedure,
             status_transitions
      FROM mv_contract_history
      WHERE max_effective_value > 100000
        AND (
          (initial_solicitation_procedure IN ('TC','TO','AC','OB')
             AND final_solicitation_procedure = 'TN')
          OR (status_transitions LIKE '%TC%TN%'
             OR status_transitions LIKE '%TO%TN%'
             OR status_transitions LIKE '%AC%TN%'
             OR status_transitions LIKE '%OB%TN%')
        )
      ORDER BY max_effective_value DESC NULLS LAST
    `,
  },

  // Challenge 4: Threshold splitting.
  //
  // Detects vendor-department relationships with 3+ contracts in any rolling
  // 12-month window whose original_value falls JUST BELOW a common federal
  // procurement threshold. Approximate thresholds (from Treasury Board
  // Contracting Policy and TBS directives):
  //   ~$25K   — standing offer / non-competitive ceiling for many goods
  //   ~$40K   — competitive-solicitation threshold for professional services
  //   ~$400K  — NAFTA/CETA threshold for goods & services (varies by agreement)
  // "Just below" = within 20% of the threshold (threshold*0.8 .. threshold).
  //
  // Missing source signals: `limited_tendering_reason` and
  // `country_of_vendor` are not loaded and therefore cannot be used to
  // down-weight legitimate trade-agreement exclusions. Results are
  // LEADS, not findings.
  {
    name: "mv_threshold_splitting",
    sql: `
      WITH thresholds AS (
        SELECT * FROM (VALUES
          (25000.0, '~$25K'),
          (40000.0, '~$40K'),
          (400000.0, '~$400K')
        ) t(thr, label)
      ),
      near_threshold AS (
        SELECT c.id,
               normalize_vendor_name(c.vendor_name) AS normalized_vendor,
               c.owner_org_title,
               c.contract_date,
               c.original_value,
               t.thr,
               t.label
        FROM contracts c
        CROSS JOIN thresholds t
        WHERE c.original_value BETWEEN t.thr * 0.8 AND t.thr
          AND c.contract_date BETWEEN '2004-01-01' AND '2026-12-31'
          AND c.vendor_name IS NOT NULL
          AND c.owner_org_title IS NOT NULL
      ),
      windows AS (
        SELECT a.normalized_vendor,
               a.owner_org_title,
               a.label,
               a.thr,
               a.contract_date AS window_start,
               COUNT(*)::int AS contracts_in_window,
               SUM(b.original_value)::numeric AS total_in_window
        FROM near_threshold a
        JOIN near_threshold b
          ON a.normalized_vendor = b.normalized_vendor
         AND a.owner_org_title = b.owner_org_title
         AND a.label = b.label
         AND b.contract_date BETWEEN a.contract_date AND (a.contract_date + INTERVAL '12 months')
        GROUP BY a.normalized_vendor, a.owner_org_title, a.label, a.thr, a.contract_date
        HAVING COUNT(*) >= 3
      ),
      best_window AS (
        SELECT DISTINCT ON (normalized_vendor, owner_org_title, label)
               normalized_vendor, owner_org_title, label, thr,
               window_start::text AS window_start,
               contracts_in_window,
               total_in_window
        FROM windows
        ORDER BY normalized_vendor, owner_org_title, label,
                 contracts_in_window DESC, total_in_window DESC
      )
      SELECT * FROM best_window
      WHERE normalized_vendor IS NOT NULL
      ORDER BY contracts_in_window DESC, total_in_window DESC
    `,
  },

  // Challenge 4: Same-vendor follow-on sole-source work.
  //
  // After a competitive win (TC/TO/AC/OB) by vendor V for department D with
  // max_effective_value >= $100K, does V receive TN work from D in the
  // following 24 months? Emits one row per (vendor, dept, competitive_win)
  // with a count and total value of follow-on TN contracts.
  {
    name: "mv_same_vendor_followon",
    sql: `
      WITH competitive_wins AS (
        SELECT contract_key,
               normalized_vendor,
               owner_org_title,
               first_reported::date AS win_date,
               max_effective_value
        FROM mv_contract_history
        WHERE initial_solicitation_procedure IN ('TC','TO','AC','OB')
          AND max_effective_value >= 100000
          AND normalized_vendor IS NOT NULL
      ),
      followon AS (
        SELECT cw.contract_key,
               cw.normalized_vendor,
               cw.owner_org_title,
               cw.win_date::text AS win_date,
               cw.max_effective_value AS competitive_value,
               COUNT(c.id)::int AS followon_tn_count,
               COALESCE(SUM(c.effective_value), 0)::numeric AS followon_tn_value
        FROM competitive_wins cw
        LEFT JOIN contracts c
          ON normalize_vendor_name(c.vendor_name) = cw.normalized_vendor
         AND c.owner_org_title = cw.owner_org_title
         AND c.solicitation_procedure = 'TN'
         AND c.contract_date > cw.win_date
         AND c.contract_date <= cw.win_date + INTERVAL '24 months'
        GROUP BY cw.contract_key, cw.normalized_vendor, cw.owner_org_title,
                 cw.win_date, cw.max_effective_value
      )
      SELECT * FROM followon
      WHERE followon_tn_count > 0
      ORDER BY followon_tn_value DESC NULLS LAST
    `,
  },

  // Challenge 9: Contract Intelligence — commodity breakdown
  {
    name: "mv_contract_commodity",
    sql: `
      SELECT commodity_type AS code,
             COUNT(*)::int AS count,
             COALESCE(SUM(effective_value), 0)::numeric AS total_value
      FROM contracts
      WHERE commodity_type IS NOT NULL AND commodity_type != ''
      GROUP BY commodity_type
      ORDER BY total_value DESC
    `,
  },

  // Challenge 9: Contract Intelligence — solicitation breakdown
  {
    name: "mv_contract_solicitation",
    sql: `
      SELECT solicitation_procedure AS code,
             COUNT(*)::int AS count,
             COALESCE(SUM(effective_value), 0)::numeric AS total_value
      FROM contracts
      WHERE solicitation_procedure IS NOT NULL AND solicitation_procedure != ''
      GROUP BY solicitation_procedure
      ORDER BY total_value DESC
    `,
  },

  // Challenge 9: Contract Intelligence — per-year rollup, restricted to the
  // 2004–2026 window as called out in the plan. Bad dates (Excel epoch 1899,
  // typo year 202406, etc. — see CLAUDE.md "Known Data Quality Issues") are
  // filtered here.
  //
  // Data caveat: detailed commodity_code is NOT loaded (only the coarse
  // commodity_type S/G/C is available), so "category" here means the S/G/C
  // grouping. We emit one row per (fiscal_year, commodity_type), plus one
  // all-categories roll-up with commodity_type = '*ALL*'.
  {
    name: "mv_contract_yearly",
    sql: `
      WITH base AS (
        SELECT EXTRACT(YEAR FROM contract_date)::int AS fiscal_year,
               commodity_type,
               normalize_vendor_name(vendor_name) AS normalized_vendor,
               owner_org_title,
               effective_value
        FROM contracts
        WHERE contract_date BETWEEN '2004-01-01' AND '2026-12-31'
          AND effective_value > 0
      ),
      by_cat AS (
        SELECT fiscal_year,
               commodity_type AS code,
               COUNT(*)::int AS contract_count,
               COALESCE(SUM(effective_value), 0)::numeric AS total_value,
               COUNT(DISTINCT normalized_vendor)::int AS unique_vendors,
               COUNT(DISTINCT owner_org_title)::int AS distinct_departments
        FROM base
        WHERE commodity_type IS NOT NULL AND commodity_type != ''
        GROUP BY fiscal_year, commodity_type
      ),
      by_all AS (
        SELECT fiscal_year,
               '*ALL*' AS code,
               COUNT(*)::int AS contract_count,
               COALESCE(SUM(effective_value), 0)::numeric AS total_value,
               COUNT(DISTINCT normalized_vendor)::int AS unique_vendors,
               COUNT(DISTINCT owner_org_title)::int AS distinct_departments
        FROM base
        GROUP BY fiscal_year
      )
      SELECT * FROM by_cat
      UNION ALL
      SELECT * FROM by_all
      ORDER BY fiscal_year, code
    `,
  },

  // Challenge 9: Growth decomposition by (commodity_type × fiscal_year).
  //
  // Decomposition method: Bennet indicator (symmetric mean decomposition).
  //   ΔTotal_t = Q_t·P_t − Q_{t−1}·P_{t−1}
  //   where Q = contract_count, P = avg unit value = total_value / count.
  //   volume_component = (Q_t − Q_{t−1}) · (P_t + P_{t−1}) / 2
  //   unit_cost_component = (P_t − P_{t−1}) · (Q_t + Q_{t−1}) / 2
  //   volume_component + unit_cost_component ≡ ΔTotal (Bennet identity).
  //
  // Concentration is NOT algebraically part of ΔTotal (Bennet decomposes
  // a product Q·P into two additive effects), so we emit it as a separate
  // structural signal: the year-over-year change in the Herfindahl–
  // Hirschman Index on normalized vendor shares within the same category.
  {
    name: "mv_contract_growth_decomposition",
    sql: `
      WITH vendor_share AS (
        SELECT EXTRACT(YEAR FROM contract_date)::int AS fiscal_year,
               commodity_type,
               normalize_vendor_name(vendor_name) AS normalized_vendor,
               SUM(effective_value)::numeric AS vendor_value
        FROM contracts
        WHERE contract_date BETWEEN '2004-01-01' AND '2026-12-31'
          AND effective_value > 0
          AND commodity_type IS NOT NULL AND commodity_type != ''
        GROUP BY 1, 2, 3
      ),
      cat_totals AS (
        SELECT fiscal_year, commodity_type,
               SUM(vendor_value)::numeric AS cat_total
        FROM vendor_share
        GROUP BY fiscal_year, commodity_type
      ),
      hhi AS (
        SELECT vs.fiscal_year, vs.commodity_type,
               SUM(POWER((vs.vendor_value / NULLIF(ct.cat_total,0)) * 100.0, 2))::numeric AS hhi
        FROM vendor_share vs
        JOIN cat_totals ct USING (fiscal_year, commodity_type)
        GROUP BY vs.fiscal_year, vs.commodity_type
      ),
      yearly AS (
        SELECT fiscal_year, code AS commodity_type,
               contract_count, total_value
        FROM mv_contract_yearly
        WHERE code != '*ALL*'
      ),
      joined AS (
        SELECT y.commodity_type,
               y.fiscal_year,
               y.contract_count::numeric AS q,
               (y.total_value / NULLIF(y.contract_count,0))::numeric AS p,
               y.total_value,
               h.hhi
        FROM yearly y
        LEFT JOIN hhi h
          ON h.fiscal_year = y.fiscal_year AND h.commodity_type = y.commodity_type
      ),
      lagged AS (
        SELECT commodity_type, fiscal_year, q, p, total_value, hhi,
               LAG(q)  OVER (PARTITION BY commodity_type ORDER BY fiscal_year) AS q_prev,
               LAG(p)  OVER (PARTITION BY commodity_type ORDER BY fiscal_year) AS p_prev,
               LAG(total_value) OVER (PARTITION BY commodity_type ORDER BY fiscal_year) AS total_prev,
               LAG(hhi) OVER (PARTITION BY commodity_type ORDER BY fiscal_year) AS hhi_prev
        FROM joined
      )
      SELECT commodity_type,
             fiscal_year,
             total_value,
             total_prev,
             (total_value - COALESCE(total_prev, 0))::numeric AS delta_total,
             CASE WHEN total_prev IS NULL OR total_prev = 0 THEN NULL
                  ELSE ((total_value - total_prev) / total_prev * 100)
             END::numeric AS yoy_pct,
             ((q - COALESCE(q_prev, q)) * (p + COALESCE(p_prev, p)) / 2.0)::numeric AS volume_component,
             ((p - COALESCE(p_prev, p)) * (q + COALESCE(q_prev, q)) / 2.0)::numeric AS unit_cost_component,
             hhi,
             hhi_prev,
             (hhi - hhi_prev)::numeric AS concentration_change
      FROM lagged
      WHERE q_prev IS NOT NULL
      ORDER BY commodity_type, fiscal_year
    `,
  },

  // Challenge 9: Per-bucket × year decomposition. Buckets = top 30
  // (owner_org_title × commodity_type) pairs by total spend in the
  // 2004–2026 window (Excel-epoch dates already filtered upstream).
  // Captures contract_count (volume), avg_value (unit-cost proxy),
  // vendor_count, and HHI of vendor shares (concentration).
  {
    name: "mv_contract_bucket_yearly",
    sql: `
      WITH base AS (
        SELECT EXTRACT(YEAR FROM contract_date)::int AS fiscal_year,
               owner_org_title,
               commodity_type,
               normalize_vendor_name(vendor_name) AS norm_vendor,
               effective_value
        FROM contracts
        WHERE contract_date BETWEEN '2004-01-01' AND '2026-12-31'
          AND effective_value > 0
          AND commodity_type IN ('S','G','C')
          AND owner_org_title IS NOT NULL AND owner_org_title <> ''
      ),
      top_buckets AS (
        SELECT owner_org_title, commodity_type
        FROM base
        GROUP BY 1,2
        ORDER BY SUM(effective_value) DESC NULLS LAST
        LIMIT 30
      ),
      filtered AS (
        SELECT b.* FROM base b
        JOIN top_buckets t USING (owner_org_title, commodity_type)
      ),
      vendor_share AS (
        SELECT fiscal_year, owner_org_title, commodity_type, norm_vendor,
               SUM(effective_value)::numeric AS vv
        FROM filtered
        GROUP BY 1,2,3,4
      ),
      totals AS (
        SELECT fiscal_year, owner_org_title, commodity_type,
               SUM(vv)::numeric AS bucket_total,
               COUNT(*)::int AS vendor_count
        FROM vendor_share
        GROUP BY 1,2,3
      ),
      hhi_calc AS (
        SELECT vs.fiscal_year, vs.owner_org_title, vs.commodity_type,
               SUM(POWER((vs.vv / NULLIF(t.bucket_total,0)) * 100.0, 2))::numeric AS hhi
        FROM vendor_share vs
        JOIN totals t USING (fiscal_year, owner_org_title, commodity_type)
        GROUP BY 1,2,3
      ),
      counts AS (
        SELECT fiscal_year, owner_org_title, commodity_type,
               COUNT(*)::int AS contract_count,
               SUM(effective_value)::numeric AS total_value
        FROM filtered
        GROUP BY 1,2,3
      )
      SELECT c.fiscal_year,
             c.owner_org_title,
             c.commodity_type,
             c.contract_count,
             c.total_value,
             (c.total_value / NULLIF(c.contract_count, 0))::numeric AS avg_value,
             t.vendor_count,
             h.hhi
      FROM counts c
      JOIN totals t USING (fiscal_year, owner_org_title, commodity_type)
      LEFT JOIN hhi_calc h USING (fiscal_year, owner_org_title, commodity_type)
    `,
  },

  // Challenge 9: YoY deltas on the top-30 bucket × year matrix.
  // delta_total_pct = total spend growth, delta_count_pct = volume growth,
  // delta_avg_pct = average-price (unit-cost proxy) growth,
  // delta_hhi = absolute change in vendor concentration index.
  {
    name: "mv_contract_yoy_decomposition",
    sql: `
      WITH lagged AS (
        SELECT fiscal_year, owner_org_title, commodity_type,
               contract_count, total_value, avg_value, vendor_count, hhi,
               LAG(total_value)    OVER (PARTITION BY owner_org_title, commodity_type ORDER BY fiscal_year) AS total_prev,
               LAG(contract_count) OVER (PARTITION BY owner_org_title, commodity_type ORDER BY fiscal_year) AS count_prev,
               LAG(avg_value)      OVER (PARTITION BY owner_org_title, commodity_type ORDER BY fiscal_year) AS avg_prev,
               LAG(hhi)            OVER (PARTITION BY owner_org_title, commodity_type ORDER BY fiscal_year) AS hhi_prev
        FROM mv_contract_bucket_yearly
      )
      SELECT fiscal_year, owner_org_title, commodity_type,
             contract_count, total_value, avg_value, vendor_count, hhi,
             total_prev, count_prev, avg_prev, hhi_prev,
             CASE WHEN total_prev IS NULL OR total_prev = 0 THEN NULL
                  ELSE ((total_value - total_prev) / total_prev * 100) END::numeric AS delta_total_pct,
             CASE WHEN count_prev IS NULL OR count_prev = 0 THEN NULL
                  ELSE ((contract_count::numeric - count_prev) / count_prev * 100) END::numeric AS delta_count_pct,
             CASE WHEN avg_prev IS NULL OR avg_prev = 0 THEN NULL
                  ELSE ((avg_value - avg_prev) / avg_prev * 100) END::numeric AS delta_avg_pct,
             (hhi - hhi_prev)::numeric AS delta_hhi
      FROM lagged
    `,
  },

  // Challenge 5: Vendor Concentration — service contract totals (count, value, unique vendors)
  // unique_vendors is the FULL-MARKET COUNT(DISTINCT normalized_vendor) across all service
  // contracts (with family-rule normalization), not the top-50 slice used for display.
  {
    name: "mv_service_contracts_count",
    sql: `
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM(effective_value), 0)::numeric AS total_value,
             COUNT(DISTINCT normalize_vendor_name(vendor_name))::int AS unique_vendors
      FROM contracts WHERE commodity_type = 'S' AND effective_value > 0
    `,
  },

  // Challenge 5: Vendor Concentration — top vendors (services, full market).
  // Family-rule normalization collapses Deloitte/Microsoft/Cofomo variants.
  {
    name: "mv_vendor_concentration",
    sql: `
      SELECT normalize_vendor_name(vendor_name) AS norm_vendor,
             MAX(vendor_name) AS display_name,
             SUM(effective_value)::numeric AS total_value,
             COUNT(*)::int AS contract_count
      FROM contracts
      WHERE commodity_type = 'S' AND effective_value > 0
        AND normalize_vendor_name(vendor_name) IS NOT NULL
      GROUP BY normalize_vendor_name(vendor_name)
      ORDER BY total_value DESC
      LIMIT 50
    `,
  },

  // Challenge 5: Vendor-name normalization warnings — clusters of distinct
  // normalized_vendor values whose raw vendor_name strings collapse to the
  // same alpha-only stripped key (after dropping common legal suffixes).
  // Each cluster is a candidate near-duplicate that the family-rule
  // normalization in lib/vendor-normalization.ts did NOT catch — e.g.
  // "IRVING SHIPBUILDING" vs "IRVING SHIP BUILDING", "ELLISDON" vs
  // "ELLIS DON", "IMP GROUP" vs "I M P GROUP". Surfacing these tells the
  // reader that vendor concentration is likely UNDER-stated for this name.
  // Filtered to clusters with cluster_spend > $1M and length(strip_key) >= 4
  // to suppress noise. These are leads, not findings — some clusters are
  // genuine distinct entities that happen to strip to the same key.
  {
    name: "mv_vendor_name_dupes",
    sql: `
      WITH vendor_agg AS (
        SELECT normalize_vendor_name(vendor_name) AS norm_vendor,
               vendor_name,
               SUM(effective_value)::numeric AS spend,
               COUNT(*)::int AS contracts
        FROM contracts
        WHERE effective_value > 0
          AND vendor_name IS NOT NULL
          AND normalize_vendor_name(vendor_name) IS NOT NULL
        GROUP BY normalize_vendor_name(vendor_name), vendor_name
      ),
      keyed AS (
        SELECT
          norm_vendor, vendor_name, spend, contracts,
          regexp_replace(
            regexp_replace(
              UPPER(vendor_name),
              '\\s+(INC|INCORPORATED|LTD|LTEE|LIMITED|LIMITEE|CORP|CORPORATION|LLC|LLP|ULC|CO|COMPANY|GROUP|GROUPE|HOLDINGS|CANADA|CDA|CDN|GP|LP)\\.?\\s*$',
              '', 'gi'
            ),
            '[^A-Z0-9]', '', 'g'
          ) AS strip_key
        FROM vendor_agg
      ),
      clusters AS (
        SELECT
          strip_key,
          COUNT(DISTINCT norm_vendor)::int AS distinct_norm,
          COUNT(*)::int AS variant_count,
          SUM(spend)::numeric AS cluster_spend,
          SUM(contracts)::int AS cluster_contracts,
          (array_agg(DISTINCT norm_vendor))[1:6] AS norm_vendors,
          (array_agg(vendor_name ORDER BY spend DESC))[1:6] AS sample_names,
          (array_agg(spend ORDER BY spend DESC))[1:6] AS sample_spend
        FROM keyed
        WHERE strip_key <> '' AND length(strip_key) >= 4
        GROUP BY strip_key
        HAVING COUNT(DISTINCT norm_vendor) > 1 AND SUM(spend) > 1000000
      )
      SELECT strip_key, distinct_norm, variant_count, cluster_spend, cluster_contracts,
             norm_vendors, sample_names, sample_spend
      FROM clusters
      ORDER BY cluster_spend DESC
      LIMIT 200
    `,
  },

  // Challenge 5: Vendor concentration BY CATEGORY (commodity_type S/G/C).
  //
  // Data caveat: detailed commodity_code is NOT loaded, only the coarse
  // commodity_type S(ervices) / G(oods) / C(onstruction). Segments here are
  // therefore 3 buckets, not the full 400+ GSIN codes. HHI and CR4/CR10 are
  // computed on the FULL vendor list within each segment (not top-50).
  //
  // Row schema: one row per (segment, rank_of_vendor_in_segment <= 20) plus
  // one "*SEGMENT*" summary row per segment carrying HHI, CR4, CR10, and
  // segment totals. Consumers filter on norm_vendor = '*SEGMENT*' for
  // summaries.
  {
    name: "mv_vendor_concentration_by_category",
    sql: `
      WITH vendor_totals AS (
        SELECT commodity_type AS segment,
               normalize_vendor_name(vendor_name) AS norm_vendor,
               MAX(vendor_name) AS display_name,
               SUM(effective_value)::numeric AS total_value,
               COUNT(*)::int AS contract_count
        FROM contracts
        WHERE commodity_type IS NOT NULL AND commodity_type != ''
          AND effective_value > 0
          AND normalize_vendor_name(vendor_name) IS NOT NULL
        GROUP BY commodity_type, normalize_vendor_name(vendor_name)
      ),
      seg_totals AS (
        SELECT segment,
               SUM(total_value)::numeric AS seg_total_value,
               SUM(contract_count)::int AS seg_contract_count,
               COUNT(*)::int AS seg_vendor_count
        FROM vendor_totals
        GROUP BY segment
      ),
      ranked AS (
        SELECT vt.*,
               ROW_NUMBER() OVER (PARTITION BY vt.segment ORDER BY vt.total_value DESC) AS rnk,
               (vt.total_value / NULLIF(st.seg_total_value,0) * 100.0) AS share_pct,
               st.seg_total_value, st.seg_contract_count, st.seg_vendor_count
        FROM vendor_totals vt JOIN seg_totals st USING (segment)
      ),
      hhi AS (
        SELECT segment, SUM(share_pct * share_pct)::numeric AS hhi
        FROM ranked GROUP BY segment
      ),
      cr AS (
        SELECT segment,
               SUM(CASE WHEN rnk <= 4  THEN share_pct ELSE 0 END)::numeric AS cr4,
               SUM(CASE WHEN rnk <= 10 THEN share_pct ELSE 0 END)::numeric AS cr10
        FROM ranked GROUP BY segment
      ),
      top_rows AS (
        SELECT segment, norm_vendor, display_name, total_value, contract_count,
               share_pct, rnk,
               seg_total_value, seg_contract_count, seg_vendor_count,
               NULL::numeric AS hhi, NULL::numeric AS cr4, NULL::numeric AS cr10
        FROM ranked WHERE rnk <= 20
      ),
      summary_rows AS (
        SELECT st.segment,
               '*SEGMENT*' AS norm_vendor,
               NULL::text AS display_name,
               st.seg_total_value AS total_value,
               st.seg_contract_count AS contract_count,
               NULL::numeric AS share_pct,
               0 AS rnk,
               st.seg_total_value, st.seg_contract_count, st.seg_vendor_count,
               h.hhi, cr.cr4, cr.cr10
        FROM seg_totals st
        LEFT JOIN hhi h USING (segment)
        LEFT JOIN cr USING (segment)
      )
      SELECT * FROM summary_rows
      UNION ALL
      SELECT * FROM top_rows
      ORDER BY segment, rnk
    `,
  },

  // Challenge 5: Vendor concentration BY DEPARTMENT (owner_org_title).
  // Same shape as _by_category. Summary rows have norm_vendor='*SEGMENT*'.
  {
    name: "mv_vendor_concentration_by_department",
    sql: `
      WITH vendor_totals AS (
        SELECT owner_org_title AS segment,
               normalize_vendor_name(vendor_name) AS norm_vendor,
               MAX(vendor_name) AS display_name,
               SUM(effective_value)::numeric AS total_value,
               COUNT(*)::int AS contract_count
        FROM contracts
        WHERE owner_org_title IS NOT NULL AND owner_org_title != ''
          AND commodity_type = 'S'
          AND effective_value > 0
          AND normalize_vendor_name(vendor_name) IS NOT NULL
        GROUP BY owner_org_title, normalize_vendor_name(vendor_name)
      ),
      seg_totals AS (
        SELECT segment,
               SUM(total_value)::numeric AS seg_total_value,
               SUM(contract_count)::int AS seg_contract_count,
               COUNT(*)::int AS seg_vendor_count
        FROM vendor_totals
        GROUP BY segment
      ),
      ranked AS (
        SELECT vt.*,
               ROW_NUMBER() OVER (PARTITION BY vt.segment ORDER BY vt.total_value DESC) AS rnk,
               (vt.total_value / NULLIF(st.seg_total_value,0) * 100.0) AS share_pct,
               st.seg_total_value, st.seg_contract_count, st.seg_vendor_count
        FROM vendor_totals vt JOIN seg_totals st USING (segment)
      ),
      hhi AS (
        SELECT segment, SUM(share_pct * share_pct)::numeric AS hhi
        FROM ranked GROUP BY segment
      ),
      cr AS (
        SELECT segment,
               SUM(CASE WHEN rnk <= 4  THEN share_pct ELSE 0 END)::numeric AS cr4,
               SUM(CASE WHEN rnk <= 10 THEN share_pct ELSE 0 END)::numeric AS cr10
        FROM ranked GROUP BY segment
      ),
      top_rows AS (
        SELECT segment, norm_vendor, display_name, total_value, contract_count,
               share_pct, rnk,
               seg_total_value, seg_contract_count, seg_vendor_count,
               NULL::numeric AS hhi, NULL::numeric AS cr4, NULL::numeric AS cr10
        FROM ranked WHERE rnk <= 20
      ),
      summary_rows AS (
        SELECT st.segment,
               '*SEGMENT*' AS norm_vendor,
               NULL::text AS display_name,
               st.seg_total_value AS total_value,
               st.seg_contract_count AS contract_count,
               NULL::numeric AS share_pct,
               0 AS rnk,
               st.seg_total_value, st.seg_contract_count, st.seg_vendor_count,
               h.hhi, cr.cr4, cr.cr10
        FROM seg_totals st
        LEFT JOIN hhi h USING (segment)
        LEFT JOIN cr USING (segment)
      )
      SELECT * FROM summary_rows
      UNION ALL
      SELECT * FROM top_rows
      ORDER BY segment, rnk
    `,
  },

  // Challenge 5: Vendor concentration BY REGION — SKIPPED.
  //
  // The `contracts` ingest does NOT include buyer_region, delivery_region,
  // or any postal-code / FSA column. There is no reliable way to derive a
  // region segment from the currently loaded fields. See
  // ChallengePrompts.md and CLAUDE.md.
  //
  // If the ingest later adds region fields, mirror the _by_category /
  // _by_department shape above (segment = region) and add a matching
  // unique index in the mvIndexes block.

  // Large tables (grants ~1.275M) — slowest, run last -----------------------

  // Shared: grants summary
  {
    name: "mv_grants_summary",
    sql: `
      SELECT COUNT(*)::int AS total_grants,
             COALESCE(SUM(agreement_value), 0)::numeric AS total_value
      FROM grants
    `,
  },

  // Shared: table counts (includes grants + contracts scans)
  {
    name: "mv_table_counts",
    sql: `
      SELECT 'contracts' AS tbl, COUNT(*)::int AS n FROM contracts
      UNION ALL SELECT 'grants', COUNT(*)::int FROM grants
      UNION ALL SELECT 't3010_id', COUNT(*)::int FROM t3010_id
      UNION ALL SELECT 't3010_financial', COUNT(*)::int FROM t3010_financial
      UNION ALL SELECT 't3010_directors', COUNT(*)::int FROM t3010_directors
      UNION ALL SELECT 't3010_transfers', COUNT(*)::int FROM t3010_transfers
      UNION ALL SELECT 'wrongdoing', COUNT(*)::int FROM wrongdoing
    `,
  },

  // Challenge 7: Policy Misalignment — actual-vs-target gap analysis
  // Joins user-curated federal commitments (policy_targets table) against
  // grants matched by per-target regex on prog_name_en/description_en.
  // policy_targets is seeded by scripts/setup-policy-targets.cjs.
  {
    name: "mv_policy_alignment",
    sql: `
      SELECT
        pt.id, pt.name, pt.department, pt.announced_year,
        pt.total_commitment_cad, pt.period_years, pt.annual_target,
        pt.target_start, pt.target_end,
        pt.description, pt.source_url, pt.delivery_note, pt.keywords,
        COALESCE(g.total_matched, 0)::numeric AS total_matched,
        COALESCE(g.grant_count, 0)::int       AS grant_count,
        COALESCE(g.years_observed, 0)::int    AS years_observed,
        CASE WHEN COALESCE(g.years_observed, 0) > 0
             THEN g.total_matched / g.years_observed
             ELSE 0 END::numeric AS annual_actual,
        (pt.annual_target -
          CASE WHEN COALESCE(g.years_observed, 0) > 0
               THEN g.total_matched / g.years_observed
               ELSE 0 END
        )::numeric AS annual_gap,
        CASE WHEN pt.annual_target > 0 THEN
          100.0 * (pt.annual_target -
            CASE WHEN COALESCE(g.years_observed, 0) > 0
                 THEN g.total_matched / g.years_observed
                 ELSE 0 END
          ) / pt.annual_target
        ELSE 0 END::numeric AS gap_pct
      FROM policy_targets pt
      LEFT JOIN LATERAL (
        SELECT
          SUM(gr.agreement_value) AS total_matched,
          COUNT(*)                AS grant_count,
          GREATEST(
            1,
            EXTRACT(YEAR FROM MAX(gr.agreement_start_date))::int
              - EXTRACT(YEAR FROM MIN(gr.agreement_start_date))::int + 1
          ) AS years_observed
        FROM grants gr
        WHERE gr.agreement_start_date >= pt.target_start
          AND gr.agreement_start_date <  pt.target_end
          AND gr.agreement_value IS NOT NULL
          AND (gr.prog_name_en ~* pt.match_regex OR gr.description_en ~* pt.match_regex)
      ) g ON TRUE
    `,
  },

  // Challenge 7: Policy Misalignment — single-pass CASE classification
  {
    name: "mv_policy_buckets",
    sql: `
      SELECT bucket,
             COALESCE(SUM(agreement_value), 0)::numeric AS total_value,
             COUNT(*)::int AS grant_count
      FROM (
        SELECT agreement_value,
          CASE
            WHEN prog_name_en ~* 'climate|environment|green|emissions|clean energy|ecological|conservation|biodiversity|pollution|sustainable' THEN 'Climate/Environment'
            WHEN prog_name_en ~* 'housing|homelessness|shelter|affordable|unhoused' THEN 'Housing'
            WHEN prog_name_en ~* 'health|medical|hospital|pandemic|nursing|addiction|opioid|substance' THEN 'Healthcare'
            WHEN prog_name_en ~* 'indigenous|first nations|inuit|reconciliation|aboriginal|treaty' THEN 'Indigenous'
            WHEN prog_name_en ~* 'innovation|economic|business|trade|technology|digital|startup|entrepreneur|research|science' THEN 'Innovation/Economy'
            WHEN prog_name_en ~* 'agriculture|farm|agri|food|livestock|dairy|crop|fishery|aquaculture' THEN 'Agriculture'
            ELSE 'Other'
          END AS bucket
        FROM grants
      ) classified
      GROUP BY bucket
    `,
  },

  // Challenge 8: Duplicative Funding — stats
  {
    name: "mv_duplicative_stats",
    sql: `
      SELECT COUNT(*)::int AS total_multi_dept,
             MAX(dept_count)::int AS max_depts,
             COALESCE(SUM(total_value), 0)::numeric AS total_value
      FROM (
        SELECT COUNT(DISTINCT owner_org_title)::int AS dept_count,
               COALESCE(SUM(agreement_value), 0)::numeric AS total_value
        FROM grants
        WHERE recipient_legal_name IS NOT NULL AND recipient_legal_name != ''
          AND owner_org_title IS NOT NULL AND owner_org_title != ''
        GROUP BY UPPER(recipient_legal_name)
        HAVING COUNT(DISTINCT owner_org_title) >= 2
      ) sub
    `,
  },

  // Challenge 8: Duplicative Funding — top recipients
  {
    name: "mv_duplicative_funding",
    sql: `
      SELECT UPPER(recipient_legal_name) AS uname,
             MIN(recipient_legal_name) AS name,
             COUNT(DISTINCT owner_org_title)::int AS dept_count,
             COUNT(*)::int AS grant_count,
             COALESCE(SUM(agreement_value), 0)::numeric AS total_value,
             string_agg(DISTINCT owner_org_title, '; ' ORDER BY owner_org_title) AS departments
      FROM grants
      WHERE recipient_legal_name IS NOT NULL AND recipient_legal_name != ''
        AND owner_org_title IS NOT NULL AND owner_org_title != ''
      GROUP BY UPPER(recipient_legal_name)
      HAVING COUNT(DISTINCT owner_org_title) >= 2
      ORDER BY dept_count DESC, total_value DESC
    `,
  },

  // Challenge 8 — purpose-level overlap. Same recipient + same program name
  // across 2+ federal departments. Much tighter than mv_duplicative_funding
  // (which only requires shared recipient identity). Surfaces cases like
  // three Regional Economic Development agencies funding the same recipient
  // under the same "Regional Economic Growth Through Innovation" program —
  // the exact "multiple levels / bodies funding the same purpose" pattern
  // Challenge 8 asks about.
  {
    name: "mv_purpose_overlap",
    sql: `
      WITH norm AS (
        SELECT UPPER(TRIM(recipient_legal_name)) AS recip_key,
               MAX(recipient_legal_name) AS recipient_legal_name,
               UPPER(TRIM(prog_name_en)) AS prog_key,
               MAX(prog_name_en) AS prog_name_en,
               owner_org_title,
               SUM(agreement_value)::numeric AS dept_value,
               COUNT(*)::int AS dept_grant_count,
               MIN(agreement_start_date) AS first_date,
               MAX(agreement_start_date) AS last_date
        FROM grants
        WHERE recipient_legal_name IS NOT NULL
          AND prog_name_en IS NOT NULL
          AND agreement_value > 0
          AND owner_org_title IS NOT NULL
        GROUP BY UPPER(TRIM(recipient_legal_name)), UPPER(TRIM(prog_name_en)), owner_org_title
      )
      SELECT recip_key,
             MAX(recipient_legal_name) AS recipient_legal_name,
             prog_key,
             MAX(prog_name_en) AS prog_name_en,
             COUNT(DISTINCT owner_org_title)::int AS dept_count,
             SUM(dept_grant_count)::int AS grant_count,
             SUM(dept_value)::numeric AS total_value,
             STRING_AGG(DISTINCT owner_org_title, ' | ') AS departments,
             MIN(first_date) AS first_date,
             MAX(last_date) AS last_date
      FROM norm
      GROUP BY recip_key, prog_key
      HAVING COUNT(DISTINCT owner_org_title) >= 2
    `,
  },

  // Challenge 8 — purpose-theme cluster. Same recipient (BN prefix where
  // available, name fallback otherwise) receiving grants tagged with the
  // SAME normalized policy theme (housing / mental_health / indigenous /
  // climate / research / etc.) from 2+ departments AND under 2+ distinct
  // program names. Catches purpose-overlap that mv_purpose_overlap misses
  // because the program names differ even though the policy purpose is
  // identical (e.g. multiple departments funding the same recipient for
  // "housing" under different program brands).
  {
    name: "mv_purpose_cluster",
    sql: `
      WITH classified AS (
        SELECT
          COALESCE(NULLIF(substr(recipient_business_number, 1, 9), ''),
                   'NM:' || UPPER(TRIM(recipient_legal_name))) AS recip_key,
          CASE WHEN recipient_business_number IS NOT NULL
                    AND length(recipient_business_number) >= 9
               THEN substr(recipient_business_number, 1, 9) END AS bn_prefix,
          recipient_legal_name,
          owner_org_title,
          prog_name_en,
          agreement_value,
          CASE
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(housing|homeless|shelter|rent supplement|affordable home|co-?op housing)\\M' THEN 'housing'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(mental health|psychiatric|suicide|addiction|substance use|opioid)\\M' THEN 'mental_health'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(indigenous|first nations?|inuit|m[eé]tis|aboriginal|reconciliation)\\M' THEN 'indigenous'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(climate|emissions?|greenhouse|net.?zero|decarboniz|clean energy|renewable energy)\\M' THEN 'climate'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(research|innovation|scientif|laboratory|nserc|cihr|sshrc|r&d)\\M' THEN 'research'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(child ?care|early learning|early childhood)\\M' THEN 'child_care'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(immigrant|newcomer|settlement services|refugee|asylum)\\M' THEN 'settlement'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(official languages?|francoph)\\M' THEN 'official_languages'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\mveterans?\\M' THEN 'veterans'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(seniors?|elderly|aging)\\M' THEN 'seniors'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\myouth\\M' THEN 'youth'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(women|gender|gender-based violence|domestic violence)\\M' THEN 'women_gender'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(skills|workforce|apprentice|employment program)\\M' THEN 'skills_employment'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(agricultur|farm|food security)\\M' THEN 'agriculture'
            WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
                 ~ '\\m(arts|culture|heritage|museum|festival)\\M' THEN 'arts_culture'
            ELSE NULL
          END AS purpose_cluster
        FROM grants
        WHERE recipient_legal_name IS NOT NULL
          AND agreement_value > 0
          AND owner_org_title IS NOT NULL
          AND prog_name_en IS NOT NULL
      )
      SELECT
        recip_key,
        MAX(bn_prefix) AS bn_prefix,
        MAX(recipient_legal_name) AS recipient_legal_name,
        purpose_cluster,
        COUNT(DISTINCT owner_org_title)::int AS n_departments,
        COUNT(DISTINCT prog_name_en)::int AS n_programs,
        COUNT(*)::int AS grant_count,
        SUM(agreement_value)::numeric AS total_value,
        STRING_AGG(DISTINCT owner_org_title, ' | ' ORDER BY owner_org_title) AS departments,
        jsonb_agg(DISTINCT jsonb_build_object('dept', owner_org_title, 'program', prog_name_en))
          FILTER (WHERE owner_org_title IS NOT NULL) AS programs
      FROM classified
      WHERE purpose_cluster IS NOT NULL
      GROUP BY recip_key, purpose_cluster
      HAVING COUNT(DISTINCT owner_org_title) >= 2
         AND COUNT(DISTINCT prog_name_en) >= 2
    `,
  },
];

// Additional indexes for composite/expression queries
const EXTRA_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_t3010_xfer_pair ON t3010_transfers (donor_bn, donee_bn)",
  "CREATE INDEX IF NOT EXISTS idx_t3010_xfer_pair_rev ON t3010_transfers (donee_bn, donor_bn)",
  "CREATE INDEX IF NOT EXISTS idx_contracts_sole_source ON contracts (solicitation_procedure, amendment_ratio, effective_value) WHERE solicitation_procedure = 'TN'",
  "CREATE INDEX IF NOT EXISTS idx_grants_recipient_upper ON grants (UPPER(recipient_legal_name))",
  "CREATE INDEX IF NOT EXISTS idx_directors_bn_prefix ON t3010_directors (substr(bn, 1, 9))",
  // Expression index on normalize_vendor_name — keeps MV rebuilds fast and
  // supports ad-hoc vendor lookups from API routes.
  "CREATE INDEX IF NOT EXISTS idx_contracts_norm_vendor ON contracts (normalize_vendor_name(vendor_name))",
  "CREATE INDEX IF NOT EXISTS idx_contracts_ref_number ON contracts (reference_number)",
  "CREATE INDEX IF NOT EXISTS idx_contracts_date_range ON contracts (contract_date) WHERE contract_date BETWEEN '2004-01-01' AND '2026-12-31'",
];

// Postgres function that implements the canonical vendor-name normalization.
// See lib/vendor-normalization.ts for the one source of truth for the rules;
// the SQL body is generated from that module so TS and DB stay aligned.
const VENDOR_NORMALIZATION_DDL = `
  CREATE OR REPLACE FUNCTION normalize_vendor_name(text)
  RETURNS text
  LANGUAGE plpgsql
  IMMUTABLE
  PARALLEL SAFE
  AS $func$
  ${NORMALIZE_VENDOR_SQL_BODY}
  $func$;
`;

async function getClient(): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 600000, // 10 min per statement
    query_timeout: 600000,
  });
  // Prevent unhandled 'error' events from crashing the process
  client.on("error", (err) => {
    console.error(`  [connection error: ${err.message.substring(0, 60)}]`);
  });
  await client.connect();
  // TCP keepalive to prevent Azure from killing idle connections
  try {
    const stream = (client as unknown as { connection: { stream: { setKeepAlive: (on: boolean, ms: number) => void } } })
      .connection?.stream;
    stream?.setKeepAlive?.(true, 5000);
  } catch { /* ignore if not available */ }
  return client;
}

// Auxiliary tables that the optimizer owns in addition to the MVs.
// Challenge 10 adverse-media pipeline: these tables are populated by
// scripts/ingest-adverse-media.ts. Declaring them here keeps the schema
// reproducible from a single entrypoint.
const ADVERSE_MEDIA_DDL = `
  CREATE TABLE IF NOT EXISTS adverse_media_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT,
    category TEXT NOT NULL,
    description TEXT,
    last_fetched_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS adverse_media (
    id BIGSERIAL PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES adverse_media_sources(id),
    source_record_id TEXT,
    severity TEXT NOT NULL,
    entity_name_raw TEXT NOT NULL,
    entity_name_normalized TEXT NOT NULL,
    bn_prefix_guess TEXT,
    source_url TEXT,
    published_at DATE,
    summary TEXT,
    raw JSONB,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_adverse_media_src_rec
    ON adverse_media (source_id, source_record_id);
  CREATE INDEX IF NOT EXISTS idx_adverse_media_norm
    ON adverse_media (entity_name_normalized);
  CREATE INDEX IF NOT EXISTS idx_adverse_media_severity
    ON adverse_media (severity);
  CREATE INDEX IF NOT EXISTS idx_adverse_media_bn_prefix
    ON adverse_media (bn_prefix_guess);

  CREATE TABLE IF NOT EXISTS adverse_media_matches (
    id BIGSERIAL PRIMARY KEY,
    adverse_media_id BIGINT NOT NULL REFERENCES adverse_media(id) ON DELETE CASCADE,
    matched_source TEXT NOT NULL,
    matched_entity_name TEXT NOT NULL,
    matched_bn TEXT,
    match_method TEXT NOT NULL,
    confidence NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_am_matches_adv
    ON adverse_media_matches (adverse_media_id);
  CREATE INDEX IF NOT EXISTS idx_am_matches_name
    ON adverse_media_matches (matched_entity_name);
  CREATE INDEX IF NOT EXISTS idx_am_matches_bn
    ON adverse_media_matches (matched_bn);
  CREATE INDEX IF NOT EXISTS idx_am_matches_method
    ON adverse_media_matches (match_method);
`;

async function main() {
  console.log("=== OpenGov DB Optimization ===\n");

  // Ensure auxiliary tables exist (safe to run repeatedly).
  {
    const client = await getClient();
    try {
      await client.query(ADVERSE_MEDIA_DDL);
      console.log("  ✅ adverse_media* tables ensured");
    } catch (e) {
      console.error(`  ⚠️ adverse_media DDL: ${(e as Error).message.substring(0, 120)}`);
    }
    try {
      await client.query(VENDOR_NORMALIZATION_DDL);
      console.log("  ✅ normalize_vendor_name() function ensured");
    } catch (e) {
      console.error(`  ⚠️ normalize_vendor_name DDL: ${(e as Error).message.substring(0, 200)}`);
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  }

  // Use a fresh connection per MV to survive Azure connection resets
  console.log(`Creating ${MATERIALIZED_VIEWS.length} materialized views...\n`);
  const created: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  // Check which MVs already exist (for resumability)
  let existingMVs = new Set<string>();
  {
    const checkClient = await getClient();
    try {
      const res = await checkClient.query(`SELECT matviewname FROM pg_matviews WHERE schemaname = 'public'`);
      existingMVs = new Set(res.rows.map((r: { matviewname: string }) => r.matviewname));
    } catch { /* ignore */ }
    try { await checkClient.end(); } catch { /* ignore */ }
  }

  for (const mv of MATERIALIZED_VIEWS) {
    // Skip if already created in a prior run (use --force to rebuild all)
    if (existingMVs.has(mv.name) && !process.argv.includes("--force")) {
      console.log(`  ⏭️  ${mv.name}: already exists (use --force to rebuild)`);
      skipped.push(mv.name);
      continue;
    }

    const start = Date.now();
    let client: pg.Client | null = null;
    try {
      client = await getClient();
      await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${mv.name} CASCADE`);
      await client.query(`CREATE MATERIALIZED VIEW ${mv.name} AS ${mv.sql}`);
      const countRes = await client.query(`SELECT COUNT(*)::int AS n FROM ${mv.name}`);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  ✅ ${mv.name}: ${countRes.rows[0].n.toLocaleString()} rows (${elapsed}s)`);
      created.push(mv.name);
    } catch (e) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`  ❌ ${mv.name}: ${(e as Error).message.substring(0, 120)} (${elapsed}s)`);
      failed.push(mv.name);
    } finally {
      try { await client?.end(); } catch { /* ignore */ }
    }
  }

  // Create unique indexes on MVs
  console.log("\nCreating indexes on materialized views...");
  const mvIndexes = [
    // (bn, cohort) is unique since cessation vs dependency_risk are mutually
    // exclusive on FPE age — see mv_zombie_recipients definition.
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_zombie_bn ON mv_zombie_recipients (bn, cohort)",
    "CREATE INDEX IF NOT EXISTS mv_zombie_cohort ON mv_zombie_recipients (cohort)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_ghost_bn ON mv_ghost_capacity (bn)",
    "CREATE INDEX IF NOT EXISTS mv_ghost_score ON mv_ghost_capacity (ghost_score DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_reciprocals_pair ON mv_funding_reciprocals (donor_bn, donee_bn)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_tri_key ON mv_funding_triangles (bn_a, bn_b, bn_c)",
    "CREATE INDEX IF NOT EXISTS mv_tri_total ON mv_funding_triangles (total_circled DESC NULLS LAST)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_chain4_key ON mv_funding_chains_4 (bn_a, bn_b, bn_c, bn_d)",
    "CREATE INDEX IF NOT EXISTS mv_chain4_total ON mv_funding_chains_4 (total_circled DESC NULLS LAST)",
    "CREATE INDEX IF NOT EXISTS mv_loop_class_type ON mv_funding_loop_classification (classification, loop_type)",
    "CREATE INDEX IF NOT EXISTS mv_loop_class_total ON mv_funding_loop_classification (total_circled DESC NULLS LAST)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_dbl_key ON mv_director_board_links (person_key, bn_prefix)",
    "CREATE INDEX IF NOT EXISTS mv_dbl_bn ON mv_director_board_links (bn_prefix)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_dmb_key ON mv_director_multi_board (person_key)",
    "CREATE INDEX IF NOT EXISTS mv_dmb_count ON mv_director_multi_board (board_count DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_gfl_key ON mv_governance_flow_links (person_key, bn_x, bn_y)",
    "CREATE INDEX IF NOT EXISTS mv_gfl_rank ON mv_governance_flow_links (rank_score DESC NULLS LAST)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_vendor_norm ON mv_vendor_concentration (norm_vendor)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_policy_bucket ON mv_policy_buckets (bucket)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_policy_alignment_id ON mv_policy_alignment (id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_dup_uname ON mv_duplicative_funding (uname)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_purpose_overlap_key ON mv_purpose_overlap (recip_key, prog_key)",
    "CREATE INDEX IF NOT EXISTS mv_purpose_overlap_dept ON mv_purpose_overlap (dept_count DESC)",
    "CREATE INDEX IF NOT EXISTS mv_purpose_overlap_val ON mv_purpose_overlap (total_value DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_purpose_cluster_key ON mv_purpose_cluster (recip_key, purpose_cluster)",
    "CREATE INDEX IF NOT EXISTS mv_purpose_cluster_val ON mv_purpose_cluster (total_value DESC)",
    "CREATE INDEX IF NOT EXISTS mv_purpose_cluster_dept ON mv_purpose_cluster (n_departments DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_commodity_code ON mv_contract_commodity (code)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_solicitation_code ON mv_contract_solicitation (code)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_table_counts_tbl ON mv_table_counts (tbl)",
    // New procurement MVs (Challenges 4, 5, 9)
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_ch_history_key ON mv_contract_history (contract_key)",
    "CREATE INDEX IF NOT EXISTS mv_ch_history_vendor ON mv_contract_history (normalized_vendor)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_ch_c2ss_key ON mv_competitive_to_sole_source (contract_key)",
    "CREATE INDEX IF NOT EXISTS mv_ch_c2ss_value ON mv_competitive_to_sole_source (max_effective_value DESC NULLS LAST)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_threshold_split_key ON mv_threshold_splitting (normalized_vendor, owner_org_title, label)",
    "CREATE INDEX IF NOT EXISTS mv_threshold_split_count ON mv_threshold_splitting (contracts_in_window DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_followon_key ON mv_same_vendor_followon (contract_key)",
    "CREATE INDEX IF NOT EXISTS mv_followon_value ON mv_same_vendor_followon (followon_tn_value DESC NULLS LAST)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_vcc_cat_key ON mv_vendor_concentration_by_category (segment, norm_vendor)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_vcc_dept_key ON mv_vendor_concentration_by_department (segment, norm_vendor)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_contract_yearly_key ON mv_contract_yearly (fiscal_year, code)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_growth_decomp_key ON mv_contract_growth_decomposition (commodity_type, fiscal_year)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_bucket_yearly_key ON mv_contract_bucket_yearly (owner_org_title, commodity_type, fiscal_year)",
    "CREATE INDEX IF NOT EXISTS mv_bucket_yearly_year ON mv_contract_bucket_yearly (fiscal_year)",
    "CREATE UNIQUE INDEX IF NOT EXISTS mv_yoy_decomp_key ON mv_contract_yoy_decomposition (owner_org_title, commodity_type, fiscal_year)",
    "CREATE INDEX IF NOT EXISTS mv_yoy_decomp_year ON mv_contract_yoy_decomposition (fiscal_year)",
  ];

  {
    const client = await getClient();
    for (const sql of mvIndexes) {
      try {
        await client.query(sql);
      } catch (e) {
        console.error(`  Index error: ${(e as Error).message.substring(0, 100)}`);
      }
    }
    console.log(`  Created ${mvIndexes.length} MV indexes.`);

    // Create extra indexes on base tables
    console.log("\nCreating additional base-table indexes...");
    for (const sql of EXTRA_INDEXES) {
      try {
        await client.query(sql);
        console.log(`  ✅ ${sql.substring(sql.indexOf("idx_"), sql.indexOf(" ON"))}`);
      } catch (e) {
        console.log(`  ⚠️ Skipped: ${(e as Error).message.substring(0, 80)}`);
      }
    }
    await client.end();
  }

  console.log(`\n=== Optimization Complete: ${created.length} created, ${skipped.length} skipped, ${failed.length} failed ===`);
  if (failed.length > 0) {
    console.log(`  Failed: ${failed.join(", ")}`);
    console.log(`  Re-run the script to retry failed views (already-created ones will be skipped).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Optimization failed:", err);
  process.exit(1);
});
