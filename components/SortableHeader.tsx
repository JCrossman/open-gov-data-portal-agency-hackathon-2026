import type { CSSProperties } from "react";
import type { SortResult, SortDirection } from "@/lib/sort-params";

/**
 * Accessible sortable `<th>` component.
 *
 * - Renders a real anchor tag → works without JS, keyboard-native, SR-readable.
 * - Communicates state via `aria-sort` AND a visible ▲/▼/↕ glyph (WCAG 1.4.1).
 * - Click toggles direction for the active column; otherwise jumps to
 *   `defaultDir` (typical: "desc" for numeric metrics, "asc" for names).
 */
export default function SortableHeader<K extends string>({
  columnKey,
  label,
  sort,
  align = "left",
  defaultDir = "desc",
  style,
  preserve,
  info,
}: {
  columnKey: K;
  label: string;
  sort: SortResult<K>;
  align?: "left" | "right" | "center";
  defaultDir?: SortDirection;
  style?: CSSProperties;
  preserve?: Record<string, string | undefined>;
  info?: string;
}) {
  const isActive = sort.key === columnKey;
  const ariaSort: "ascending" | "descending" | "none" = isActive
    ? sort.direction === "asc"
      ? "ascending"
      : "descending"
    : "none";
  const glyph = isActive ? (sort.direction === "asc" ? "▲" : "▼") : "↕";
  const href = sort.hrefFor(columnKey, defaultDir, preserve);
  const sortHint = `Sort by ${label} ${isActive && sort.direction === "asc" ? "descending" : "ascending"}`;
  const titleText = info ? `${info} — ${sortHint}` : sortHint;

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      style={{
        textAlign: align,
        padding: "0.5rem",
        ...style,
      }}
    >
      <a
        href={href}
        style={{
          color: "inherit",
          textDecoration: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: "0.375rem",
          cursor: "pointer",
          fontWeight: isActive ? 700 : 600,
          padding: "0.125rem 0.25rem",
          borderRadius: 3,
        }}
        title={titleText}
        aria-label={info ? `${label}. ${info}. ${sortHint}.` : sortHint}
      >
        <span>{label}</span>
        {info ? (
          <span
            aria-hidden="true"
            title={info}
            style={{
              fontSize: "0.65em",
              fontWeight: 700,
              border: "1px solid currentColor",
              borderRadius: "50%",
              width: "1.1em",
              height: "1.1em",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: 0.7,
              cursor: "help",
            }}
          >
            i
          </span>
        ) : null}
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
      </a>
    </th>
  );
}
