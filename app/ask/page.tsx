"use client";

import { useState, useRef, useEffect } from "react";
import { useClientSort } from "@/lib/use-client-sort";
import ClientSortableHeader from "@/components/ClientSortableHeader";
import AutoChart, { hasChart } from "@/components/charts/AutoChart";
import type { ChartHint } from "@/lib/auto-chart";

interface QueryResult {
  question: string;
  sql: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsed: number;
  error?: string;
  chart_hint?: ChartHint | null;
}

const DOLLAR_HINTS = /value|spending|funding|cost|amount|revenue|expenditure|salary|compensation|total_?grant|total_?contract|agreement|budget/i;
const RAW_ID_HINTS = /^id$|_id$|^bn$|^reference|^postal|^phone|^fax|^year$|^fiscal/i;

function fmtValue(v: unknown, colName?: string): string {
  if (v === null || v === undefined) return "—";

  // ID-like columns: render as plain strings, no formatting
  if (colName && RAW_ID_HINTS.test(colName)) return String(v);

  // Coerce numeric strings to numbers
  let n: number | null = null;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    n = parseFloat(v);
  }

  if (n !== null && Number.isFinite(n)) {
    const isDollar = colName ? DOLLAR_HINTS.test(colName) : false;
    if (isDollar) {
      if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
      if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
      if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
      if (Math.abs(n) >= 1e3) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    }
    if (Number.isInteger(n)) return n.toLocaleString();
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  return String(v);
}

function QueryResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  // Discover columns from first row
  const rowsArray: Record<string, unknown>[] = rows ?? [];
  const columns: string[] = rowsArray.length ? Object.keys(rowsArray[0]) : [];

  // Build getters for every discovered column; coerce numeric-looking strings to Number for proper numeric sort
  const getters = columns.reduce<Record<string, (r: Record<string, unknown>) => string | number>>((acc, c) => {
    acc[c] = (r) => {
      const v = r[c];
      if (v == null) return "";
      if (typeof v === "number") return v;
      const n = Number(v);
      if (!Number.isNaN(n) && String(v).trim() !== "" && /^-?\d/.test(String(v))) return n;
      return String(v).toLowerCase();
    };
    return acc;
  }, {});

  const initialKey = columns[0] ?? "_";
  const sort = useClientSort(rowsArray, getters, { key: initialKey, direction: "desc" });

  if (rowsArray.length === 0) return null;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
            {columns.map((col) => (
              <ClientSortableHeader
                key={col}
                columnKey={col}
                label={col.replace(/_/g, " ")}
                activeKey={sort.key}
                direction={sort.direction}
                onSort={sort.toggle}
                align="left"
                defaultDir="desc"
                style={{ textAlign: "left", padding: "0.4rem 0.5rem", fontWeight: 600, whiteSpace: "nowrap" }}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {sort.rows.map((row, ri) => {
            const keys = Object.keys(row);
            return (
            <tr key={ri} style={{ borderBottom: "1px solid var(--gc-border)", background: ri % 2 === 1 ? "var(--gc-bg)" : "transparent" }}>
              {Object.values(row).map((val, ci) => (
                <td key={ci} style={{ padding: "0.35rem 0.5rem", whiteSpace: "nowrap", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {fmtValue(val, keys[ci])}
                </td>
              ))}
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<QueryResult[]>([]);
  const [showSQL, setShowSQL] = useState<number | null>(null);
  const [views, setViews] = useState<Record<number, "chart" | "table">>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [results]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;

    setLoading(true);
    setQuestion("");

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          history: results
            .filter((r) => !r.error && r.sql)
            .map((r) => ({ question: r.question, sql: r.sql })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResults((prev) => [...prev, { question: q, sql: data.sql ?? "", rows: [], rowCount: 0, elapsed: 0, error: data.error }]);
      } else {
        setResults((prev) => [...prev, data]);
      }
    } catch (err) {
      setResults((prev) => [...prev, { question: q, sql: "", rows: [], rowCount: 0, elapsed: 0, error: (err as Error).message }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const examples = [
    "Which 10 departments spent the most on sole-source contracts?",
    "What are the top 5 grant recipients by total funding?",
    "How many charities have over 90% government dependency?",
    "Show the largest contracts awarded to IBM",
    "Which provinces receive the most grant funding?",
    "Find charities where directors serve on 3+ boards",
  ];

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "1.5rem", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <a href="/" style={{ color: "var(--gc-secondary)", textDecoration: "none", fontSize: "0.875rem" }}>
        &larr; Back to Dashboard
      </a>

      <h1 style={{ fontSize: "2rem", marginTop: "0.75rem", marginBottom: "0.5rem" }}>
        Ask the Data
      </h1>
      <p style={{ color: "var(--gc-text-secondary)", marginBottom: "1.5rem", fontSize: "0.9375rem" }}>
        Ask natural language questions about 3M+ federal contracts, grants, and charity records.
        AI translates your question into SQL and returns real-time results.{" "}
        <strong>You can ask follow-ups</strong> — try &ldquo;now break that down by year&rdquo; or
        &ldquo;show the same for Ontario only&rdquo;.
      </p>

      {results.length === 0 && (
        <div style={{ marginBottom: "2rem" }}>
          <div style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", marginBottom: "0.75rem", fontWeight: 600 }}>
            Try these examples:
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => { setQuestion(ex); inputRef.current?.focus(); }}
                style={{
                  background: "var(--gc-bg-secondary)",
                  border: "1px solid var(--gc-border)",
                  borderRadius: "6px",
                  padding: "0.5rem 0.75rem",
                  fontSize: "0.8125rem",
                  cursor: "pointer",
                  color: "var(--gc-text)",
                  textAlign: "left",
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", marginBottom: "1rem" }}>
        {results.map((r, i) => (
          <div key={i} style={{ marginBottom: "1.5rem" }}>
            {/* Question */}
            <div style={{
              background: "var(--gc-primary)",
              color: "white",
              padding: "0.75rem 1rem",
              borderRadius: "8px 8px 2px 8px",
              marginBottom: "0.5rem",
              maxWidth: "85%",
              marginLeft: "auto",
              fontSize: "0.9375rem",
            }}>
              {r.question}
            </div>

            {/* Answer */}
            <div style={{
              background: "var(--gc-bg-secondary)",
              border: "1px solid var(--gc-border)",
              borderRadius: "2px 8px 8px 8px",
              padding: "1rem",
              maxWidth: "95%",
            }}>
              {r.error ? (
                <div style={{ color: "var(--risk-critical)", fontSize: "0.875rem" }}>
                  ⚠️ {r.error}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)", marginBottom: "0.5rem" }}>
                    {r.rowCount} row{r.rowCount !== 1 ? "s" : ""} · {r.elapsed}ms
                    <button
                      onClick={() => setShowSQL(showSQL === i ? null : i)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--gc-secondary)",
                        cursor: "pointer",
                        marginLeft: "0.75rem",
                        fontSize: "0.75rem",
                        textDecoration: "underline",
                      }}
                    >
                      {showSQL === i ? "Hide SQL" : "Show SQL"}
                    </button>
                  </div>

                  {showSQL === i && (
                    <pre style={{
                      background: "var(--gc-primary)",
                      color: "#e0e0e0",
                      padding: "0.75rem",
                      borderRadius: "4px",
                      fontSize: "0.75rem",
                      overflow: "auto",
                      marginBottom: "0.75rem",
                      whiteSpace: "pre-wrap",
                    }}>
                      {r.sql}
                    </pre>
                  )}

                  {r.rows.length > 0 && (() => {
                    const canChart = hasChart(r.rows, r.chart_hint ?? null);
                    const view = views[i] ?? (canChart ? "chart" : "table");
                    return (
                      <>
                        {canChart && (
                          <div
                            role="group"
                            aria-label="Result display mode"
                            style={{
                              display: "inline-flex",
                              gap: 0,
                              border: "1px solid var(--gc-border)",
                              borderRadius: "6px",
                              overflow: "hidden",
                              marginBottom: "0.75rem",
                            }}
                          >
                            <button
                              type="button"
                              aria-pressed={view === "chart"}
                              onClick={() =>
                                setViews((v) => ({ ...v, [i]: "chart" }))
                              }
                              style={{
                                minHeight: "44px",
                                minWidth: "44px",
                                padding: "0.5rem 0.9rem",
                                background:
                                  view === "chart"
                                    ? "var(--gc-primary)"
                                    : "var(--gc-bg)",
                                color:
                                  view === "chart" ? "white" : "var(--gc-text)",
                                border: "none",
                                borderRight: "1px solid var(--gc-border)",
                                fontSize: "0.8125rem",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              📊 Chart
                            </button>
                            <button
                              type="button"
                              aria-pressed={view === "table"}
                              onClick={() =>
                                setViews((v) => ({ ...v, [i]: "table" }))
                              }
                              style={{
                                minHeight: "44px",
                                minWidth: "44px",
                                padding: "0.5rem 0.9rem",
                                background:
                                  view === "table"
                                    ? "var(--gc-primary)"
                                    : "var(--gc-bg)",
                                color:
                                  view === "table" ? "white" : "var(--gc-text)",
                                border: "none",
                                fontSize: "0.8125rem",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              🗂️ Table
                            </button>
                          </div>
                        )}
                        {view === "chart" && canChart ? (
                          <AutoChart
                            rows={r.rows}
                            hint={r.chart_hint ?? null}
                          />
                        ) : (
                          <QueryResultTable rows={r.rows} />
                        )}
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ padding: "1rem", color: "var(--gc-text-secondary)", fontSize: "0.875rem" }}>
            Analyzing your question and querying the database...
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} style={{
        display: "flex",
        gap: "0.5rem",
        padding: "0.75rem",
        background: "var(--gc-bg-secondary)",
        borderRadius: "8px",
        border: "1px solid var(--gc-border)",
        position: "sticky",
        bottom: "1rem",
      }}>
        <input
          ref={inputRef}
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={results.length === 0 ? "Ask a question about government spending..." : "Ask a follow-up (e.g. 'break that down by year')..."}
          disabled={loading}
          style={{
            flex: 1,
            padding: "0.75rem",
            border: "1px solid var(--gc-border)",
            borderRadius: "6px",
            fontSize: "0.9375rem",
            outline: "none",
            background: "var(--gc-bg)",
            color: "var(--gc-text)",
          }}
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          style={{
            padding: "0.75rem 1.5rem",
            background: loading ? "var(--gc-text-secondary)" : "var(--gc-accent)",
            color: "white",
            border: "none",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: "0.9375rem",
          }}
        >
          {loading ? "..." : "Ask"}
        </button>
      </form>
    </div>
  );
}
