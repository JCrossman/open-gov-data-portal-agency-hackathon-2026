"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatChartValue,
  pickChart,
  type ChartHint,
  type ChartSpec,
} from "@/lib/auto-chart";

interface AutoChartProps {
  rows: Record<string, unknown>[];
  hint?: ChartHint | null;
}

// 8-step colour-blind-safe palette (Okabe–Ito + one GC-brand primary).
const PALETTE = [
  "#0b3d68",
  "#e69f00",
  "#56b4e9",
  "#009e73",
  "#f0e442",
  "#cc79a7",
  "#d55e00",
  "#999999",
];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function humanize(col: string): string {
  return col.replace(/_/g, " ");
}

function toNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function KPICard({ spec }: { spec: ChartSpec }) {
  const n = toNum(spec.data[0]?.[spec.yKey]);
  return (
    <figure
      style={{
        margin: 0,
        padding: "1.25rem 1.5rem",
        background: "var(--gc-bg)",
        border: "1px solid var(--gc-border)",
        borderRadius: "8px",
      }}
      aria-label={spec.summary}
      role="img"
    >
      <div
        style={{
          fontSize: "0.8125rem",
          color: "var(--gc-text-secondary)",
          marginBottom: "0.25rem",
          textTransform: "capitalize",
        }}
      >
        {humanize(spec.yKey)}
      </div>
      <div
        style={{
          fontSize: "2rem",
          fontWeight: 700,
          color: "var(--gc-primary)",
          lineHeight: 1.2,
        }}
      >
        {formatChartValue(n, spec.isDollar)}
      </div>
      <figcaption
        style={{
          marginTop: "0.25rem",
          fontSize: "0.75rem",
          color: "var(--gc-text-secondary)",
        }}
      >
        {spec.title}
      </figcaption>
    </figure>
  );
}

function pivotForMultiSeries(
  spec: ChartSpec,
): { pivoted: Record<string, unknown>[]; series: string[] } {
  const xKey = spec.xKey;
  const seriesKey = spec.seriesKey!;
  const yKey = spec.yKey;
  const seriesOrdered = spec.seriesValues ?? [];
  const bucket = new Map<string, Record<string, number | string>>();
  for (const r of spec.data) {
    const xVal = String(r[xKey] ?? "—");
    const sVal = String(r[seriesKey] ?? "—");
    if (!bucket.has(xVal)) bucket.set(xVal, { [xKey]: xVal });
    const row = bucket.get(xVal)!;
    row[sVal] = toNum(row[sVal]) + toNum(r[yKey]);
  }
  const pivoted = [...bucket.values()];
  // Sort x values: numeric ascending if temporal, otherwise by total desc.
  const allNumeric = pivoted.every((p) => {
    const v = p[xKey];
    return typeof v === "string" && /^-?\d+$/.test(v);
  });
  if (allNumeric) {
    pivoted.sort(
      (a, b) => parseInt(String(a[xKey]), 10) - parseInt(String(b[xKey]), 10),
    );
  } else {
    pivoted.sort((a, b) => {
      const at = seriesOrdered.reduce((acc, s) => acc + toNum(a[s]), 0);
      const bt = seriesOrdered.reduce((acc, s) => acc + toNum(b[s]), 0);
      return bt - at;
    });
  }
  return { pivoted, series: seriesOrdered };
}

function ChartSurface({ spec }: { spec: ChartSpec }) {
  const reduced = useReducedMotion();
  const isMulti =
    spec.type === "stacked_bar" ||
    spec.type === "grouped_bar" ||
    spec.type === "multi_line";
  const pivot = useMemo(
    () => (isMulti ? pivotForMultiSeries(spec) : null),
    [isMulti, spec],
  );

  const height = 320;
  const commonMargin = { top: 16, right: 24, bottom: 24, left: 12 };
  const formatAxis = (v: number) => formatChartValue(v, spec.isDollar);

  // The figure wraps everything so AT gets one semantic group.
  const figureStyle: React.CSSProperties = {
    margin: 0,
    padding: "0.75rem",
    background: "var(--gc-bg)",
    border: "1px solid var(--gc-border)",
    borderRadius: "8px",
  };

  if (spec.type === "kpi") return <KPICard spec={spec} />;

  return (
    <figure style={figureStyle} aria-label={spec.summary}>
      <figcaption
        style={{
          fontSize: "0.8125rem",
          color: "var(--gc-text-secondary)",
          marginBottom: "0.5rem",
          fontWeight: 600,
        }}
      >
        {spec.title}
        {spec.caption ? (
          <span style={{ fontWeight: 400, marginLeft: "0.5rem" }}>
            · {spec.caption}
          </span>
        ) : null}
      </figcaption>
      <div role="img" aria-label={spec.summary} style={{ width: "100%" }}>
        <ResponsiveContainer width="100%" height={height}>
          {spec.type === "line" ? (
            <LineChart data={spec.data} margin={commonMargin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e6eb" />
              <XAxis dataKey={spec.xKey} tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={formatAxis} />
              <Tooltip
                formatter={(v) => formatChartValue(toNum(v), spec.isDollar)}
              />
              <Line
                type="monotone"
                dataKey={spec.yKey}
                stroke={PALETTE[0]}
                strokeWidth={2}
                dot={{ r: 3 }}
                isAnimationActive={!reduced}
              />
            </LineChart>
          ) : spec.type === "multi_line" ? (
            <LineChart data={pivot!.pivoted} margin={commonMargin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e6eb" />
              <XAxis dataKey={spec.xKey} tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={formatAxis} />
              <Tooltip
                formatter={(v) => formatChartValue(toNum(v), spec.isDollar)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {pivot!.series.map((s, i) => (
                <Line
                  key={s}
                  type="monotone"
                  dataKey={s}
                  stroke={PALETTE[i % PALETTE.length]}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  isAnimationActive={!reduced}
                />
              ))}
            </LineChart>
          ) : spec.type === "stacked_bar" || spec.type === "grouped_bar" ? (
            <BarChart data={pivot!.pivoted} margin={commonMargin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e6eb" />
              <XAxis dataKey={spec.xKey} tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={formatAxis} />
              <Tooltip
                formatter={(v) => formatChartValue(toNum(v), spec.isDollar)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {pivot!.series.map((s, i) => (
                <Bar
                  key={s}
                  dataKey={s}
                  stackId={spec.type === "stacked_bar" ? "a" : undefined}
                  fill={PALETTE[i % PALETTE.length]}
                  isAnimationActive={!reduced}
                />
              ))}
            </BarChart>
          ) : spec.orientation === "horizontal" ? (
            <BarChart
              data={spec.data}
              layout="vertical"
              margin={{ ...commonMargin, left: 80 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e6eb" />
              <XAxis type="number" tickFormatter={formatAxis} tick={{ fontSize: 12 }} />
              <YAxis
                type="category"
                dataKey={spec.xKey}
                tick={{ fontSize: 11 }}
                width={140}
                interval={0}
              />
              <Tooltip
                formatter={(v) => formatChartValue(toNum(v), spec.isDollar)}
              />
              <Bar dataKey={spec.yKey} isAnimationActive={!reduced}>
                {spec.data.map((_, i) => (
                  <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <BarChart data={spec.data} margin={commonMargin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e6eb" />
              <XAxis
                dataKey={spec.xKey}
                tick={{ fontSize: 11 }}
                interval={0}
                angle={spec.data.length > 8 ? -30 : 0}
                textAnchor={spec.data.length > 8 ? "end" : "middle"}
                height={spec.data.length > 8 ? 60 : 30}
              />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={formatAxis} />
              <Tooltip
                formatter={(v) => formatChartValue(toNum(v), spec.isDollar)}
              />
              <Bar dataKey={spec.yKey} isAnimationActive={!reduced}>
                {spec.data.map((_, i) => (
                  <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export default function AutoChart({ rows, hint }: AutoChartProps) {
  const spec = useMemo(() => pickChart(rows, hint ?? undefined), [rows, hint]);
  if (!spec) return null;
  return <ChartSurface spec={spec} />;
}

export function hasChart(
  rows: Record<string, unknown>[],
  hint?: ChartHint | null,
): boolean {
  return pickChart(rows, hint ?? undefined) !== null;
}
