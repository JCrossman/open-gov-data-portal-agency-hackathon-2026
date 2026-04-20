"use client";

import { useLang } from "@/lib/lang";
import type { Lang } from "@/lib/i18n";

/**
 * Persistent EN | FR segmented toggle. Uses `aria-pressed` on the inactive
 * option and rewrites `<html lang>` via LangProvider's effect.
 */
export default function LanguageToggle({
  style,
}: {
  style?: React.CSSProperties;
}) {
  const { lang, setLang } = useLang();

  const btn = (target: Lang, label: string) => {
    const active = lang === target;
    return (
      <button
        type="button"
        onClick={() => setLang(target)}
        aria-pressed={active}
        aria-label={
          target === "fr"
            ? "Afficher en français"
            : "Display in English"
        }
        lang={target}
        style={{
          minHeight: "40px",
          minWidth: "44px",
          padding: "0.4rem 0.75rem",
          background: active ? "var(--gc-primary)" : "var(--gc-bg)",
          color: active ? "white" : "var(--gc-text)",
          border: "none",
          fontSize: "0.8125rem",
          fontWeight: 600,
          cursor: "pointer",
          letterSpacing: "0.02em",
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      role="group"
      aria-label="Language / Langue"
      style={{
        display: "inline-flex",
        border: "1px solid var(--gc-border)",
        borderRadius: "6px",
        overflow: "hidden",
        ...style,
      }}
    >
      {btn("en", "EN")}
      <span
        aria-hidden="true"
        style={{
          width: 1,
          background: "var(--gc-border)",
        }}
      />
      {btn("fr", "FR")}
    </div>
  );
}
