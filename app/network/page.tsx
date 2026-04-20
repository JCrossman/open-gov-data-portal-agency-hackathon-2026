"use client";

import { useState, useCallback, useMemo } from "react";
import { useClientSort } from "@/lib/use-client-sort";
import ClientSortableHeader from "@/components/ClientSortableHeader";

interface CharityTransfer {
  donorBN: string;
  doneeBN: string;
  doneeName: string;
  totalGifts: number | null;
  associated: string;
  city: string;
  province: string;
}

interface ReciprocalFlag {
  bnA: string;
  bnB: string;
  aToB: number | null;
  bToA: number | null;
}

interface TransferResult {
  transfers: CharityTransfer[];
  total: number;
  reciprocalFlags: ReciprocalFlag[];
}

interface LoopResult {
  chain: Array<{ fromBN: string; toBN: string; toName: string; amount: number | null }>;
  loopDetected: boolean;
  loopBN: string | null;
}

function formatDollars(v: number | null): string {
  if (v === null) return "—";
  return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
}

const inputStyle: React.CSSProperties = {
  padding: "0.75rem",
  fontSize: "0.9375rem",
  border: "2px solid var(--gc-border)",
  borderRadius: "6px",
  minWidth: 0,
};

const buttonStyle: React.CSSProperties = {
  padding: "0.75rem 1.5rem",
  background: "var(--gc-secondary)",
  color: "white",
  border: "none",
  borderRadius: "6px",
  fontSize: "1rem",
  fontWeight: 600,
  cursor: "pointer",
};

export default function NetworkPage() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TransferResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"graph" | "table">("graph");

  // Loop detection state
  const [loopLoading, setLoopLoading] = useState(false);
  const [loopResult, setLoopResult] = useState<LoopResult | null>(null);

  // Client-side sort for table
  const sort = useClientSort<CharityTransfer, "donorBN" | "doneeName" | "doneeBN" | "amount" | "province">(
    data?.transfers ?? [],
    {
      donorBN: (r) => r.donorBN ?? "",
      doneeName: (r) => r.doneeName ?? "",
      doneeBN: (r) => r.doneeBN ?? "",
      amount: (r) => r.totalGifts ?? 0,
      province: (r) => r.province ?? "",
    },
    { key: "amount", direction: "desc" }
  );

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    setData(null);
    setLoopResult(null);

    const params = new URLSearchParams();
    // Treat as BN if it looks like one (digits + RR pattern), else search by name
    if (/^\d{9}RR\d{4}$/i.test(q)) {
      params.set("donorBN", q.toUpperCase());
    } else if (/^\d+$/.test(q)) {
      params.set("donorBN", q);
    } else {
      params.set("donorBN", q);
    }
    params.set("limit", "50");

    try {
      const res = await fetch(`/api/transfers?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [query]);

  const handleDetectLoops = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    setLoopLoading(true);
    setLoopResult(null);

    try {
      // Use the screen API which should have loop detection, or call transfers with special params
      const res = await fetch(`/api/transfers?donorBN=${encodeURIComponent(q)}&limit=20`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);

      // For loop detection, follow the chain client-side
      const firstHop: TransferResult = await res.json();
      if (firstHop.transfers.length === 0) {
        setLoopResult({ chain: [], loopDetected: false, loopBN: null });
        return;
      }

      const chain: LoopResult["chain"] = [];
      const visited = new Set<string>([q.toUpperCase()]);
      let currentBN = q.toUpperCase();

      for (let hop = 0; hop < 3; hop++) {
        const hopRes = await fetch(`/api/transfers?donorBN=${encodeURIComponent(currentBN)}&limit=10`);
        if (!hopRes.ok) break;
        const hopData: TransferResult = await hopRes.json();

        const sorted = [...hopData.transfers]
          .filter((t) => t.doneeBN && t.totalGifts !== null)
          .sort((a, b) => (b.totalGifts ?? 0) - (a.totalGifts ?? 0));

        if (sorted.length === 0) break;

        const top = sorted[0]!;
        chain.push({ fromBN: currentBN, toBN: top.doneeBN, toName: top.doneeName, amount: top.totalGifts });

        if (visited.has(top.doneeBN)) {
          setLoopResult({ chain, loopDetected: true, loopBN: top.doneeBN });
          return;
        }

        visited.add(top.doneeBN);
        currentBN = top.doneeBN;
      }

      setLoopResult({ chain, loopDetected: false, loopBN: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Loop detection failed");
    } finally {
      setLoopLoading(false);
    }
  }, [query]);

  const reciprocalBNs = useMemo(() => {
    if (!data) return new Set<string>();
    const bns = new Set<string>();
    for (const f of data.reciprocalFlags) {
      bns.add(f.bnA);
      bns.add(f.bnB);
    }
    return bns;
  }, [data]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>Charity Transfer Network</h1>
      <p style={{ color: "var(--gc-text-secondary)", marginBottom: "1.5rem" }}>
        Visualize charity-to-charity transfers from T3010 filings. Enter a Business Number to see where funds flow.
      </p>

      <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <label htmlFor="bn-search" style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0,0,0,0)" }}>
          Charity Business Number
        </label>
        <input
          id="bn-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter a BN (e.g. 108160185RR0001)"
          style={{ ...inputStyle, flex: 1, minWidth: "250px" }}
        />
        <button type="submit" disabled={loading} style={{ ...buttonStyle, cursor: loading ? "wait" : "pointer" }}>
          {loading ? "Searching…" : "Search"}
        </button>
        <button
          type="button"
          onClick={handleDetectLoops}
          disabled={loopLoading || !query.trim()}
          style={{
            ...buttonStyle,
            background: "var(--gc-accent)",
            cursor: loopLoading ? "wait" : "pointer",
            opacity: !query.trim() ? 0.5 : 1,
          }}
        >
          {loopLoading ? "Detecting…" : "Detect Loops"}
        </button>
      </form>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", marginBottom: "1.5rem" }}>
        Searches T3010 Qualified Donee schedules for outgoing charity transfers
      </p>

      {loading && (
        <div role="status" aria-live="polite" style={{ textAlign: "center", padding: "2rem", color: "var(--gc-text-secondary)" }}>
          Loading…
        </div>
      )}

      {error && (
        <div role="alert" style={{ padding: "1rem", background: "#FEE2E2", borderRadius: "6px", color: "var(--risk-critical)", marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {/* Loop detection results */}
      {loopResult && (
        <section style={{ marginBottom: "1.5rem", padding: "1rem", background: loopResult.loopDetected ? "#FEE2E2" : "var(--gc-bg-secondary)", borderRadius: "6px", border: loopResult.loopDetected ? "2px solid var(--risk-critical)" : "1px solid var(--gc-border)" }}>
          <h3 style={{ fontSize: "1rem", margin: "0 0 0.5rem", color: loopResult.loopDetected ? "var(--risk-critical)" : "var(--gc-primary)" }}>
            {loopResult.loopDetected ? "⚠️ Funding Loop Detected" : "No Loop Detected"}
          </h3>
          {loopResult.chain.length === 0 ? (
            <p style={{ fontSize: "0.875rem", margin: 0 }}>No outgoing transfers found for this charity.</p>
          ) : (
            <ol style={{ margin: 0, paddingLeft: "1.5rem", fontSize: "0.875rem" }}>
              {loopResult.chain.map((step, i) => (
                <li key={i} style={{ marginBottom: "0.25rem" }}>
                  <span className="font-mono" style={{ fontSize: "0.8125rem" }}>{step.fromBN}</span>
                  {" → "}
                  <span className="font-mono" style={{ fontSize: "0.8125rem" }}>{step.toBN}</span>
                  {" "}({step.toName}) — {formatDollars(step.amount)}
                  {loopResult.loopDetected && step.toBN === loopResult.loopBN && (
                    <strong style={{ color: "var(--risk-critical)", marginLeft: "0.5rem" }}>← LOOP</strong>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {data && data.transfers.length > 0 && (
        <>
          {/* Reciprocal warnings */}
          {data.reciprocalFlags.length > 0 && (
            <div style={{ padding: "0.75rem 1rem", background: "#FEF3C7", border: "1px solid var(--risk-high)", borderRadius: "6px", marginBottom: "1rem", fontSize: "0.875rem" }}>
              <strong>⚠️ Reciprocal Transfers:</strong> {data.reciprocalFlags.length} pair(s) detected
              <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
                {data.reciprocalFlags.map((f, i) => (
                  <li key={i} className="font-mono" style={{ fontSize: "0.8125rem" }}>
                    {f.bnA} → {f.bnB}: {formatDollars(f.aToB)} | {f.bnB} → {f.bnA}: {formatDollars(f.bToA)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* View toggle */}
          <div role="tablist" aria-label="View mode" style={{ display: "flex", gap: "0.25rem", marginBottom: "1rem" }}>
            <button
              role="tab"
              aria-selected={view === "graph"}
              onClick={() => setView("graph")}
              style={{
                padding: "0.5rem 1.25rem",
                border: "2px solid var(--gc-secondary)",
                borderRadius: "6px 0 0 6px",
                background: view === "graph" ? "var(--gc-secondary)" : "var(--gc-bg)",
                color: view === "graph" ? "white" : "var(--gc-secondary)",
                fontWeight: 600,
                fontSize: "0.875rem",
                cursor: "pointer",
              }}
            >
              Graph
            </button>
            <button
              role="tab"
              aria-selected={view === "table"}
              onClick={() => setView("table")}
              style={{
                padding: "0.5rem 1.25rem",
                border: "2px solid var(--gc-secondary)",
                borderRadius: "0 6px 6px 0",
                background: view === "table" ? "var(--gc-secondary)" : "var(--gc-bg)",
                color: view === "table" ? "white" : "var(--gc-secondary)",
                fontWeight: 600,
                fontSize: "0.875rem",
                cursor: "pointer",
              }}
            >
              Table
            </button>
          </div>

          <p style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)", marginBottom: "0.75rem" }}>
            <strong>{new Intl.NumberFormat("en-US").format(data.total)}</strong> total records &middot; Showing <strong>{data.transfers.length}</strong>
          </p>

          {view === "graph" && (
            <NetworkGraph
              transfers={data.transfers}
              reciprocalBNs={reciprocalBNs}
              centerBN={query.trim().toUpperCase()}
            />
          )}

          {view === "table" && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                <caption style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0,0,0,0)" }}>
                  Charity transfer records
                </caption>
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                    <ClientSortableHeader
                      columnKey="donorBN"
                      label="Donor BN"
                      activeKey={sort.key}
                      direction={sort.direction}
                      onSort={sort.toggle}
                      align="left"
                    />
                    <ClientSortableHeader
                      columnKey="doneeName"
                      label="Donee Name"
                      activeKey={sort.key}
                      direction={sort.direction}
                      onSort={sort.toggle}
                      align="left"
                    />
                    <ClientSortableHeader
                      columnKey="doneeBN"
                      label="Donee BN"
                      activeKey={sort.key}
                      direction={sort.direction}
                      onSort={sort.toggle}
                      align="left"
                    />
                    <ClientSortableHeader
                      columnKey="amount"
                      label="Amount"
                      activeKey={sort.key}
                      direction={sort.direction}
                      onSort={sort.toggle}
                      align="right"
                      defaultDir="desc"
                    />
                    <ClientSortableHeader
                      columnKey="province"
                      label="Province"
                      activeKey={sort.key}
                      direction={sort.direction}
                      onSort={sort.toggle}
                      align="left"
                    />
                  </tr>
                </thead>
                <tbody>
                  {sort.rows.map((t, i) => {
                    const isReciprocal = reciprocalBNs.has(t.doneeBN);
                    return (
                      <tr
                        key={i}
                        style={{
                          borderBottom: "1px solid var(--gc-bg-stripe)",
                          background: isReciprocal ? "#FEE2E2" : i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)",
                        }}
                      >
                        <td className="font-mono" style={{ padding: "0.5rem", fontSize: "0.8125rem" }}>{t.donorBN}</td>
                        <td style={{ padding: "0.5rem", maxWidth: "250px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.doneeName}
                          {isReciprocal && <span style={{ color: "var(--risk-critical)", marginLeft: "0.5rem", fontSize: "0.75rem" }} title="Reciprocal transfer detected">⟲</span>}
                        </td>
                        <td className="font-mono" style={{ padding: "0.5rem", fontSize: "0.8125rem" }}>{t.doneeBN}</td>
                        <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{formatDollars(t.totalGifts)}</td>
                        <td style={{ padding: "0.5rem" }}>{t.province}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {data && data.transfers.length === 0 && !loading && (
        <p style={{ textAlign: "center", padding: "2rem", color: "var(--gc-text-secondary)" }}>
          No transfers found for this charity.
        </p>
      )}
    </div>
  );
}

/* ---------- SVG Network Graph ---------- */

function NetworkGraph({
  transfers,
  reciprocalBNs,
  centerBN,
}: {
  transfers: CharityTransfer[];
  reciprocalBNs: Set<string>;
  centerBN: string;
}) {
  const WIDTH = 900;
  const HEIGHT = 550;
  const CX = WIDTH / 2;
  const CY = HEIGHT / 2;
  const RADIUS = 200;

  // Deduplicate donees and take top 20 by amount for readability
  const doneeMap = new Map<string, { bn: string; name: string; amount: number; province: string }>();
  for (const t of transfers) {
    const existing = doneeMap.get(t.doneeBN);
    if (!existing || (t.totalGifts ?? 0) > existing.amount) {
      doneeMap.set(t.doneeBN, { bn: t.doneeBN, name: t.doneeName, amount: t.totalGifts ?? 0, province: t.province });
    }
  }
  const donees = Array.from(doneeMap.values())
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 20);

  const angleStep = (2 * Math.PI) / Math.max(donees.length, 1);

  const nodes = donees.map((d, i) => {
    const angle = angleStep * i - Math.PI / 2;
    return {
      ...d,
      x: CX + RADIUS * Math.cos(angle),
      y: CY + RADIUS * Math.sin(angle),
      isReciprocal: reciprocalBNs.has(d.bn),
    };
  });

  const maxAmount = Math.max(...nodes.map((n) => n.amount), 1);

  return (
    <div style={{ overflowX: "auto", marginBottom: "1.5rem" }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        style={{ maxWidth: WIDTH, border: "1px solid var(--gc-border)", borderRadius: "6px", background: "var(--gc-bg-secondary)" }}
        role="img"
        aria-label={`Network graph showing transfers from ${centerBN} to ${donees.length} donees`}
      >
        {/* Lines */}
        {nodes.map((node, i) => {
          const strokeWidth = 1 + 3 * (node.amount / maxAmount);
          return (
            <g key={`line-${i}`}>
              <line
                x1={CX}
                y1={CY}
                x2={node.x}
                y2={node.y}
                stroke={node.isReciprocal ? "var(--risk-critical)" : "var(--gc-secondary)"}
                strokeWidth={strokeWidth}
                strokeOpacity={0.5}
              />
              {/* Amount label on line midpoint */}
              <text
                x={(CX + node.x) / 2}
                y={(CY + node.y) / 2 - 4}
                textAnchor="middle"
                fontSize="9"
                fill="var(--gc-text-secondary)"
                fontFamily="var(--font-mono)"
              >
                {formatDollars(node.amount)}
              </text>
            </g>
          );
        })}

        {/* Center node */}
        <circle cx={CX} cy={CY} r={22} fill="var(--gc-primary)" />
        <text x={CX} y={CY + 1} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="var(--font-mono)">
          {centerBN.length > 12 ? centerBN.slice(0, 9) : centerBN}
        </text>
        <text x={CX} y={CY + 32} textAnchor="middle" fontSize="10" fill="var(--gc-primary)" fontWeight="700">
          Donor
        </text>

        {/* Donee nodes */}
        {nodes.map((node, i) => {
          const nodeRadius = 8 + 10 * (node.amount / maxAmount);
          const labelX = node.x + (node.x > CX ? 14 : -14);
          return (
            <g key={`node-${i}`}>
              <circle
                cx={node.x}
                cy={node.y}
                r={nodeRadius}
                fill={node.isReciprocal ? "var(--risk-critical)" : "var(--gc-secondary)"}
                stroke="white"
                strokeWidth="2"
              />
              <text
                x={labelX}
                y={node.y - 6}
                textAnchor={node.x > CX ? "start" : "end"}
                fontSize="9"
                fill="var(--gc-text)"
                fontWeight="600"
              >
                {node.name.length > 25 ? node.name.slice(0, 24) + "…" : node.name}
              </text>
              <text
                x={labelX}
                y={node.y + 6}
                textAnchor={node.x > CX ? "start" : "end"}
                fontSize="8"
                fill="var(--gc-text-secondary)"
                fontFamily="var(--font-mono)"
              >
                {node.bn}
              </text>
              {node.isReciprocal && (
                <text
                  x={labelX}
                  y={node.y + 17}
                  textAnchor={node.x > CX ? "start" : "end"}
                  fontSize="8"
                  fill="var(--risk-critical)"
                  fontWeight="700"
                >
                  ⟲ Reciprocal
                </text>
              )}
            </g>
          );
        })}

        {/* Legend */}
        <g transform={`translate(12, ${HEIGHT - 48})`}>
          <rect x="0" y="0" width="180" height="40" rx="4" fill="white" fillOpacity="0.9" stroke="var(--gc-border)" />
          <line x1="8" y1="12" x2="28" y2="12" stroke="var(--gc-secondary)" strokeWidth="2" />
          <text x="32" y="15" fontSize="9" fill="var(--gc-text)">Transfer</text>
          <line x1="8" y1="28" x2="28" y2="28" stroke="var(--risk-critical)" strokeWidth="2" />
          <text x="32" y="31" fontSize="9" fill="var(--gc-text)">Reciprocal (flagged)</text>
        </g>
      </svg>
    </div>
  );
}
