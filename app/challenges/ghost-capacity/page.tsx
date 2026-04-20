export const dynamic = "force-dynamic";
import { queryWithStatus } from "@/lib/db";
import DataUnavailableBanner from "@/components/DataUnavailableBanner";
import { parseSort } from "@/lib/sort-params";
import SortableHeader from "@/components/SortableHeader";
import SignalBadge from "@/components/SignalBadge";

function fmtDollars(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

interface GhostRow {
  bn: string;
  legal_name: string;
  total_revenue: number;
  gov_pct: number;
  comp_pct: number;
  transfer_out_pct: number;
  employee_count: number | null;
  has_program_desc: boolean;
  has_address: boolean;
  sig_no_employees: boolean;
  sig_no_programs: boolean;
  sig_no_address: boolean;
  sig_comp_heavy: boolean;
  sig_pass_through: boolean;
  sig_no_non_gov_rev: boolean;
  ghost_score: number;
}

const SIGNALS: { key: keyof GhostRow; label: string; description: string }[] = [
  { key: "sig_no_employees",   label: "no employees",    description: "Latest CRA T3010 Schedule 3 reports 0 or 1 paid employees (FT+PT). Either self-declared zero, or no Schedule 3 was filed." },
  { key: "sig_no_programs",    label: "no programs",     description: "No CRA T3010 Schedule 2 program description longer than 10 characters across any filing year. Either Schedule 2 was not filed, or filed blank." },
  { key: "sig_no_address",     label: "no address",      description: "T3010 identification record is missing a usable street address or city." },
  { key: "sig_comp_heavy",     label: "comp-heavy",      description: "Compensation (or management/admin expense as fallback) is ≥ 60% of total revenue — suggests money flows mostly to staff pay rather than program delivery." },
  { key: "sig_pass_through",   label: "pass-through",    description: "Outbound qualified-donee gifts (T3010 Schedule 6) ≥ 60% of latest-year total expenditure — most spending is forwarded to other charities." },
  { key: "sig_no_non_gov_rev", label: "no non-gov rev",  description: "Revenue minus self-reported government revenue (T3010 field 4120) minus verified federal grants (annualized) is ≤ 0 — no evidence of non-government income." },
];

export default async function GhostCapacityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const GHOST_COLS = {
    name: "legal_name",
    score: "ghost_score",
    revenue: "total_revenue",
    emp: "employee_count",
    comp: "comp_pct",
    transfers: "transfer_out_pct",
  } as const;
  const sort = parseSort(sp, GHOST_COLS, "score", "desc") as ReturnType<typeof parseSort<typeof GHOST_COLS, keyof typeof GHOST_COLS>>;

  const [scannedRes, ghostsRes, countRes] = await Promise.all([
    queryWithStatus<{ n: number }>(`SELECT n FROM mv_table_counts WHERE tbl = 't3010_financial'`),
    queryWithStatus<GhostRow>(`
      SELECT bn, legal_name, total_revenue, gov_pct, comp_pct, transfer_out_pct,
             employee_count, has_program_desc, has_address,
             sig_no_employees, sig_no_programs, sig_no_address,
             sig_comp_heavy, sig_pass_through, sig_no_non_gov_rev,
             ghost_score
      FROM mv_ghost_capacity
      ORDER BY ${sort.orderBySql}
      LIMIT 50
    `),
    queryWithStatus<{ n: number }>(`SELECT COUNT(*)::int AS n FROM mv_ghost_capacity`),
  ]);

  const header = (
    <>
      <a href="/challenges" style={{ color: "var(--gc-secondary)", textDecoration: "none", fontSize: "0.875rem" }}>
        &larr; Back to Challenges
      </a>
      <h1 style={{ fontSize: "2rem", marginTop: "0.75rem", marginBottom: "0.5rem" }}>
        Challenge 2: Ghost Capacity
      </h1>
      <blockquote style={{ borderLeft: "4px solid var(--gc-accent)", margin: "0 0 1rem", padding: "0.75rem 1rem", background: "var(--gc-bg-secondary)", color: "var(--gc-text-secondary)", fontSize: "0.9375rem", lineHeight: 1.6 }}>
        Which funded organizations show no evidence of actually being able to
        deliver what they were funded to do? Look for entities with no
        employees, no physical presence, and no revenue beyond government
        transfers, where expenditures flow almost entirely to compensation or
        further transfers to other entities.
      </blockquote>
      <div style={{ margin: "0 0 1.5rem", padding: "0.75rem 1rem", borderRadius: 6, background: "rgba(0,120,212,0.08)", border: "1px solid rgba(0,120,212,0.3)", fontSize: "0.8125rem", color: "var(--gc-text-secondary)", lineHeight: 1.5 }}>
        <strong>Composite capacity signal &mdash; flags require multiple indicators, not any single one.</strong>
        <br />
        Each charity is scored 0&ndash;6 across six binary signals
        (no/minimal employees, no program descriptions, no usable address,
        compensation-heavy, pass-through transfers, no non-government revenue).
        Only rows with <code>ghost_score &ge; 3</code> are shown. Private and
        public foundations dominated by investment income, trusts/estates,
        and public-sector institutions are carved out from this view to avoid
        false positives.
        <br /><br />
        <strong>Employee counts</strong> are drawn from the charity&apos;s most
        recent CRA T3010 Schedule&nbsp;3 filing (full-time + part-time
        employees). Values reported above 500,000 are treated as filing errors
        and shown as &ldquo;&mdash;&rdquo;. A reported &ldquo;0&rdquo; means
        the charity self-declared zero paid employees on its latest Schedule 3.
        <br /><br />
        <strong>Transfers / Exp.</strong> divides cumulative outbound
        qualified-donee gifts (T3010 Schedule 6, summed across all filing
        years) by the charity&apos;s latest-year total expenditure. Values
        above 100% therefore mean multi-year transfers measured against a
        single year of expenditures &mdash; this is expected for charities
        that have made gifts over many years. The pass-through signal fires
        at &ge;&nbsp;60%. Hover any column header or signal badge for its
        full definition.
      </div>
    </>
  );

  if (!scannedRes.ok || !ghostsRes.ok || !countRes.ok) {
    const err = !scannedRes.ok ? scannedRes.error : !ghostsRes.ok ? ghostsRes.error : !countRes.ok ? countRes.error : undefined;
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
        {header}
        <DataUnavailableBanner scope="Ghost-capacity findings (mv_ghost_capacity)" error={err} />
      </div>
    );
  }

  const totalScanned = scannedRes.rows[0]?.n ?? 0;
  const ghosts = ghostsRes.rows;
  const totalGhostCount = countRes.rows[0]?.n ?? 0;
  const avgScore = ghosts.length > 0
    ? ghosts.reduce((s, g) => s + Number(g.ghost_score), 0) / ghosts.length
    : 0;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      {header}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        <StatCard label="Charities scanned" value={totalScanned.toLocaleString()} />
        <StatCard label="Ghost-score ≥ 3 flagged" value={totalGhostCount.toString()} />
        <StatCard label="Avg score (top 50)" value={avgScore.toFixed(1)} />
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.75rem" }}>
        Top {ghosts.length} by composite ghost score
      </h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <caption style={{ textAlign: "left", fontWeight: 600, marginBottom: "0.5rem" }}>
            Each badge represents one of six capacity signals. Higher score = more indicators present.
          </caption>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>#</th>
              <SortableHeader columnKey="name"      label="Charity"          sort={sort} align="left"  defaultDir="asc" />
              <SortableHeader columnKey="score"     label="Score"            sort={sort} align="right" info="Number of capacity signals (0–6) that fire for this charity. Higher = more evidence of low operational capacity." />
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Signals</th>
              <SortableHeader columnKey="revenue"   label="Revenue"          sort={sort} align="right" info="Total revenue from the charity's latest CRA T3010 financial filing (line 4700)." />
              <SortableHeader columnKey="emp"       label="Emp"              sort={sort} align="right" info="Total paid employees (full-time + part-time) from the charity's most recent CRA T3010 Schedule 3. Values above 500,000 are treated as filing errors and shown as “—”." />
              <SortableHeader columnKey="comp"      label="Comp%"            sort={sort} align="right" info="Compensation (or management/admin expense as fallback) as a percentage of total revenue. ≥60% triggers the comp-heavy signal." />
              <SortableHeader columnKey="transfers" label="Transfers / Exp." sort={sort} align="right" info="Cumulative outbound qualified-donee gifts (T3010 Schedule 6, all filing years) ÷ latest-year total expenditure. Values above 100% mean the charity reported multi-year transfers but only one year of expenditures was used in the denominator. ≥60% triggers the pass-through signal." />
            </tr>
          </thead>
          <tbody>
            {ghosts.map((g, i) => (
              <tr key={g.bn} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                <td style={{ padding: "0.5rem" }}>{i + 1}</td>
                <td style={{ padding: "0.5rem" }}>
                  <a href={`/entity/${encodeURIComponent(g.legal_name ?? g.bn)}`} style={{ color: "var(--gc-secondary)" }}>
                    {(g.legal_name ?? g.bn).substring(0, 55)}
                  </a>
                </td>
                <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 700, color: Number(g.ghost_score) >= 5 ? "var(--risk-critical)" : "var(--risk-high)" }}>
                  {g.ghost_score}/6
                </td>
                <td style={{ padding: "0.5rem" }}>
                  <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                    {SIGNALS.filter(s => Boolean(g[s.key])).map(s => (
                      <SignalBadge key={s.label} label={s.label} description={s.description} tone="warning" />
                    ))}
                  </div>
                </td>
                <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{fmtDollars(Number(g.total_revenue))}</td>
                <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{g.employee_count == null ? "—" : Number(g.employee_count).toLocaleString()}</td>
                <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{Number(g.comp_pct).toFixed(0)}%</td>
                <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{Number(g.transfer_out_pct).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
