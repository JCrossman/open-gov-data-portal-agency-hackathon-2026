import type { CSSProperties } from "react";

/**
 * Accessible signal badge — a small chip with a tooltip explaining what
 * the signal means. Used for ghost-capacity / zombie-recipients flags.
 *
 * - `title` provides a hover tooltip for sighted mouse users.
 * - `aria-label` exposes the same explanation to screen readers.
 * - Visual style does not rely on color alone (border + label).
 */
export default function SignalBadge({
  label,
  description,
  tone = "neutral",
  style,
}: {
  label: string;
  description: string;
  tone?: "neutral" | "warning" | "info";
  style?: CSSProperties;
}) {
  const palette: Record<string, { bg: string; fg: string; border: string }> = {
    neutral: { bg: "#f3f4f6", fg: "#1f2937", border: "#cbd5e1" },
    warning: { bg: "#fef3c7", fg: "#78350f", border: "#fbbf24" },
    info:    { bg: "#dbeafe", fg: "#1e3a8a", border: "#60a5fa" },
  };
  const c = palette[tone];

  return (
    <span
      title={description}
      aria-label={`${label}: ${description}`}
      style={{
        display: "inline-block",
        padding: "0.125rem 0.5rem",
        margin: "0.125rem",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
        fontSize: "0.75rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
        cursor: "help",
        ...style,
      }}
    >
      {label}
    </span>
  );
}
