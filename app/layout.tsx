import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { LangProvider } from "@/lib/lang";
import { pickLang } from "@/lib/i18n";
import SiteHeader from "@/components/SiteHeader";
import AutoTranslate from "@/components/AutoTranslate";
import AskAIBanner from "@/components/AskAIBanner";

export const metadata: Metadata = {
  title: "Open Data Accountability Platform",
  description:
    "Government of Canada Open Data Accountability Platform - querying 3M+ federal records for transparency and accountability.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const hdrs = await headers();
  const lang = pickLang(
    cookieStore.get("lang")?.value,
    hdrs.get("accept-language")
  );

  return (
    <html lang={lang}>
      <body>
        <LangProvider initialLang={lang}>
          <a href="#main-content" className="skip-link">
            Skip to main content
          </a>

          <SiteHeader />
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

          <AutoTranslate />
        </LangProvider>
      </body>
    </html>
  );
}
