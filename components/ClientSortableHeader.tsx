"use client";

import type { CSSProperties } from "react";
import type { ClientSortDirection } from "@/lib/use-client-sort";

/**
 * Accessible client-side sortable `<th>`.
 *
 * - Renders a real <button> inside <th>, so keyboard activation (Enter/Space)
 *   toggles the sort. aria-sort communicates state to screen readers. Visible
 *   ▲/▼/↕ glyph ensures state isn't color-only (WCAG 1.4.1).
 */
export default function ClientSortableHeader<K extends string>({
  columnKey,
  label,
  activeKey,
  direction,
  onSort,
  align = "left",
  defaultDir = "desc",
  style,
}: {
  columnKey: K;
  label: string;
  activeKey: K;
  direction: ClientSortDirection;
  onSort: (key: K, defaultDir?: ClientSortDirection) => void;
  align?: "left" | "right" | "center";
  defaultDir?: ClientSortDirection;
  style?: CSSProperties;
}) {
  const isActive = activeKey === columnKey;
  const ariaSort: "ascending" | "descending" | "none" = isActive
    ? direction === "asc"
      ? "ascending"
      : "descending"
    : "none";
  const glyph = isActive ? (direction === "asc" ? "▲" : "▼") : "↕";

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      style={{ textAlign: align, padding: "0.5rem", ...style }}
    >
      <button
        type="button"
        onClick={() => onSort(columnKey, defaultDir)}
        style={{
          background: "none",
          border: "none",
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          padding: "0.125rem 0.25rem",
          borderRadius: 3,
          display: "inline-flex",
          alignItems: "center",
          gap: "0.375rem",
          fontWeight: isActive ? 700 : 600,
          textAlign: align,
          width: "100%",
          justifyContent:
            align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
        }}
        title={`Sort by ${label} ${isActive && direction === "asc" ? "descending" : "ascending"}`}
      >
        <span>{label}</span>
        <span
          aria-hidden="true"
          style={{
            fontSize: "0.75em",
            opacity: isActive ? 1 : 0.45,
            color: isActive ? "var(--gc-secondary, #26374a)" : "inherit",
          }}
        >
          {glyph}
        </span>
      </button>
    </th>
  );
}
