"use client";

import { usePathname } from "next/navigation";

export default function AskAIBanner() {
  const pathname = usePathname();
  if (pathname === "/ask") return null;

  return (
    <a
      href="/ask"
      aria-label="Ask the Data — open the AI-powered natural language query tool"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.875rem 1.25rem",
        background:
          "linear-gradient(135deg, var(--gc-primary), var(--gc-secondary))",
        color: "white",
        textDecoration: "none",
        fontWeight: 600,
        fontSize: "0.9375rem",
        borderBottom: "1px solid rgba(255,255,255,0.15)",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: "1.25rem" }}>
        🔍
      </span>
      <span>Ask the Data — Natural language queries powered by AI</span>
      <span
        aria-hidden="true"
        style={{ marginLeft: "auto", opacity: 0.9, fontSize: "0.875rem" }}
      >
        Try it →
      </span>
    </a>
  );
}
