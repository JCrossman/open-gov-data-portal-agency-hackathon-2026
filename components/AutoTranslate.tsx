"use client";

/**
 * AutoTranslate — page-level Canadian-French translator.
 *
 * When the active language is "fr", after hydration we:
 *   1. Walk the <body> DOM tree.
 *   2. Collect text nodes that are natural-language candidates (skipping code,
 *      scripts, styles, SVG, pure numbers/currency/BNs/URLs, or anything marked
 *      with [translate="no"] / [data-notranslate]).
 *   3. Batch them through /api/translate and replace them in place.
 *   4. Also translate visible attribute values: aria-label, title, placeholder,
 *      alt, value (for submit/button inputs).
 *   5. Cache per-page (pathname × hash of extracted strings) in sessionStorage
 *      so repeat visits are instant.
 *   6. A MutationObserver catches dynamically inserted content (e.g. streaming
 *      answers on /ask, lazy-loaded sections) and translates it too.
 *
 * To prevent the English → French flash on first paint we set
 * `data-translating="true"` on <html> until first translation batch returns;
 * a single CSS rule in globals.css hides the body while that attribute is set.
 */

import { useEffect, useRef } from "react";
import { useLang } from "@/lib/lang";

const TRANSLATABLE_ATTRS = ["aria-label", "title", "placeholder", "alt"] as const;
const NO_TRANSLATE_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "CODE",
  "PRE",
  "KBD",
  "SAMP",
  "VAR",
  "TEXTAREA",
  "SVG",
  "PATH",
  "IFRAME",
]);

// Skip anything that contains no letter-like chars (numbers, $ amounts, BNs,
// URLs, emoji-only, whitespace). A single letter triggers translation.
function hasNaturalLanguage(s: string): boolean {
  if (!s) return false;
  // At least 2 consecutive letters, to avoid translating "A" labels, single
  // initials, column codes, etc.
  return /\p{L}\p{L}/u.test(s);
}

function isEntityNameLike(s: string): boolean {
  // ALL-CAPS acronyms & all-caps entity names (vendors, charities) typically
  // should not be translated. Length > 3 to let genuine acronyms through the
  // translator if they appear mid-sentence.
  if (s.length < 4) return false;
  if (!/^[A-Z0-9\s.&,()'’\-/]+$/.test(s)) return false;
  return /[A-Z]{2,}/.test(s);
}

function isBusinessNumber(s: string): boolean {
  return /^\d{9}RR\d{4}$/i.test(s.trim());
}

function isSkippedElement(el: Element | null): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (NO_TRANSLATE_TAGS.has(cur.tagName)) return true;
    const tr = cur.getAttribute?.("translate");
    if (tr === "no") return true;
    if (cur.hasAttribute?.("data-notranslate")) return true;
    if (cur.getAttribute?.("aria-hidden") === "true") return true;
    cur = cur.parentElement;
  }
  return false;
}

interface Target {
  apply: (value: string) => void;
  original: string;
}

function collectTargets(root: Node): Target[] {
  const targets: Target[] = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const textNode = node as Text;
        const parent = textNode.parentElement;
        if (!parent || isSkippedElement(parent)) return NodeFilter.FILTER_REJECT;
        const v = textNode.nodeValue ?? "";
        if (!hasNaturalLanguage(v)) return NodeFilter.FILTER_REJECT;
        if (isBusinessNumber(v)) return NodeFilter.FILTER_REJECT;
        if (isEntityNameLike(v.trim())) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (isSkippedElement(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP; // traverse children, but element itself isn't returned
      }
      return NodeFilter.FILTER_REJECT;
    },
  });

  // With SHOW_ELEMENT + FILTER_SKIP, text nodes are yielded directly.
  let cur: Node | null = walker.nextNode();
  while (cur) {
    if (cur.nodeType === Node.TEXT_NODE) {
      const textNode = cur as Text;
      const original = textNode.nodeValue ?? "";
      targets.push({
        original,
        apply: (v) => {
          textNode.nodeValue = v;
        },
      });
    }
    cur = walker.nextNode();
  }

  // Attributes — scan separately.
  const elementWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as Element;
      if (isSkippedElement(el)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let elNode: Node | null = elementWalker.nextNode();
  while (elNode) {
    const el = elNode as Element;
    for (const attr of TRANSLATABLE_ATTRS) {
      const val = el.getAttribute(attr);
      if (val && hasNaturalLanguage(val) && !isEntityNameLike(val.trim())) {
        targets.push({
          original: val,
          apply: (v) => el.setAttribute(attr, v),
        });
      }
    }
    // submit/button input value
    if (
      el.tagName === "INPUT" &&
      /^(submit|button|reset)$/i.test(el.getAttribute("type") ?? "")
    ) {
      const val = el.getAttribute("value");
      if (val && hasNaturalLanguage(val)) {
        targets.push({
          original: val,
          apply: (v) => el.setAttribute("value", v),
        });
      }
    }
    elNode = elementWalker.nextNode();
  }

  return targets;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

const CACHE_PREFIX = "opengov_fr_";
const CACHE_VERSION = "v2";

function loadCached(hash: string): string[] | null {
  try {
    const raw = sessionStorage.getItem(`${CACHE_PREFIX}${CACHE_VERSION}_${hash}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveCached(hash: string, out: string[]) {
  try {
    sessionStorage.setItem(
      `${CACHE_PREFIX}${CACHE_VERSION}_${hash}`,
      JSON.stringify(out)
    );
  } catch {
    /* quota exceeded — fine */
  }
}

async function translateStrings(strings: string[]): Promise<string[]> {
  if (strings.length === 0) return [];
  const BATCH = 80;
  const chunks: string[][] = [];
  for (let i = 0; i < strings.length; i += BATCH) {
    chunks.push(strings.slice(i, i + BATCH));
  }
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ strings: chunk, targetLang: "fr" }),
        });
        if (!res.ok) return chunk;
        const data = (await res.json()) as { strings?: unknown };
        const arr = Array.isArray(data.strings) ? data.strings : chunk;
        return arr.map((v, idx) => (typeof v === "string" ? v : chunk[idx]));
      } catch {
        return chunk;
      }
    })
  );
  return results.flat();
}

async function applyTranslation(root: Node): Promise<void> {
  const targets = collectTargets(root);
  if (targets.length === 0) return;

  // Deduplicate — many UI strings repeat (e.g. "Back to home").
  const uniq = new Map<string, number[]>();
  for (let i = 0; i < targets.length; i++) {
    const key = targets[i].original;
    const list = uniq.get(key);
    if (list) list.push(i);
    else uniq.set(key, [i]);
  }
  const uniqueStrings = Array.from(uniq.keys());
  const hash = djb2(uniqueStrings.join("\u0001"));

  let translated = loadCached(hash);
  if (!translated || translated.length !== uniqueStrings.length) {
    translated = await translateStrings(uniqueStrings);
    saveCached(hash, translated);
  }

  const pairs = new Map<string, string>();
  uniqueStrings.forEach((src, i) => pairs.set(src, translated![i] ?? src));
  for (const t of targets) {
    const v = pairs.get(t.original);
    if (v && v !== t.original) t.apply(v);
  }
}

export default function AutoTranslate() {
  const { lang } = useLang();
  const runningRef = useRef(false);
  const lastRunLangRef = useRef<string | null>(null);

  useEffect(() => {
    const html = document.documentElement;
    if (lang !== "fr") {
      html.removeAttribute("data-translating");
      // If we switched back to English mid-session, force a hard reload of the
      // source content so stale French nodes don't linger.
      if (lastRunLangRef.current === "fr") {
        lastRunLangRef.current = "en";
        window.location.reload();
      }
      return;
    }

    let cancelled = false;
    const run = async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      html.setAttribute("data-translating", "true");
      try {
        await applyTranslation(document.body);
      } finally {
        if (!cancelled) html.removeAttribute("data-translating");
        runningRef.current = false;
        lastRunLangRef.current = "fr";
      }
    };

    // First pass.
    void run();

    // Observer for dynamically inserted nodes (streaming answers, modals, etc.)
    let pending: Node[] = [];
    let scheduled: number | null = null;
    const flush = async () => {
      scheduled = null;
      const batch = pending;
      pending = [];
      for (const node of batch) {
        if (!document.body.contains(node)) continue;
        try {
          await applyTranslation(node);
        } catch {
          /* swallow */
        }
      }
    };
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (
            n.nodeType === Node.ELEMENT_NODE ||
            n.nodeType === Node.TEXT_NODE
          ) {
            pending.push(n);
          }
        }
      }
      if (pending.length && scheduled === null) {
        scheduled = window.setTimeout(flush, 400);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
    });

    return () => {
      cancelled = true;
      observer.disconnect();
      if (scheduled !== null) window.clearTimeout(scheduled);
      html.removeAttribute("data-translating");
    };
  }, [lang]);

  return null;
}
