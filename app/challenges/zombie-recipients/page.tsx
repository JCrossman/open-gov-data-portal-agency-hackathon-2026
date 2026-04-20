export const dynamic = "force-dynamic";
import { queryWithStatus } from "@/lib/db";
import DataUnavailableBanner from "@/components/DataUnavailableBanner";
import { parseSort } from "@/lib/sort-params";
import SortableHeader from "@/components/SortableHeader";

interface ZombieRow {
  bn: string;
  legal_name: string;
  total_revenue: number;
  gov_funding: number;
  gov_pct: number;
  grants_3yr_pre_fpe: number;
  last_fpe: string | null;
  fpe_age_months: number | null;
  last_list_year: number | null;
  cohort: "cessation" | "dependency_risk";
}

function fmtDollars(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

export default async function ZombieRecipientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // Define sort scopes for two independent tables
  const CESSATION_COLS = {
    name: "legal_name",
    grants: "grants_3yr_pre_fpe",
    last_list: "last_list_year",
    last_fpe: "last_fpe",
    pct: "gov_pct",
    revenue: "total_revenue",
  } as const;
  const DEP_COLS = {
    name: "legal_name",
    revenue: "total_revenue",
    grants_pre: "gov_funding",
    pct: "gov_pct",
    last_fpe: "last_fpe",
  } as const;

  const sortA = parseSort(sp, CESSATION_COLS, "grants", "desc", "sortA", "dirA");
  const sortB = parseSort(sp, DEP_COLS, "revenue", "desc", "sortB", "dirB");

  // Preserve params for independent sorting
  const preserveForA = { sortB: sp.sortB as string | undefined, dirB: sp.dirB as string | undefined };
  const preserveForB = { sortA: sp.sortA as string | undefined, dirA: sp.dirA as string | undefined };

  const [scannedRes, cessationRes, depRiskRes, cessationCountRes, depRiskCountRes] = await Promise.all([
    queryWithStatus<{ n: number }>(`SELECT n FROM mv_table_counts WHERE tbl = 't3010_financial'`),
    queryWithStatus<ZombieRow>(`
      SELECT bn, legal_name, total_revenue, gov_funding, gov_pct,
             grants_3yr_pre_fpe, last_fpe::text AS last_fpe,
             fpe_age_months::float AS fpe_age_months, last_list_year, cohort
      FROM mv_zombie_recipients
      WHERE cohort = 'cessation'
      ORDER BY ${sortA.orderBySql}
      LIMIT 50
    `),
    queryWithStatus<ZombieRow>(`
      SELECT bn, legal_name, total_revenue, gov_funding, gov_pct,
             grants_3yr_pre_fpe, last_fpe::text AS last_fpe,
             fpe_age_months::float AS fpe_age_months, last_list_year, cohort
      FROM mv_zombie_recipients
      WHERE cohort = 'dependency_risk'
      ORDER BY ${sortB.orderBySql}
      LIMIT 25
    `),
    queryWithStatus<{ n: number }>(`SELECT COUNT(*)::int AS n FROM mv_zombie_recipients WHERE cohort='cessation'`),
    queryWithStatus<{ n: number }>(`SELECT COUNT(*)::int AS n FROM mv_zombie_recipients WHERE cohort='dependency_risk'`),
  ]);

  const header = (
    <>
      <a href="/challenges" style={{ color: "var(--gc-secondary)", textDecoration: "none", fontSize: "0.875rem" }}>
        &larr; Back to Challenges
      </a>
      <h1 style={{ fontSize: "2rem", marginTop: "0.75rem", marginBottom: "0.5rem" }}>
        Challenge 1: Zombie Recipients
      </h1>
      <blockquote style={{ borderLeft: "4px solid var(--gc-accent)", margin: "0 0 1rem", padding: "0.75rem 1rem", background: "var(--gc-bg-secondary)", color: "var(--gc-text-secondary)", fontSize: "0.9375rem", lineHeight: 1.6 }}>
        Which companies and nonprofits received large amounts of public funding
        and then ceased operations shortly after? An important caveat:
        dependency alone is not enough — a true zombie finding requires
        evidence of disappearance, dissolution, deregistration, or stopped
        filing shortly after funding.
      </blockquote>
      <div style={{ margin: "0 0 2rem", padding: "0.875rem 1.125rem", borderRadius: 6, background: "rgba(40,120,80,0.08)", border: "1px solid rgba(40,120,80,0.35)", fontSize: "0.8125rem", color: "var(--gc-text-secondary)", lineHeight: 1.55 }}>
        <strong>Methodology.</strong> Cessation is determined by <strong>absence
        from the most recent CRA annual List of Charities (2024)</strong>,
        cross-referenced against every annual list back to 2018 (stored in
        <code> t3010_id_history</code>). A recipient is flagged only when its
        business number appeared in a prior year&apos;s registry but no longer
        appears in 2024 &mdash; i.e. genuinely deregistered &mdash; AND it received at
        least $1M in verified federal grants in the 3 years preceding its last
        filing. The portal ingests seven years of T3010 financial returns
        (2018&ndash;2024), so &ldquo;stopped filing&rdquo; reflects actual filing gaps.
      </div>
    </>
  );

  if (!scannedRes.ok || !cessationRes.ok || !depRiskRes.ok || !cessationCountRes.ok || !depRiskCountRes.ok) {
    const err =
      !scannedRes.ok ? scannedRes.error :
      !cessationRes.ok ? cessationRes.error :
      !depRiskRes.ok ? depRiskRes.error :
      !cessationCountRes.ok ? cessationCountRes.error :
      !depRiskCountRes.ok ? depRiskCountRes.error : undefined;
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
        {header}
        <DataUnavailableBanner scope="Zombie-recipient findings (mv_zombie_recipients)" error={err} />
      </div>
    );
  }

  const totalScanned = scannedRes.rows[0]?.n ?? 0;
  const cessationCount = cessationCountRes.rows[0]?.n ?? 0;
  const depRiskCount = depRiskCountRes.rows[0]?.n ?? 0;
  const cessationRows = cessationRes.rows;
  const depRiskRows = depRiskRes.rows;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      {header}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        <StatCard label="Charities scanned (all CRA years)" value={totalScanned.toLocaleString()} />
        <StatCard label="Confirmed cessation (Part A)" value={cessationCount.toString()} />
        <StatCard label="Dependency-risk (Part B)" value={depRiskCount.toString()} />
      </div>

      {/* PART A — cessation cohort (true zombies, now authoritative) */}
      <section style={{ marginBottom: "3rem" }}>
        <h2 style={{ fontSize: "1.375rem", marginBottom: "0.25rem" }}>
          Part A &mdash; Recipients deregistered after receiving substantial federal funding
        </h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem", lineHeight: 1.5 }}>
          Business number appeared in a prior CRA annual <em>List of Charities</em>
          (2018&ndash;2023) but is <strong>absent from the 2024 list</strong> &mdash; i.e.
          revoked, deregistered, or wound down &mdash; AND received <strong>&ge; $1M</strong>
          in verified federal grants in the 3 years preceding its last filing.
          This directly answers the Challenge&nbsp;1 prompt: &ldquo;did the public get
          anything for its money, or did it fund a disappearing act?&rdquo;
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <caption style={{ textAlign: "left", fontWeight: 600, marginBottom: "0.5rem" }}>
              All {cessationRows.length} deregistered recipients, ranked by verified grants in the 3 years before last filing
            </caption>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>#</th>
                <SortableHeader columnKey="name" label="Charity" sort={sortA} align="left" defaultDir="asc" preserve={preserveForA} />
                <SortableHeader columnKey="grants" label="Grants (3yr pre-FPE)" sort={sortA} align="right" preserve={preserveForA} info="Total verified federal grants (in dollars) received in the three years preceding the charity's last fiscal period end (FPE) on file." />
                <SortableHeader columnKey="last_list" label="Last CRA list year" sort={sortA} align="right" preserve={preserveForA} info="Most recent year (2018–2023) in which this business number appeared on the CRA's annual List of Charities. Absence from the 2024 list indicates deregistration." />
                <SortableHeader columnKey="last_fpe" label="Last FPE" sort={sortA} align="right" preserve={preserveForA} info="Fiscal period end of the charity's most recent CRA T3010 financial filing — i.e. the last year for which it filed annual returns." />
                <SortableHeader columnKey="pct" label="Dependency" sort={sortA} align="right" preserve={preserveForA} info="Annualized federal grants divided by the charity's annual revenue from its latest T3010 filing, capped at 100%. Higher means the charity relied more on federal grants for its operating budget." />
              </tr>
            </thead>
            <tbody>
              {cessationRows.map((z, i) => (
                <tr key={z.bn} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                  <td style={{ padding: "0.5rem" }}>{i + 1}</td>
                  <td style={{ padding: "0.5rem" }}>
                    <a href={`/entity/${encodeURIComponent(z.legal_name ?? z.bn)}`} style={{ color: "var(--gc-secondary)" }}>
                      {(z.legal_name ?? z.bn).substring(0, 60)}
                    </a>
                  </td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(Number(z.grants_3yr_pre_fpe))}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", color: "var(--risk-high)", fontWeight: 600 }}>{z.last_list_year ?? "—"}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{z.last_fpe ?? "—"}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 700 }} title="Annualized grants ÷ reported revenue. Shown for context; cessation, not dependency, qualifies Part A.">{z.gov_pct == null || Number(z.gov_pct) < 0.1 ? <span style={{ color: "var(--muted)" }}>&mdash;</span> : `${Number(z.gov_pct).toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* PART B — dependency_risk cohort (future-zombie risk on active filers) */}
      <section style={{ marginBottom: "3rem" }}>
        <h2 style={{ fontSize: "1.375rem", marginBottom: "0.25rem" }}>
          Part B &mdash; Active recipients with extreme government dependency (future-zombie risk)
        </h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem", lineHeight: 1.5 }}>
          Still present in the 2024 CRA list with annualized verified federal
          grants <strong>&ge; 70%</strong> of annual revenue.
          <strong style={{ color: "var(--gc-accent)" }}>
            {" "}This is dependency risk, not cessation evidence.
          </strong>{" "}
          These organizations are operating normally today; they are flagged as
          at-risk of becoming zombies if their funding were withdrawn.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <caption style={{ textAlign: "left", fontWeight: 600, marginBottom: "0.5rem" }}>
              Top {depRiskRows.length} dependency-risk recipients by annual revenue
            </caption>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>#</th>
                <SortableHeader columnKey="name" label="Charity" sort={sortB} align="left" defaultDir="asc" preserve={preserveForB} />
                <SortableHeader columnKey="revenue" label="Annual Revenue" sort={sortB} align="right" preserve={preserveForB} info="Total revenue from the charity's latest CRA T3010 financial filing (line 4700)." />
                <SortableHeader columnKey="grants_pre" label="Federal Grants/yr" sort={sortB} align="right" preserve={preserveForB} info="Annualized federal grants — total verified grants since 2017 divided by the number of distinct grant years, giving an average yearly disbursement comparable to annual revenue." />
                <SortableHeader columnKey="pct" label="Dependency" sort={sortB} align="right" preserve={preserveForB} info="Annualized federal grants divided by the charity's annual revenue, capped at 100%. ≥70% qualifies the charity for this dependency-risk view." />
                <SortableHeader columnKey="last_fpe" label="Last FPE" sort={sortB} align="right" preserve={preserveForB} info="Fiscal period end of the charity's most recent CRA T3010 financial filing." />
              </tr>
            </thead>
            <tbody>
              {depRiskRows.map((z, i) => (
                <tr key={z.bn} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                  <td style={{ padding: "0.5rem" }}>{i + 1}</td>
                  <td style={{ padding: "0.5rem" }}>
                    <a href={`/entity/${encodeURIComponent(z.legal_name ?? z.bn)}`} style={{ color: "var(--gc-secondary)" }}>
                      {(z.legal_name ?? z.bn).substring(0, 60)}
                    </a>
                  </td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(Number(z.total_revenue))}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(Number(z.gov_funding))}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", color: Number(z.gov_pct) > 95 ? "var(--risk-critical)" : "var(--risk-high)", fontWeight: 700 }}>
                    {Number(z.gov_pct).toFixed(1)}%
                  </td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{z.last_fpe ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "var(--gc-bg-secondary)", borderRadius: "8px", padding: "1rem", textAlign: "center", border: "1px solid var(--gc-border)" }}>
      <div className="font-mono" style={{ fontSize: "1.75rem", fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)" }}>{label}</div>
    </div>
  );
}
