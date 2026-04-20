export const dynamic = "force-dynamic";
import { queryWithStatus } from "@/lib/db";
import DataUnavailableBanner from "@/components/DataUnavailableBanner";
import { parseSort } from "@/lib/sort-params";
import SortableHeader from "@/components/SortableHeader";

interface AlignmentRow {
  id: string;
  name: string;
  department: string;
  announced_year: number;
  total_commitment_cad: string;
  period_years: number;
  annual_target: string;
  target_start: string;
  target_end: string;
  description: string;
  source_url: string | null;
  delivery_note: string | null;
  total_matched: string;
  grant_count: number;
  years_observed: number;
  annual_actual: string;
  annual_gap: string;
  gap_pct: string;
}

function fmtDollars(v: number): string {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000_000) return `${sign}$${(a / 1_000_000_000).toFixed(2)}B`;
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(0)}K`;
  return `${sign}$${a.toLocaleString()}`;
}

export default async function PolicyMisalignmentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const res = await queryWithStatus<AlignmentRow>(
    `SELECT id, name, department, announced_year, total_commitment_cad, period_years,
            annual_target, target_start, target_end, description, source_url, delivery_note,
            total_matched, grant_count, years_observed, annual_actual, annual_gap, gap_pct
       FROM mv_policy_alignment`,
  );

  if (!res.ok) {
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
        <a href="/challenges" style={{ color: "var(--gc-secondary)", textDecoration: "none", fontSize: "0.875rem" }}>
          ← Back to Challenges
        </a>
        <h1 style={{ fontSize: "2rem", marginTop: "0.75rem", marginBottom: "0.5rem" }}>
          Challenge 7: Policy Misalignment
        </h1>
        <DataUnavailableBanner scope="Policy commitments / actual-vs-target alignment" error={res.error} />
      </div>
    );
  }

  const rows = res.rows.map((r) => ({
    ...r,
    annual_target_n: Number(r.annual_target),
    annual_actual_n: Number(r.annual_actual),
    annual_gap_n: Number(r.annual_gap),
    gap_pct_n: Number(r.gap_pct),
    total_commitment_n: Number(r.total_commitment_cad),
  }));

  const COLS = {
    commitment: "commitment",
    department: "department",
    annual_target: "annual_target",
    annual_actual: "annual_actual",
    gap: "gap",
    gap_pct: "gap_pct",
  } as const;
  type SortKey = keyof typeof COLS;
  const sort = parseSort(sp, COLS, "gap", "desc") as import("@/lib/sort-params").SortResult<SortKey>;
  rows.sort((a, b) => {
    let av: string | number;
    let bv: string | number;
    switch (sort.key) {
      case "commitment": av = a.name; bv = b.name; break;
      case "department": av = a.department; bv = b.department; break;
      case "annual_target": av = a.annual_target_n; bv = b.annual_target_n; break;
      case "annual_actual": av = a.annual_actual_n; bv = b.annual_actual_n; break;
      case "gap_pct": av = a.gap_pct_n; bv = b.gap_pct_n; break;
      case "gap":
      default: av = a.annual_gap_n; bv = b.annual_gap_n;
    }
    if (typeof av === "string" && typeof bv === "string") {
      return sort.direction === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return sort.direction === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
  });

  const totalCommitted = rows.reduce((s, r) => s + r.total_commitment_n, 0);
  const totalAnnualTarget = rows.reduce((s, r) => s + r.annual_target_n, 0);
  const totalAnnualActual = rows.reduce((s, r) => s + r.annual_actual_n, 0);
  const totalAnnualGap = totalAnnualTarget - totalAnnualActual;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      <a href="/challenges" style={{ color: "var(--gc-secondary)", textDecoration: "none", fontSize: "0.875rem" }}>
        ← Back to Challenges
      </a>

      <h1 style={{ fontSize: "2rem", marginTop: "0.75rem", marginBottom: "0.5rem" }}>
        Challenge 7: Policy Misalignment
      </h1>

      <blockquote style={{ borderLeft: "4px solid var(--gc-accent)", margin: "0 0 2rem", padding: "0.75rem 1rem", background: "var(--gc-bg-secondary)", color: "var(--gc-text-secondary)", fontSize: "0.9375rem", lineHeight: 1.6 }}>
        Is the money going where the government says its priorities are? Pick
        specific, measurable federal policy commitments (emissions targets, housing
        starts, reconciliation spending, healthcare capacity) and compare them to
        the actual flow of funds. Where are the biggest gaps between rhetoric and
        allocation?
      </blockquote>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.5rem", marginBottom: "0.5rem", color: "var(--gc-primary)" }}>
          Actual vs target — {rows.length} named federal commitments
        </h2>
        <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 1rem", lineHeight: 1.55 }}>
          Each row is a publicly announced, measurable federal commitment with a
          dollar envelope and a stated period. <strong>Annual target</strong> is the
          envelope divided by the period in years. <strong>Annual actual</strong> is
          the sum of federal grants whose program name or description matches the
          commitment&rsquo;s keywords, divided by the number of years observed in
          the data. <strong>Gap</strong> = annual target minus annual actual; positive
          values mean grant-channel allocation is below the announced annual pace.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginBottom: "1.25rem" }}>
          <StatCard label={`Total committed (${rows.length} commitments)`} value={fmtDollars(totalCommitted)} />
          <StatCard label="Aggregate annual target" value={fmtDollars(totalAnnualTarget)} />
          <StatCard label="Aggregate annual actual (grants)" value={fmtDollars(totalAnnualActual)} />
          <StatCard
            label={totalAnnualGap >= 0 ? "Aggregate annual gap (target > actual)" : "Aggregate annual surplus (actual > target)"}
            value={fmtDollars(Math.abs(totalAnnualGap))}
            accent={totalAnnualGap > 0}
          />
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
            <thead>
              <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
                <SortableHeader columnKey="commitment" label="Commitment" sort={sort} defaultDir="asc" />
                <SortableHeader columnKey="department" label="Department" sort={sort} defaultDir="asc" />
                <SortableHeader columnKey="annual_target" label="Annual target" sort={sort} align="right" info="The publicly announced multi-year commitment divided by its period in years (e.g., $30B over 5 years = $6B/yr)." />
                <SortableHeader columnKey="annual_actual" label="Annual actual" sort={sort} align="right" info="Sum of federal grant dollars matching this commitment's keywords during its target window, divided by the number of distinct years observed in the data." />
                <SortableHeader columnKey="gap" label="Annual gap" sort={sort} align="right" defaultDir="desc" info="Annual target minus annual actual. Positive = grant flow is below the announced pace; negative = grant flow exceeds it." />
                <SortableHeader columnKey="gap_pct" label="Gap %" sort={sort} align="right" defaultDir="desc" info="Annual gap as a percentage of annual target. 100% = nothing flowing through grants; 0% = on pace; negative = above target." />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)", verticalAlign: "top" }}>
                  <td style={{ ...td, maxWidth: 360 }}>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div style={{ fontSize: "0.7rem", color: "var(--gc-text-secondary)", marginTop: 2 }}>
                      Announced {r.announced_year} · {fmtDollars(r.total_commitment_n)} over {r.period_years} years · {new Date(r.target_start).getUTCFullYear()}&ndash;{new Date(r.target_end).getUTCFullYear()} · {r.grant_count.toLocaleString()} grants matched
                    </div>
                    {r.source_url && (
                      <div style={{ fontSize: "0.6875rem", marginTop: 4 }}>
                        <a href={r.source_url} target="_blank" rel="noreferrer" style={{ color: "var(--gc-secondary)" }}>
                          Source
                        </a>
                      </div>
                    )}
                    {r.delivery_note && (
                      <div style={{ fontSize: "0.6875rem", color: "#8a5a00", marginTop: 4, fontStyle: "italic" }}>
                        Delivery note: {r.delivery_note}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, fontSize: "0.75rem" }}>{r.department}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmtDollars(r.annual_target_n)}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmtDollars(r.annual_actual_n)}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700, color: r.annual_gap_n > 0 ? "var(--risk-high)" : "var(--gc-secondary)" }}>
                    {r.annual_gap_n > 0 ? "+" : ""}{fmtDollars(r.annual_gap_n)}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 600, color: r.gap_pct_n > 0 ? "var(--risk-high)" : "var(--gc-secondary)" }}>
                    {r.gap_pct_n > 0 ? "+" : ""}{r.gap_pct_n.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ marginBottom: "2rem", padding: "1rem 1.25rem", background: "#EFF6FF", border: "1px solid var(--gc-primary)", borderRadius: 6, fontSize: "0.8125rem", lineHeight: 1.6, color: "var(--gc-text-secondary)" }}>
        <strong style={{ color: "var(--gc-primary)" }}>Methodology &amp; caveats.</strong>
        <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
          <li>
            <strong>Keyword matching is approximate.</strong> Matches are POSIX
            regex against <code>prog_name_en</code> and <code>description_en</code>
            — they can over-include programs that share a keyword but pursue a
            different goal, or under-include programs that use different naming.
          </li>
          <li>
            <strong>Grants are only one delivery channel.</strong> Many federal
            commitments are delivered primarily through the Canada Health Transfer,
            bilateral federal-provincial agreements, statutory appropriations,
            tax expenditures, capital procurement, or insurance administration —
            none of which appear in the federal grants &amp; contributions dataset.
            Commitments where this dominates are flagged with a <em>delivery note</em>.
          </li>
          <li>
            <strong>Annualization.</strong> Annual actual is divided by the number
            of distinct years observed within the target window — so a 5-year
            envelope only 2 years into delivery is compared against a 2-year actual
            average, not the full 5-year pace.
          </li>
          <li>
            <strong>Negative gaps</strong> mean the grant-channel envelope already
            exceeds the announced annual pace — usually because pre-existing program
            streams (e.g., long-running Indigenous Services Canada grants) are
            keyword-matched alongside the incremental new commitment.
          </li>
          <li>
            Commitment list is editable in the <code>policy_targets</code> table;
            results are pre-aggregated in materialized view <code>mv_policy_alignment</code>.
          </li>
        </ul>
      </section>
    </div>
  );
}

const td: React.CSSProperties = { padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--gc-border)" };

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ background: accent ? "var(--gc-accent)" : "var(--gc-bg-secondary)", color: accent ? "white" : "var(--gc-text)", borderRadius: 8, padding: "1rem", textAlign: "center" }}>
      <div className="font-mono" style={{ fontSize: "1.5rem", fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: "0.8125rem", marginTop: "0.25rem", opacity: 0.85 }}>{label}</div>
    </div>
  );
}
