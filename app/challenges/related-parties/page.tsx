export const dynamic = "force-dynamic";
import { queryWithStatus } from "@/lib/db";
import DataUnavailableBanner from "@/components/DataUnavailableBanner";
import { parseSort } from "@/lib/sort-params";
import SortableHeader from "@/components/SortableHeader";
import SignalBadge from "@/components/SignalBadge";

function fmtDollars(v: number): string {
  if (!v) return "$0";
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

function personLabel(person_key: string) {
  const [first, last, initials] = person_key.split("|");
  const name = [first, initials, last].filter(Boolean).join(" ");
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

interface StatsRow {
  total_multi_board: number;
  max_boards: number;
  total_disambiguated: number;
  pairs_with_financial_edge: number;
}

interface FlowRow {
  person_key: string;
  bn_x: string;
  bn_y: string;
  name_x: string;
  name_y: string;
  disambiguated: boolean;
  transfer_xy: number;
  transfer_yx: number;
  joint_grants_count: number;
  joint_grants_value: number;
  shared_contract_value: number;
  rank_score: number;
}

interface MultiBoardRow {
  person_key: string;
  bn_prefixes: string[];
  charities: string[];
  board_count: number;
  disambiguated: boolean;
}

function disambigBadge(ok: boolean) {
  return ok ? (
    <SignalBadge
      label="disambiguated"
      description="Director row carries initials, which materially reduces the chance of a common-name collision matching two different people."
      tone="info"
      style={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: "0.6875rem" }}
    />
  ) : (
    <SignalBadge
      label="unverified · name collision risk"
      description="No initials on file for this director — common first/last names may match two or more different people. Treat this row as an unverified lead, not proof of related-party control."
      tone="warning"
      style={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: "0.6875rem" }}
    />
  );
}

export default async function RelatedPartiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // Table 1: Flow links with financial edges
  const FLOW_ALLOWED = {
    person: "person_key",
    transfer: "transfer_xy + transfer_yx",
    grants: "joint_grants_value",
    rank: "rank_score",
  } as const;
  const flowSort = parseSort(sp, FLOW_ALLOWED, "rank", "desc", "sort1", "dir1") as ReturnType<typeof parseSort<typeof FLOW_ALLOWED, keyof typeof FLOW_ALLOWED>>;

  // Table 2: Multi-board directors without financial edges
  const MULTI_ALLOWED = {
    person: "person_key",
    boards: "board_count",
  } as const;
  const multiSort = parseSort(sp, MULTI_ALLOWED, "boards", "desc", "sort2", "dir2") as ReturnType<typeof parseSort<typeof MULTI_ALLOWED, keyof typeof MULTI_ALLOWED>>;

  const [totalRes, statsRes, flowRes, multiBoardRes] = await Promise.all([
    queryWithStatus<{ n: number }>(`SELECT n FROM mv_table_counts WHERE tbl = 't3010_directors'`),
    queryWithStatus<StatsRow>(`SELECT * FROM mv_related_parties_stats`),
    queryWithStatus<FlowRow>(`
      WITH deduped AS (
        SELECT DISTINCT ON (bn_x, bn_y)
               person_key, bn_x, bn_y, name_x, name_y, disambiguated,
               transfer_xy, transfer_yx, joint_grants_count, joint_grants_value,
               shared_contract_value, rank_score
        FROM mv_governance_flow_links
        WHERE transfer_xy + transfer_yx > 0 OR shared_contract_value > 0
        ORDER BY bn_x, bn_y, rank_score DESC
      )
      SELECT * FROM deduped
      ORDER BY ${flowSort.orderBySql}
      LIMIT 25
    `),
    queryWithStatus<MultiBoardRow>(`
      SELECT m.person_key, m.bn_prefixes, m.charities, m.board_count, m.disambiguated
      FROM mv_director_multi_board m
      WHERE NOT EXISTS (
        SELECT 1 FROM mv_governance_flow_links g
        WHERE g.person_key = m.person_key
          AND (g.transfer_xy + g.transfer_yx > 0 OR g.shared_contract_value > 0)
      )
      ORDER BY ${multiSort.orderBySql}, m.person_key
      LIMIT 25
    `),
  ]);

  const header = (
    <>
      <a
        href="/challenges"
        style={{ color: "var(--gc-secondary)", textDecoration: "none", fontSize: "0.875rem" }}
      >
        &larr; Back to Challenges
      </a>
      <h1 style={{ fontSize: "2rem", marginTop: "0.75rem", marginBottom: "0.5rem" }}>
        Challenge 6: Related Parties
      </h1>
      <blockquote
        style={{
          borderLeft: "4px solid var(--gc-accent)",
          margin: "0 0 1rem",
          padding: "0.75rem 1rem",
          background: "var(--gc-bg-secondary)",
          color: "var(--gc-text-secondary)",
          fontSize: "0.9375rem",
          lineHeight: 1.6,
        }}
      >
        Who controls the entities that receive public money, and do they also control each
        other? Every row below is a <strong>lead, not proven control</strong>. Same-name
        matches without initials are flagged as collision risks. &ldquo;Current&rdquo; means
        the director&rsquo;s <code>end_date</code> is null or within the past 12 months and
        the charity&rsquo;s latest T3010 filing is within the past 24 months.
      </blockquote>
    </>
  );

  if (!totalRes.ok || !statsRes.ok || !flowRes.ok || !multiBoardRes.ok) {
    const err = !totalRes.ok ? totalRes.error : !statsRes.ok ? statsRes.error : !flowRes.ok ? flowRes.error : !multiBoardRes.ok ? multiBoardRes.error : undefined;
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
        {header}
        <DataUnavailableBanner
          scope="Related-parties findings (mv_director_board_links / mv_director_multi_board / mv_governance_flow_links)"
          error={err}
        />
      </div>
    );
  }

  const totalRecords = totalRes.rows[0]?.n ?? 0;
  const stats = statsRes.rows[0] ?? { total_multi_board: 0, max_boards: 0, total_disambiguated: 0, pairs_with_financial_edge: 0 };
  const flows = flowRes.rows;
  const leadsOnly = multiBoardRes.rows;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      {header}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1rem",
          marginBottom: "2rem",
        }}
      >
        <StatCard label="Director records scanned" value={totalRecords.toLocaleString()} />
        <StatCard label="Same-director leads" value={stats.total_multi_board.toLocaleString()} />
        <StatCard label="With initials (disambiguated)" value={stats.total_disambiguated.toLocaleString()} />
        <StatCard label="Pairs w/ financial edge" value={stats.pairs_with_financial_edge.toLocaleString()} />
        <StatCard label="Max boards (one person)" value={stats.max_boards.toString()} />
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Same-director BN pairs with funding or transfer edges
      </h2>
      <p style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Strongest leads: two charities share a director <em>and</em> we observe transfers between them
        OR shared federal contract value. Joint-grants alone is not sufficient evidence (two charities can
        independently receive grants without being related). Rank score = (transfer_xy + transfer_yx) +
        0.5 &times; joint-grants value, but the table is filtered to require transfer or contract evidence.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2.5rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>#</th>
              <SortableHeader
                columnKey="person"
                label="Shared director"
                sort={flowSort}
                align="left"
                defaultDir="asc"
                preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string }}
              />
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Charity pair</th>
              <SortableHeader
                columnKey="transfer"
                label="Transfer X→Y / Y→X"
                sort={flowSort}
                align="right"
                defaultDir="desc"
                preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string }}
                info="Total dollars in qualified-donee gifts moving from charity X to charity Y, and from Y to X, across all CRA T3010 filing years. Both directions shown so you can see one-way vs reciprocal flow."
              />
              <SortableHeader
                columnKey="grants"
                label="Joint grants"
                sort={flowSort}
                align="right"
                defaultDir="desc"
                preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string }}
                info="Combined federal grant dollars received by both charities in the pair (only counted when both sides have received grants). Pairs where the two charities share a director and both receive federal funding are stronger leads."
              />
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((r, i) => (
              <tr
                key={i}
                style={{
                  borderBottom: "1px solid var(--gc-bg-stripe)",
                  background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)",
                  verticalAlign: "top",
                }}
              >
                <td style={{ padding: "0.5rem" }}>{i + 1}</td>
                <td style={{ padding: "0.5rem", fontWeight: 600 }}>{personLabel(r.person_key)}</td>
                <td style={{ padding: "0.5rem", lineHeight: 1.5 }}>
                  <div>{r.name_x}<br /><span className="font-mono" style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)" }}>{r.bn_x}</span></div>
                  <div style={{ margin: "0.25rem 0", color: "var(--gc-text-secondary)" }}>&harr;</div>
                  <div>{r.name_y}<br /><span className="font-mono" style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)" }}>{r.bn_y}</span></div>
                </td>
                <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>
                  {fmtDollars(Number(r.transfer_xy))} / {fmtDollars(Number(r.transfer_yx))}
                </td>
                <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>
                  {Number(r.joint_grants_count) > 0
                    ? <>{fmtDollars(Number(r.joint_grants_value))}<br /><span style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)" }}>{Number(r.joint_grants_count)} grants</span></>
                    : <span style={{ color: "var(--gc-text-secondary)" }}>—</span>}
                </td>
                <td style={{ padding: "0.5rem" }}>{disambigBadge(r.disambiguated)}</td>
              </tr>
            ))}
            {flows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: "1rem", textAlign: "center", color: "var(--gc-text-secondary)" }}>
                  No same-director BN pairs currently have observed transfer or joint-grant edges.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Same-director BN pairs without observed financial edges
      </h2>
      <p style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Individuals on multiple current charity boards where we do <em>not</em> (yet) see transfers
        or joint federal grants linking those boards. Weaker leads — often structurally innocent.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>#</th>
              <SortableHeader
                columnKey="person"
                label="Director"
                sort={multiSort}
                align="left"
                defaultDir="asc"
                preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string }}
              />
              <SortableHeader
                columnKey="boards"
                label="Board count"
                sort={multiSort}
                align="right"
                defaultDir="desc"
                preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string }}
                info="Number of distinct charities (by business-number prefix) on which this director currently sits. Higher means a person is connected to more boards — but a same-name match is a lead, not proof, unless the row is also disambiguated by initials."
              />
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Charities</th>
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {leadsOnly.map((d, i) => {
              const charities = Array.isArray(d.charities) ? d.charities : [];
              const MAX = 5;
              const shown = charities.slice(0, MAX);
              const remaining = charities.length - MAX;
              return (
                <tr
                  key={i}
                  style={{
                    borderBottom: "1px solid var(--gc-bg-stripe)",
                    background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)",
                    verticalAlign: "top",
                  }}
                >
                  <td style={{ padding: "0.5rem" }}>{i + 1}</td>
                  <td style={{ padding: "0.5rem", fontWeight: 600 }}>{personLabel(d.person_key)}</td>
                  <td
                    className="font-mono"
                    style={{
                      textAlign: "right",
                      padding: "0.5rem",
                      fontWeight: 700,
                      color: Number(d.board_count) >= 3 ? "var(--risk-critical)" : "var(--risk-high)",
                    }}
                  >
                    {d.board_count}
                  </td>
                  <td style={{ padding: "0.5rem", fontSize: "0.8125rem", lineHeight: 1.6 }}>
                    {shown.map((c, j) => (
                      <span key={j}>
                        {c}
                        {j < shown.length - 1 ? " · " : ""}
                      </span>
                    ))}
                    {remaining > 0 && (
                      <span style={{ color: "var(--gc-text-secondary)", fontStyle: "italic" }}>
                        {" "}and {remaining} more
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem" }}>{disambigBadge(d.disambiguated)}</td>
                </tr>
              );
            })}
            {leadsOnly.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: "1rem", textAlign: "center", color: "var(--gc-text-secondary)" }}>
                  No unlinked multi-board leads remaining.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p
        style={{
          fontSize: "0.8125rem",
          color: "var(--gc-text-secondary)",
          marginTop: "1.5rem",
          lineHeight: 1.6,
        }}
      >
        <strong>Methodology:</strong> Directors are grouped by a person key of
        <code style={{ margin: "0 0.25rem" }}>first|last|initials</code>. Pairs without
        initials are flagged as collision-risk. Only current directors (end_date is null
        or within 12 months) attached to charities with a recent T3010 filing
        (fpe within 24 months) are counted. Financial edges come from
        <code style={{ margin: "0 0.25rem" }}>t3010_transfers</code> and the
        <code style={{ margin: "0 0.25rem" }}>grants</code> table with BN-prefix matching.
      </p>
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
