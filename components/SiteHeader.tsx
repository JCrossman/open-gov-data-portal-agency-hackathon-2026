"use client";

import LanguageToggle from "@/components/LanguageToggle";
import MainNav from "@/components/MainNav";
import { useLang } from "@/lib/lang";

export default function SiteHeader() {
  const { lang } = useLang();
  return (
    <header
      style={{
        background: "var(--gc-primary)",
        color: "white",
        padding: "0.75rem 1.5rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        flexWrap: "wrap",
      }}
      lang={lang}
    >
      <a
        href="/"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          color: "white",
          textDecoration: "none",
        }}
      >
        <span style={{ fontSize: "1.5rem" }} aria-hidden="true">
          🍁
        </span>
        <span style={{ fontWeight: 700, fontSize: "1.125rem" }}>
          Open Data Accountability Platform
        </span>
      </a>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <MainNav />
        <LanguageToggle />
      </div>
    </header>
  );
}
