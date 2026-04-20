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

interface StatsRow {
  total_transfers: number;
  total_amount: number;
  unique_donors: number;
  unique_donees: number;
}

interface LoopRow {
  loop_type: "reciprocal" | "triangle" | "chain4";
  bns: string[];
  names: string[];
  total_circled: number;
  classification:
    | "structural_hierarchy"
    | "structural_platform"
    | "reciprocal_pair"
    | "possible_suspicious";
}

interface ClassCountRow {
  classification: LoopRow["classification"];
  loop_type: LoopRow["loop_type"];
  n: number;
}

function classBadge(c: LoopRow["classification"]) {
  const map: Record<LoopRow["classification"], { label: string; description: string; tone: "neutral" | "warning" | "info" }> = {
    structural_hierarchy: {
      label: "structural · hierarchy",
      description: "One or more charities in this loop are part of a denominational or federated hierarchy (e.g. diocese, synod, federation). Reciprocal flows are typically expected and structurally normal.",
      tone: "info",
    },
    structural_platform: {
      label: "structural · platform",
      description: "One or more charities in this loop is a donation platform or federated fundraiser (e.g. Benevity, CanadaHelps, United Way, community foundation). Reciprocal flows are typically a routine artifact of how donations are routed.",
      tone: "info",
    },
    reciprocal_pair: {
      label: "reciprocal pair",
      description: "Two-charity loop with money flowing both directions. Most reciprocal giving between related charities is structurally normal — surfaced as a candidate, not proof of abuse.",
      tone: "neutral",
    },
    possible_suspicious: {
      label: "possible · suspicious",
      description: "Multi-node loop with no recognized structural explanation (no denominational/federated naming, not a known donation platform). Worth a closer look — but still a candidate, not proven abuse.",
      tone: "warning",
    },
  };
  const { label, description, tone } = map[c];
  return (
    <SignalBadge
      label={label}
      description={description}
      tone={tone}
      style={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: "0.6875rem" }}
    />
  );
}

function loopTypeLabel(t: LoopRow["loop_type"]): string {
  if (t === "reciprocal") return "2-node (A↔B)";
  if (t === "triangle") return "3-node (A→B→C→A)";
  return "4-node (A→B→C→D→A)";
}

export default async function FundingLoopsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const PRIMARY_COLS = {
    total: "total_circled",
    classification: "classification",
    loop_type: "loop_type",
  } as const;
  const RECIP_COLS = {
    total: "total_circled",
    classification: "classification",
  } as const;
  
  type PrimaryKey = keyof typeof PRIMARY_COLS;
  type RecipKey = keyof typeof RECIP_COLS;
  
  const sortP = parseSort<typeof PRIMARY_COLS, PrimaryKey>(sp, PRIMARY_COLS, "total", "desc", "sortP", "dirP");
  const sortR = parseSort<typeof RECIP_COLS, RecipKey>(sp, RECIP_COLS, "total", "desc", "sortR", "dirR");
  const preserveP = { sortR: sp.sortR as string | undefined, dirR: sp.dirR as string | undefined };
  const preserveR = { sortP: sp.sortP as string | undefined, dirP: sp.dirP as string | undefined };

  const [statsRes, classCountsRes, primaryRes, reciprocalsRes] = await Promise.all([
    queryWithStatus<StatsRow>(`SELECT * FROM mv_funding_stats`),
    queryWithStatus<ClassCountRow>(`
      SELECT classification, loop_type, COUNT(*)::int AS n
      FROM mv_funding_loop_classification
      GROUP BY classification, loop_type
      ORDER BY n DESC
    `),
    queryWithStatus<LoopRow>(`
      SELECT loop_type, bns, names, total_circled, classification
      FROM mv_funding_loop_classification
      WHERE loop_type IN ('triangle','chain4')
      ORDER BY ${sortP.orderBySql}
      LIMIT 25
    `),
    queryWithStatus<LoopRow>(`
      SELECT loop_type, bns, names, total_circled, classification
      FROM mv_funding_loop_classification
      WHERE loop_type = 'reciprocal'
      ORDER BY ${sortR.orderBySql}
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
        Challenge 3: Funding Loops
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
        Where does money flow in circles between charities? Using CRA T3010 qualified-donee
        transfer data, we surface reciprocal gifts, triangular cycles, and 4-node chains.
        Every row below is a <strong>candidate loop</strong> — most circular flows are
        structurally normal (denominational hierarchies, federated charities, donation
        platforms). Loops labeled <em>possible · suspicious</em> are those without an obvious
        structural explanation; they warrant scrutiny, not accusation.
      </blockquote>
    </>
  );

  const results = [statsRes, classCountsRes, primaryRes, reciprocalsRes];
  const failed = results.find((r) => !r.ok);
  if (failed && !failed.ok) {
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
        {header}
        <DataUnavailableBanner
          scope="Funding-loop findings (mv_funding_stats / mv_funding_loop_classification / mv_funding_triangles / mv_funding_chains_4)"
          error={failed.error}
        />
      </div>
    );
  }

  const s = statsRes.ok ? statsRes.rows[0] ?? { total_transfers: 0, total_amount: 0, unique_donors: 0, unique_donees: 0 } : { total_transfers: 0, total_amount: 0, unique_donors: 0, unique_donees: 0 };
  const classCounts = classCountsRes.ok ? classCountsRes.rows : [];
  const primary = primaryRes.ok ? primaryRes.rows : [];
  const reciprocals = reciprocalsRes.ok ? reciprocalsRes.rows : [];

  const total = classCounts.reduce((sum, r) => sum + Number(r.n), 0);
  const byClass = classCounts.reduce<Record<string, number>>((acc, r) => {
    acc[r.classification] = (acc[r.classification] ?? 0) + Number(r.n);
    return acc;
  }, {});

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      {header}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <StatCard label="Total transfer records" value={Number(s.total_transfers).toLocaleString()} />
        <StatCard label="Total transferred" value={fmtDollars(Number(s.total_amount))} />
        <StatCard label="Candidate loops" value={total.toLocaleString()} />
        <StatCard label="Possibly suspicious" value={(byClass.possible_suspicious ?? 0).toLocaleString()} />
      </div>

      <div
        style={{
          background: "var(--gc-bg-secondary)",
          border: "1px solid var(--gc-border)",
          borderRadius: 8,
          padding: "1rem 1.25rem",
          marginBottom: "2rem",
          fontSize: "0.875rem",
          lineHeight: 1.7,
        }}
      >
        <strong>Classification breakdown:</strong>{" "}
        {(["structural_hierarchy", "structural_platform", "reciprocal_pair", "possible_suspicious"] as const).map(
          (k, i, arr) => (
            <span key={k}>
              {classBadge(k)}{" "}
              <span className="font-mono">
                {(byClass[k] ?? 0).toLocaleString()}
                {total > 0 ? ` (${((100 * (byClass[k] ?? 0)) / total).toFixed(1)}%)` : ""}
              </span>
              {i < arr.length - 1 ? "  ·  " : ""}
            </span>
          ),
        )}
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Triangular &amp; 4-node candidate cycles
      </h2>
      <p style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Each leg is at least $100K aggregate. Ordered by total dollars circled. Classification is heuristic; <em>candidate</em>, not proven abuse.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2.5rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>#</th>
              <SortableHeader columnKey="loop_type" label="Shape" sort={sortP} align="left" defaultDir="asc" preserve={preserveP} info="Number of charities in the cycle: 2-node (A↔B reciprocal), 3-node triangle (A→B→C→A), or 4-node chain (A→B→C→D→A)." />
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Charities in the cycle</th>
              <SortableHeader columnKey="total" label="Total circled" sort={sortP} align="right" preserve={preserveP} info="Sum of all dollar amounts moved around the cycle (every leg added together) across all CRA T3010 filing years. Larger means more money flowing through the loop overall." />
              <SortableHeader columnKey="classification" label="Classification" sort={sortP} align="left" defaultDir="asc" preserve={preserveP} info="Heuristic label: structural-hierarchy / structural-platform loops are typically benign (e.g. denominational hierarchies, donation platforms). Reciprocal pairs and possible-suspicious loops are candidates that may merit a closer look." />
            </tr>
          </thead>
          <tbody>
            {primary.map((r, i) => (
              <tr
                key={i}
                style={{
                  borderBottom: "1px solid var(--gc-bg-stripe)",
                  background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)",
                  verticalAlign: "top",
                }}
              >
                <td style={{ padding: "0.5rem" }}>{i + 1}</td>
                <td style={{ padding: "0.5rem" }}>{loopTypeLabel(r.loop_type)}</td>
                <td style={{ padding: "0.5rem", lineHeight: 1.6 }}>
                  {(r.names ?? []).map((n, j) => (
                    <span key={j}>
                      {n || r.bns[j]}
                      {j < r.names.length - 1 ? " → " : " → …↩"}
                    </span>
                  ))}
                </td>
                <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 600 }}>
                  {fmtDollars(Number(r.total_circled))}
                </td>
                <td style={{ padding: "0.5rem" }}>{classBadge(r.classification)}</td>
              </tr>
            ))}
            {primary.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: "1rem", textAlign: "center", color: "var(--gc-text-secondary)" }}>
                  No triangular or 4-node candidate cycles at the $100K-per-leg threshold.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Reciprocal pairs (2-node candidates)
      </h2>
      <p style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Charity pairs where money flows both directions. Most reciprocal giving between
        related charities is structurally normal.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>#</th>
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Charity A ↔ Charity B</th>
              <SortableHeader columnKey="total" label="Total circled" sort={sortR} align="right" preserve={preserveR} info="Sum of dollars moved both directions between the two charities (A→B + B→A) across all T3010 filing years." />
              <SortableHeader columnKey="classification" label="Classification" sort={sortR} align="left" defaultDir="asc" preserve={preserveR} info="Heuristic label: structural-hierarchy / structural-platform pairs are typically benign (e.g. denominational hierarchies, donation platforms). Plain reciprocal pairs are candidates only — most are structurally normal." />
            </tr>
          </thead>
          <tbody>
            {reciprocals.map((r, i) => (
              <tr
                key={i}
                style={{
                  borderBottom: "1px solid var(--gc-bg-stripe)",
                  background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)",
                }}
              >
                <td style={{ padding: "0.5rem" }}>{i + 1}</td>
                <td style={{ padding: "0.5rem" }}>
                  {(r.names?.[0] ?? r.bns[0])} &harr; {(r.names?.[1] ?? r.bns[1])}
                </td>
                <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 600 }}>
                  {fmtDollars(Number(r.total_circled))}
                </td>
                <td style={{ padding: "0.5rem" }}>{classBadge(r.classification)}</td>
              </tr>
            ))}
            {reciprocals.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: "1rem", textAlign: "center", color: "var(--gc-text-secondary)" }}>
                  No reciprocal pairs found.
                </td>
              </tr>
            )}
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
