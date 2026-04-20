"use client";

import {
  Treemap,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

export interface VendorDatum {
  name: string;
  value: number;
  share: number;
  [key: string]: string | number;
}

const COLORS = ["#003F5C", "#58508D", "#BC5090", "#FF6361", "#FFA600"];

function fmtDollars(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

interface TreemapContentProps {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  name: string;
  share: number;
}

function CustomContent(props: TreemapContentProps) {
  const { x, y, width, height, index, name, share } = props;
  const color = COLORS[index % COLORS.length];
  const showLabel = width > 60 && height > 36;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={color}
        stroke="#fff"
        strokeWidth={2}
        rx={3}
      />
      {showLabel && (
        <>
          <text
            x={x + width / 2}
            y={y + height / 2 - 6}
            textAnchor="middle"
            fill="#fff"
            fontSize={Math.min(12, width / 8)}
            fontWeight={600}
          >
            {name.length > 18 ? name.slice(0, 16) + "…" : name}
          </text>
          <text
            x={x + width / 2}
            y={y + height / 2 + 10}
            textAnchor="middle"
            fill="rgba(255,255,255,0.85)"
            fontSize={Math.min(10, width / 10)}
          >
            {share.toFixed(1)}%
          </text>
        </>
      )}
    </g>
  );
}

function TreemapTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: VendorDatum }>;
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
      }}
    >
      <div style={{ fontWeight: 700 }}>{d.name}</div>
      <div>Total Value: {fmtDollars(d.value)}</div>
      <div>Market Share: {d.share.toFixed(2)}%</div>
    </div>
  );
}

function BarTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: VendorDatum }>;
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
      }}
    >
      <div style={{ fontWeight: 700 }}>{d.name}</div>
      <div>{fmtDollars(d.value)} ({d.share.toFixed(2)}%)</div>
    </div>
  );
}

export default function VendorTreemapChart({
  treemapData,
  barData,
}: {
  treemapData: VendorDatum[];
  barData: VendorDatum[];
}) {
  return (
    <div>
      {/* Treemap */}
      <figure style={{ margin: 0 }}>
        <figcaption
          style={{
            fontWeight: 600,
            fontSize: "1rem",
            marginBottom: "0.5rem",
            color: "var(--gc-primary)",
          }}
        >
          Top 20 Vendors by Total Contract Value (Treemap)
        </figcaption>
        <ResponsiveContainer width="100%" height={420}>
          <Treemap
            data={treemapData}
            dataKey="value"
            nameKey="name"
            content={<CustomContent x={0} y={0} width={0} height={0} index={0} name="" share={0} />}
          >
            <Tooltip content={<TreemapTooltip />} />
          </Treemap>
        </ResponsiveContainer>
      </figure>

      {/* Bar chart */}
      <figure style={{ margin: "2rem 0 0" }}>
        <figcaption
          style={{
            fontWeight: 600,
            fontSize: "1rem",
            marginBottom: "0.5rem",
            color: "var(--gc-primary)",
          }}
        >
          Top 10 Vendors — Horizontal Bar Chart
        </figcaption>
        <ResponsiveContainer width="100%" height={400}>
          <BarChart
            data={barData}
            layout="vertical"
            margin={{ top: 10, right: 30, bottom: 10, left: 180 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis
              type="number"
              tickFormatter={(v: number) => fmtDollars(v)}
              tick={{ fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={170}
              tick={{ fontSize: 11 }}
            />
            <Tooltip content={<BarTooltip />} />
            <Bar dataKey="value" fill="#003F5C" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </figure>
    </div>
  );
}
