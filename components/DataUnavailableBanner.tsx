interface DataUnavailableBannerProps {
  scope: string;
  error?: string;
}

export default function DataUnavailableBanner({ scope, error }: DataUnavailableBannerProps) {
  const summary = error ? summarizeError(error) : undefined;
  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        background: "#FFF8E6",
        border: "2px solid #D97706",
        borderLeft: "6px solid #D97706",
        color: "#3A2A00",
        borderRadius: 8,
        padding: "1rem 1.25rem",
        margin: "1.5rem 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
        <span aria-hidden="true" style={{ fontSize: "1.25rem" }}>⚠️</span>
        <strong style={{ fontSize: "1rem" }}>Data temporarily unavailable</strong>
      </div>
      <p style={{ margin: "0.5rem 0 0", fontSize: "0.9375rem", lineHeight: 1.5 }}>
        {scope} could not be loaded right now. This is a system error, not a
        finding of zero results. Please retry shortly; the dashboard will
        refresh automatically within the hour.
      </p>
      {summary && (
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.8125rem", color: "#5C3A00" }}>
            Technical details
          </summary>
          <code
            className="font-mono"
            style={{
              display: "block",
              marginTop: "0.375rem",
              padding: "0.375rem 0.5rem",
              background: "#FFEFCC",
              borderRadius: 4,
              fontSize: "0.75rem",
              wordBreak: "break-word",
            }}
          >
            {summary}
          </code>
        </details>
      )}
    </div>
  );
}

function summarizeError(error: string): string {
  const firstLine = error.split("\n")[0].trim();
  return firstLine.length > 200 ? firstLine.slice(0, 197) + "…" : firstLine;
}
