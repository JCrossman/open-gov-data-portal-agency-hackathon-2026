"use client";

// Cookie-backed language context for client components. Server components
// should read the `lang` cookie directly from headers/cookies().

import { createContext, createElement, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { type Lang } from "./i18n";

export const LANG_COOKIE = "lang";

function readCookieLang(): Lang | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)lang=([^;]+)/);
  if (m) {
    const v = decodeURIComponent(m[1]).toLowerCase();
    if (v === "fr") return "fr";
    if (v === "en") return "en";
  }
  return null;
}

function detectNavigatorLang(): Lang {
  // Mirror the server-side pickLang behaviour: default English, only pick
  // French when the browser's highest-priority language explicitly says so.
  if (typeof navigator === "undefined") return "en";
  const list: string[] =
    (Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? (navigator.languages as string[])
      : navigator.language
        ? [navigator.language]
        : []);
  for (const raw of list) {
    const tag = (raw || "").toLowerCase();
    if (!tag) continue;
    if (tag.startsWith("fr")) return "fr";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

function writeCookieLang(lang: Lang) {
  if (typeof document === "undefined") return;
  // 1 year, root path, same-site lax
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
};

const LangContext = createContext<Ctx>({ lang: "en", setLang: () => {} });

export function LangProvider({
  initialLang,
  children,
}: {
  initialLang?: Lang;
  children: ReactNode;
}) {
  const [lang, setLangState] = useState<Lang>(initialLang ?? "en");

  // Hydrate from cookie on mount if no initial was provided.
  useEffect(() => {
    if (!initialLang) {
      const fromCookie = readCookieLang();
      setLangState(fromCookie ?? detectNavigatorLang());
    }
  }, [initialLang]);

  // Keep <html lang="..."> in sync for screen readers (WCAG 3.1.1).
  useEffect(() => {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writeCookieLang(l);
  }, []);

  return createElement(LangContext.Provider, { value: { lang, setLang } }, children);
}

export function useLang(): Ctx {
  return useContext(LangContext);
}
