"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

export interface AmendmentDatum {
  vendor: string;
  amendmentRatio: number;
  originalValue: number;
  effectiveValue: number;
}

function fmtDollars(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: AmendmentDatum }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #ccc",
        borderRadius: 6,
        padding: "0.75rem",
        fontSize: "0.8125rem",
        lineHeight: 1.5,
        maxWidth: 280,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.vendor}</div>
      <div>Original: {fmtDollars(d.originalValue)}</div>
      <div>Current: {fmtDollars(d.effectiveValue)}</div>
      <div style={{ fontWeight: 700, color: "#AF3C43" }}>
        Ratio: {d.amendmentRatio.toFixed(1)}×
      </div>
    </div>
  );
}

export default function AmendmentCreepChart({
  data,
}: {
  data: AmendmentDatum[];
}) {
  return (
    <ResponsiveContainer width="100%" height={480}>
      <BarChart
        data={data}
        margin={{ top: 10, right: 20, bottom: 80, left: 20 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
        <XAxis
          dataKey="vendor"
          angle={-35}
          textAnchor="end"
          interval={0}
          tick={{ fontSize: 11, fill: "#333" }}
          height={100}
        />
        <YAxis
          tick={{ fontSize: 12 }}
          label={{
            value: "Amendment Ratio (×)",
            angle: -90,
            position: "insideLeft",
            style: { fontSize: 12, fill: "#595959" },
          }}
        />
        <Tooltip content={<CustomTooltip />} />
        <ReferenceLine
          y={1}
          stroke="#26374A"
          strokeDasharray="6 4"
          label={{
            value: "1× baseline",
            position: "right",
            fill: "#26374A",
            fontSize: 11,
          }}
        />
        <Bar dataKey="amendmentRatio" fill="#AF3C43" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
