export const revalidate = 3600;
import { queryWithStatus, querySafe } from "@/lib/db";
import DataUnavailableBanner from "@/components/DataUnavailableBanner";
import { POLICY_COMMITMENTS } from "@/lib/policy-commitments";
import { parseSort } from "@/lib/sort-params";
import SortableHeader from "@/components/SortableHeader";

function fmtDollars(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

interface PurposeRow {
  recipient_legal_name: string;
  prog_name_en: string;
  dept_count: number;
  grant_count: number;
  total_value: number;
  departments: string;
  first_date: string | null;
  last_date: string | null;
}

interface CoFundRow {
  name: string;
  dept_count: number;
  grant_count: number;
  total_value: number;
  departments: string;
}

interface PurposeClusterRow {
  bn_prefix: string | null;
  recipient_legal_name: string;
  purpose_cluster: string;
  n_departments: number;
  n_programs: number;
  grant_count: number;
  total_value: number;
  departments: string;
}

const PURPOSE_LABELS: Record<string, string> = {
  housing: "Housing & homelessness",
  mental_health: "Mental health & addictions",
  indigenous: "Indigenous / reconciliation",
  climate: "Climate & clean energy",
  research: "Research & innovation",
  child_care: "Child care & early learning",
  settlement: "Newcomer settlement",
  official_languages: "Official languages",
  veterans: "Veterans",
  seniors: "Seniors & aging",
  youth: "Youth",
  women_gender: "Women & gender",
  skills_employment: "Skills & employment",
  agriculture: "Agriculture & food",
  arts_culture: "Arts, culture & heritage",
};

async function loadGaps(sortKey: string, sortDir: "asc" | "desc") {
  // For each named commitment in the registry, compute allocated-via-grants
  // vs the linearly-scheduled portion of the target envelope. Fulfillment
  // below 20% is surfaced as a candidate gap ("governments claim to prioritize
  // something yet it is not actually being funded [via grants]").
  const today = new Date();
  const rows = await Promise.all(
    POLICY_COMMITMENTS.map(async (c) => {
      const r = await querySafe<{ total: string | null }>(
        `SELECT COALESCE(SUM(agreement_value),0)::text AS total FROM grants
         WHERE agreement_start_date >= $1::date
           AND agreement_start_date <  $2::date
           AND (${c.keywordSql})`,
        [c.targetStart, c.targetEnd],
      );
      const allocated = Number(r[0]?.total ?? 0);
      const start = new Date(c.targetStart).getTime();
      const end = new Date(c.targetEnd).getTime();
      const now = Math.min(Math.max(today.getTime(), start), end);
      const scheduled = c.targetAmountCad * ((now - start) / (end - start));
      const fulfillmentPct = scheduled > 0 ? (allocated / scheduled) * 100 : 0;
      return {
        id: c.id,
        name: c.name,
        committed: c.targetAmountCad,
        scheduled,
        allocated,
        gap: scheduled - allocated,
        fulfillmentPct,
        deliveryNote: c.deliveryNote,
      };
    }),
  );
  const filtered = rows.filter((r) => r.fulfillmentPct < 50); // gap signal threshold
  
  // Apply JS sorting based on sortKey and sortDir
  filtered.sort((a, b) => {
    let valA: number | string = 0;
    let valB: number | string = 0;
    
    switch (sortKey) {
      case "name":
        valA = a.name;
        valB = b.name;
        break;
      case "committed":
        valA = a.committed;
        valB = b.committed;
        break;
      case "scheduled":
        valA = a.scheduled;
        valB = b.scheduled;
        break;
      case "allocated":
        valA = a.allocated;
        valB = b.allocated;
        break;
      case "gap":
        valA = a.gap;
        valB = b.gap;
        break;
      case "fulfillmentPct":
      default:
        valA = a.fulfillmentPct;
        valB = b.fulfillmentPct;
        break;
    }
    
    if (typeof valA === "string" && typeof valB === "string") {
      return sortDir === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    
    return sortDir === "asc" ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
  });
  
  return filtered;
}

export default async function DuplicativeFundingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // Parse sort params for each table
  const ALLOWED_A = {
    recipient_legal_name: "recipient_legal_name",
    prog_name_en: "prog_name_en",
    dept_count: "dept_count",
    grant_count: "grant_count",
    total_value: "total_value",
  } as const;
  const sortA = parseSort(sp, ALLOWED_A, "total_value", "desc", "sortA", "dirA");

  const ALLOWED_B = {
    name: "name",
    committed: "committed",
    scheduled: "scheduled",
    allocated: "allocated",
    gap: "gap",
    fulfillmentPct: "fulfillmentPct",
  } as const;
  const sortB = parseSort(sp, ALLOWED_B, "fulfillmentPct", "asc", "sortB", "dirB");

  const ALLOWED_C = {
    name: "name",
    dept_count: "dept_count",
    grant_count: "grant_count",
    total_value: "total_value",
  } as const;
  const sortC = parseSort(sp, ALLOWED_C, "dept_count", "desc", "sortC", "dirC");

  const ALLOWED_D = {
    recipient_legal_name: "recipient_legal_name",
    purpose_cluster: "purpose_cluster",
    n_departments: "n_departments",
    n_programs: "n_programs",
    total_value: "total_value",
  } as const;
  const sortD = parseSort(sp, ALLOWED_D, "total_value", "desc", "sortD", "dirD");

  const purposeFilter = typeof sp.theme === "string" ? sp.theme : "";

  // Preserve other tables' sort params
  const preserveForA = {
    sortB: sp.sortB as string | undefined,
    dirB: sp.dirB as string | undefined,
    sortC: sp.sortC as string | undefined,
    dirC: sp.dirC as string | undefined,
  };
  const preserveForB = {
    sortA: sp.sortA as string | undefined,
    dirA: sp.dirA as string | undefined,
    sortC: sp.sortC as string | undefined,
    dirC: sp.dirC as string | undefined,
  };
  const preserveForC = {
    sortA: sp.sortA as string | undefined,
    dirA: sp.dirA as string | undefined,
    sortB: sp.sortB as string | undefined,
    dirB: sp.dirB as string | undefined,
    sortD: sp.sortD as string | undefined,
    dirD: sp.dirD as string | undefined,
    theme: sp.theme as string | undefined,
  };
  const preserveForD = {
    sortA: sp.sortA as string | undefined,
    dirA: sp.dirA as string | undefined,
    sortB: sp.sortB as string | undefined,
    dirB: sp.dirB as string | undefined,
    sortC: sp.sortC as string | undefined,
    dirC: sp.dirC as string | undefined,
    theme: purposeFilter || undefined,
  };

  const clusterWhere = purposeFilter ? `WHERE purpose_cluster = $1` : ``;
  const clusterArgs = purposeFilter ? [purposeFilter] : [];

  const [
    summaryRes,
    purposeRes,
    coFundRes,
    purposeStatsRes,
    clusterRes,
    clusterStatsRes,
    clusterByThemeRes,
    policyTargetsTableRes,
    gaps,
  ] = await Promise.all([
    queryWithStatus<{ total_grants: number }>(`SELECT total_grants FROM mv_grants_summary`),
    queryWithStatus<PurposeRow>(`
      SELECT recipient_legal_name, prog_name_en, dept_count, grant_count,
             total_value, departments,
             first_date::text AS first_date, last_date::text AS last_date
      FROM mv_purpose_overlap
      ORDER BY ${sortA.orderBySql}
      LIMIT 30
    `),
    queryWithStatus<CoFundRow>(`
      SELECT name, dept_count, grant_count, total_value, departments
      FROM mv_duplicative_funding
      ORDER BY ${sortC.orderBySql}
      LIMIT 15
    `),
    queryWithStatus<{ rows: number; tot: number; big: number }>(`
      SELECT COUNT(*)::int AS rows,
             COALESCE(SUM(total_value),0)::numeric AS tot,
             COUNT(*) FILTER (WHERE dept_count >= 3)::int AS big
      FROM mv_purpose_overlap
    `),
    queryWithStatus<PurposeClusterRow>(
      `SELECT bn_prefix, recipient_legal_name, purpose_cluster,
              n_departments, n_programs, grant_count, total_value, departments
       FROM mv_purpose_cluster
       ${clusterWhere}
       ORDER BY ${sortD.orderBySql}
       LIMIT 50`,
      clusterArgs as any,
    ),
    queryWithStatus<{ clusters: number; tot: number; big: number; themes: number }>(`
      SELECT COUNT(*)::int AS clusters,
             COALESCE(SUM(total_value),0)::numeric AS tot,
             COUNT(*) FILTER (WHERE n_departments >= 3)::int AS big,
             COUNT(DISTINCT purpose_cluster)::int AS themes
      FROM mv_purpose_cluster
    `),
    queryWithStatus<{ purpose_cluster: string; n: number; val: number }>(`
      SELECT purpose_cluster, COUNT(*)::int AS n, SUM(total_value)::numeric AS val
      FROM mv_purpose_cluster
      GROUP BY purpose_cluster
      ORDER BY val DESC
    `),
    queryWithStatus<{ exists: string | null }>(
      `SELECT to_regclass('public.policy_targets')::text AS exists`,
    ),
    loadGaps(sortB.key, sortB.direction),
  ]);

  const policyTargetsExists =
    policyTargetsTableRes.ok && !!policyTargetsTableRes.rows[0]?.exists;

  const header = (
    <>
      <a href="/challenges" style={{ color: "var(--gc-secondary)", textDecoration: "none", fontSize: "0.875rem" }}>
        &larr; Back to Challenges
      </a>
      <h1 style={{ fontSize: "2rem", marginTop: "0.75rem", marginBottom: "0.5rem" }}>
        Challenge 8: Duplicative Funding (and Funding Gaps)
      </h1>
      <blockquote style={{ borderLeft: "4px solid var(--gc-accent)", margin: "0 0 2rem", padding: "0.75rem 1rem", background: "var(--gc-bg-secondary)", color: "var(--gc-text-secondary)", fontSize: "0.9375rem", lineHeight: 1.6 }}>
        Which organizations are being funded by multiple levels of government
        for the same purpose, potentially without those governments knowing
        about each other? The flip side: where do all levels of government
        claim to prioritize something, yet none of them are actually funding
        it? Duplication catches waste. Gaps catch failure.
      </blockquote>
    </>
  );

  if (!summaryRes.ok || !purposeRes.ok || !coFundRes.ok || !purposeStatsRes.ok) {
    const err = !summaryRes.ok ? summaryRes.error
      : !purposeRes.ok ? purposeRes.error
      : !coFundRes.ok ? coFundRes.error
      : purposeStatsRes.ok ? undefined : purposeStatsRes.error;
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
        {header}
        <DataUnavailableBanner scope="Duplicative-funding findings" error={err} />
      </div>
    );
  }

  const totalGrants = summaryRes.rows[0]?.total_grants ?? 0;
  const pStats = purposeStatsRes.rows[0];
  const purposeRows = purposeRes.rows;
  const coFundRows = coFundRes.rows;
  const clusterRows = clusterRes.ok ? clusterRes.rows : [];
  const cStats = clusterStatsRes.ok ? clusterStatsRes.rows[0] : undefined;
  const themeRows = clusterByThemeRes.ok ? clusterByThemeRes.rows : [];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      {header}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        <StatCard label="Federal grant records scanned" value={Number(totalGrants).toLocaleString()} />
        <StatCard label="Purpose-overlap cases (same recipient + same program, 2+ depts)" value={(pStats?.rows ?? 0).toString()} />
        <StatCard label="Value flowing through overlap" value={fmtDollars(Number(pStats?.tot ?? 0))} />
        <StatCard label="Cases with 3+ departments" value={(pStats?.big ?? 0).toString()} />
      </div>

      {/* Primary: purpose-level duplication */}
      <section style={{ marginBottom: "3rem" }}>
        <h2 style={{ fontSize: "1.375rem", marginBottom: "0.25rem" }}>
          Part A &mdash; Purpose-level duplication (same recipient + same program + multiple federal departments)
        </h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem", lineHeight: 1.55 }}>
          Cases where two or more federal departments each fund the <strong>same
          recipient under the same program name</strong>. Because the program name
          is identical, these are not merely shared-recipient coincidences &mdash;
          they are structurally duplicative streams. The pattern is especially
          notable for the Regional Economic Development agencies (Pacific / Prairies
          / Western) running the same &ldquo;Regional Economic Growth Through
          Innovation&rdquo; program for the same recipient, and for historical
          Indigenous-program splits between CIRNAC and ISC.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>#</th>
                <SortableHeader columnKey="recipient_legal_name" label="Recipient" sort={sortA as any} preserve={preserveForA} />
                <SortableHeader columnKey="prog_name_en" label="Program" sort={sortA as any} preserve={preserveForA} />
                <SortableHeader columnKey="dept_count" label="Depts" sort={sortA as any} align="right" preserve={preserveForA} info="Number of distinct federal departments funding this same recipient under this same program name. ≥2 means the same purpose is being funded from multiple departments." />
                <SortableHeader columnKey="grant_count" label="Grants" sort={sortA as any} align="right" preserve={preserveForA} info="Total number of individual grant agreements covering this recipient/program combination across all funding departments." />
                <SortableHeader columnKey="total_value" label="Total value" sort={sortA as any} align="right" preserve={preserveForA} />
                <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Departments</th>
              </tr>
            </thead>
            <tbody>
              {purposeRows.map((p, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)", verticalAlign: "top" }}>
                  <td style={{ padding: "0.5rem" }}>{i + 1}</td>
                  <td style={{ padding: "0.5rem", fontWeight: 600, maxWidth: 240 }}>
                    <a href={`/entity/${encodeURIComponent(p.recipient_legal_name ?? "")}`} style={{ color: "var(--gc-secondary)" }}>
                      {(p.recipient_legal_name ?? "").substring(0, 70)}
                    </a>
                  </td>
                  <td style={{ padding: "0.5rem", maxWidth: 240 }}>{(p.prog_name_en ?? "").substring(0, 70)}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 700, color: Number(p.dept_count) >= 3 ? "var(--risk-critical)" : "var(--gc-text)" }}>{p.dept_count}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{Number(p.grant_count)}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(Number(p.total_value))}</td>
                  <td style={{ padding: "0.5rem", fontSize: "0.6875rem", color: "var(--gc-text-secondary)", maxWidth: 320 }}>
                    {(p.departments ?? "").substring(0, 180)}
                  </td>
                </tr>
              ))}
              {purposeRows.length === 0 && (
                <tr><td colSpan={7} style={{ padding: "1rem", textAlign: "center", color: "var(--gc-text-secondary)" }}>No purpose-overlap rows.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Part A2: purpose-theme cluster — same recipient (BN-prefix), same
          policy theme, multiple departments, multiple programs. Catches
          purpose-overlap that the strict identical-program-name view misses. */}
      <section style={{ marginBottom: "3rem" }}>
        <h2 style={{ fontSize: "1.375rem", marginBottom: "0.25rem" }}>
          Part A2 &mdash; Purpose-theme cluster (same recipient, same policy theme, multiple programs and departments)
        </h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem", lineHeight: 1.55 }}>
          Recipients (matched by 9-digit business-number prefix where available)
          receiving grants tagged with the <strong>same normalized policy
          theme</strong> from <strong>two or more departments</strong> and under
          <strong> two or more distinct program names</strong>. Themes are derived
          from program-name and description keywords (housing, mental health,
          indigenous, climate, research, child care, etc.). Because both the
          theme and the recipient identity are held constant while program
          brands vary, these clusters are stronger purpose-duplication signals
          than mere multi-department co-funding. They are still leads &mdash;
          some clusters reflect legitimately distinct sub-streams (e.g. NSERC
          vs. CIHR vs. SSHRC research grants to the same institution).
        </p>

        {cStats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
            <StatCard label="Theme clusters detected" value={Number(cStats.clusters).toLocaleString()} />
            <StatCard label="Distinct themes" value={String(cStats.themes)} />
            <StatCard label="Value flowing through clusters" value={fmtDollars(Number(cStats.tot ?? 0))} />
            <StatCard label="Clusters with 3+ departments" value={Number(cStats.big).toLocaleString()} />
          </div>
        )}

        {themeRows.length > 0 && (
          <div style={{ marginBottom: "1rem", display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)", marginRight: "0.5rem" }}>Filter by theme:</span>
            <a href={`?sortD=${sortD.key}&dirD=${sortD.direction}`}
               style={{ fontSize: "0.75rem", padding: "0.2rem 0.55rem", border: "1px solid var(--gc-border)", borderRadius: 12, background: !purposeFilter ? "var(--gc-primary)" : "var(--gc-bg)", color: !purposeFilter ? "#fff" : "var(--gc-text)", textDecoration: "none" }}>
              All
            </a>
            {themeRows.map((t) => {
              const active = purposeFilter === t.purpose_cluster;
              return (
                <a key={t.purpose_cluster}
                   href={`?theme=${encodeURIComponent(t.purpose_cluster)}&sortD=${sortD.key}&dirD=${sortD.direction}`}
                   style={{ fontSize: "0.75rem", padding: "0.2rem 0.55rem", border: "1px solid var(--gc-border)", borderRadius: 12, background: active ? "var(--gc-primary)" : "var(--gc-bg)", color: active ? "#fff" : "var(--gc-text)", textDecoration: "none" }}>
                  {PURPOSE_LABELS[t.purpose_cluster] ?? t.purpose_cluster} ({t.n})
                </a>
              );
            })}
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>#</th>
                <SortableHeader columnKey="recipient_legal_name" label="Recipient" sort={sortD as any} preserve={preserveForD} />
                <SortableHeader columnKey="purpose_cluster" label="Purpose theme" sort={sortD as any} preserve={preserveForD} />
                <SortableHeader columnKey="n_departments" label="# Depts" sort={sortD as any} align="right" preserve={preserveForD} info="Distinct federal departments funding this recipient under this purpose theme." />
                <SortableHeader columnKey="n_programs" label="# Programs" sort={sortD as any} align="right" preserve={preserveForD} info="Distinct program names through which the same recipient receives funding for the same theme. ≥2 means the duplication is not just a single program billed by multiple departments." />
                <SortableHeader columnKey="total_value" label="Total value" sort={sortD as any} align="right" preserve={preserveForD} />
                <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Departments</th>
              </tr>
            </thead>
            <tbody>
              {clusterRows.map((c, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)", verticalAlign: "top" }}>
                  <td style={{ padding: "0.5rem" }}>{i + 1}</td>
                  <td style={{ padding: "0.5rem", fontWeight: 600, maxWidth: 240 }}>
                    <a href={`/entity/${encodeURIComponent(c.recipient_legal_name ?? "")}`} style={{ color: "var(--gc-secondary)" }}>
                      {(c.recipient_legal_name ?? "").substring(0, 70)}
                    </a>
                    {c.bn_prefix && (
                      <div style={{ fontSize: "0.6875rem", color: "var(--gc-text-secondary)", fontFamily: "monospace" }}>
                        BN {c.bn_prefix}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    <span style={{ display: "inline-block", padding: "0.15rem 0.5rem", borderRadius: 10, background: "var(--gc-bg-secondary)", border: "1px solid var(--gc-border)", fontSize: "0.6875rem" }}>
                      {PURPOSE_LABELS[c.purpose_cluster] ?? c.purpose_cluster}
                    </span>
                  </td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 700, color: Number(c.n_departments) >= 3 ? "var(--risk-critical)" : "var(--gc-text)" }}>{c.n_departments}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{c.n_programs}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(Number(c.total_value))}</td>
                  <td style={{ padding: "0.5rem", fontSize: "0.6875rem", color: "var(--gc-text-secondary)", maxWidth: 320 }}>
                    {(c.departments ?? "").substring(0, 180)}
                  </td>
                </tr>
              ))}
              {clusterRows.length === 0 && (
                <tr><td colSpan={7} style={{ padding: "1rem", textAlign: "center", color: "var(--gc-text-secondary)" }}>No purpose-theme clusters {purposeFilter ? `for theme "${purposeFilter}"` : ""}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Part B: funding gaps — commitments under-allocated via grants */}
      <section style={{ marginBottom: "3rem" }}>
        <h2 style={{ fontSize: "1.375rem", marginBottom: "0.25rem" }}>
          Part B &mdash; Funding gaps (named commitments with &lt;50% grant-channel fulfillment to date)
        </h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem", lineHeight: 1.55 }}>
          For each named federal policy commitment in the{" "}
          <a href="/challenges/policy-misalignment" style={{ color: "#0b3d68", textDecoration: "underline", fontWeight: 600 }}>Policy Misalignment registry</a>,
          we compare what should have been disbursed by today under linear
          pacing (&ldquo;Scheduled&rdquo;) to what actually flowed through the
          grants channel (&ldquo;Allocated&rdquo;). Commitments below 50%
          fulfillment surface here. Some gaps are genuine under-allocation;
          others are delivery-channel artifacts (e.g. CWELCC and the Canadian
          Dental Care Plan are delivered via federal-provincial transfers /
          insurance administration that don&apos;t appear in the grants dataset).
        </p>
        {policyTargetsExists && (
          <div style={{ padding: "0.5rem 0.75rem", background: "#EFF6FF", border: "1px solid var(--gc-primary)", borderRadius: 6, fontSize: "0.75rem", color: "var(--gc-text-secondary)", marginBottom: "0.75rem" }}>
            <strong>policy_targets table detected.</strong> A structured commitment
            registry is now available in the database and will be wired into
            this view in the next refresh.
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                <SortableHeader columnKey="name" label="Commitment" sort={sortB as any} preserve={preserveForB} />
                <SortableHeader columnKey="committed" label="Committed" sort={sortB as any} align="right" preserve={preserveForB} info="Total dollar value the federal government publicly committed to deliver against this commitment over its full target window." />
                <SortableHeader columnKey="scheduled" label="Scheduled to date" sort={sortB as any} align="right" preserve={preserveForB} info="Linearly-prorated portion of the committed amount that should have flowed by today, based on the share of the commitment window that has elapsed." />
                <SortableHeader columnKey="allocated" label="Allocated (grants)" sort={sortB as any} align="right" preserve={preserveForB} info="Total federal grant dollars actually disbursed against programs whose names match the keywords for this commitment." />
                <SortableHeader columnKey="gap" label="Gap" sort={sortB as any} align="right" preserve={preserveForB} info="Scheduled-to-date minus allocated-via-grants. Positive values shown here mean grant allocation is behind the linear schedule." />
                <SortableHeader columnKey="fulfillmentPct" label="Fulfillment" sort={sortB as any} align="right" preserve={preserveForB} info="Allocated-via-grants divided by scheduled-to-date, expressed as a percentage. Only commitments below 50% appear in this view." />
              </tr>
            </thead>
            <tbody>
              {gaps.map((g, i) => (
                <tr key={g.id} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)", verticalAlign: "top" }}>
                  <td style={{ padding: "0.5rem", maxWidth: 320 }}>
                    <div style={{ fontWeight: 600 }}>{g.name}</div>
                    {g.deliveryNote && (
                      <div style={{ fontSize: "0.6875rem", color: "#8a5a00", fontStyle: "italic", marginTop: 2 }}>
                        Delivery note: {g.deliveryNote}
                      </div>
                    )}
                  </td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(g.committed)}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(g.scheduled)}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(g.allocated)}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 700, color: "var(--risk-high)" }}>
                    +{fmtDollars(g.gap)}
                  </td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 600 }}>{g.fulfillmentPct.toFixed(0)}%</td>
                </tr>
              ))}
              {gaps.length === 0 && (
                <tr><td colSpan={6} style={{ padding: "1rem", textAlign: "center", color: "var(--gc-text-secondary)" }}>No commitments below 50% fulfillment.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Part C: secondary view — any-recipient multi-dept co-funding (lead generation) */}
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.25rem", marginBottom: "0.25rem" }}>
          Part C &mdash; Recipients co-funded by 2+ federal departments (broad, lead-generation view)
        </h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem", lineHeight: 1.55 }}>
          Any recipient receiving federal grants from two or more departments
          &mdash; regardless of program. This is intentionally broader than Part
          A and includes legitimate patterns (e.g. a university receiving
          NSERC, SSHRC, and CIHR funding for distinct research programs), so
          these rows are <strong>leads for investigation</strong>, not findings of
          duplication.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                <SortableHeader columnKey="name" label="Recipient" sort={sortC as any} preserve={preserveForC} />
                <SortableHeader columnKey="dept_count" label="Depts" sort={sortC as any} align="right" preserve={preserveForC} info="Number of distinct federal departments that have funded this recipient (across any program). ≥2 qualifies the recipient for this lead-generation view." />
                <SortableHeader columnKey="grant_count" label="Grants" sort={sortC as any} align="right" preserve={preserveForC} info="Total number of individual grant agreements this recipient has received from federal departments." />
                <SortableHeader columnKey="total_value" label="Total value" sort={sortC as any} align="right" preserve={preserveForC} />
              </tr>
            </thead>
            <tbody>
              {coFundRows.map((d, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                  <td style={{ padding: "0.5rem", fontWeight: 600 }}>{(d.name ?? "").substring(0, 80)}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 700 }}>{d.dept_count}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{Number(d.grant_count)}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(Number(d.total_value))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div style={{ padding: "0.75rem 1rem", background: "#EFF6FF", border: "1px solid var(--gc-primary)", borderRadius: 6, fontSize: "0.75rem", lineHeight: 1.55, color: "var(--gc-text-secondary)" }}>
        <strong>Scope.</strong> Federal grants only. Provincial, territorial,
        and municipal funding datasets would extend Part A to true cross-level
        duplication; those are not loaded here. Part B&apos;s gaps are measured
        against federal commitments only.
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "var(--gc-bg-secondary)", borderRadius: "8px", padding: "1rem", textAlign: "center", border: "1px solid var(--gc-border)" }}>
      <div className="font-mono" style={{ fontSize: "1.5rem", fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)" }}>{label}</div>
    </div>
  );
}
