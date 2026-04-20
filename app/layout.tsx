import type { Metadata } from "next";
import "./globals.css";
import MainNav from "@/components/MainNav";
import AskAIBanner from "@/components/AskAIBanner";

export const metadata: Metadata = {
  title: "Open Data Accountability Platform",
  description:
    "Government of Canada Open Data Accountability Platform - querying 3M+ federal records for transparency and accountability.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        <header
          style={{
            background: "var(--gc-primary)",
            color: "white",
            padding: "0.75rem 1.5rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontSize: "1.5rem" }} aria-hidden="true">
              🍁
            </span>
            <span style={{ fontWeight: 700, fontSize: "1.125rem" }}>
              Open Data Accountability Platform
            </span>
          </div>
          <MainNav />
        </header>

        <AskAIBanner />

        <main id="main-content">{children}</main>

        <footer
          style={{
            borderTop: "1px solid var(--gc-border)",
            padding: "1rem 1.5rem",
            color: "var(--gc-text-secondary)",
            fontSize: "0.875rem",
            textAlign: "center",
            marginTop: "2rem",
          }}
        >
          Data sourced from{" "}
          <a
            href="https://open.canada.ca"
            style={{
              color: "#0b3d68",
              textDecoration: "underline",
              fontWeight: 600,
            }}
          >
            open.canada.ca
          </a>{" "}
          - Government of Canada Open Data Portal
        </footer>
      </body>
    </html>
  );
}
