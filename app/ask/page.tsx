"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AutoChart, { hasChart } from "@/components/charts/AutoChart";
import ClientSortableHeader from "@/components/ClientSortableHeader";
import { useClientSort } from "@/lib/use-client-sort";
import LanguageToggle from "@/components/LanguageToggle";
import { useLang } from "@/lib/lang";
import { t, speechLocale, type Lang } from "@/lib/i18n";
import { askStream, type AskEvent, type ChartHintLite } from "@/lib/ask-stream";

/* ==========================================================================
   Formatting helpers (kept from previous page)
   ========================================================================== */

const DOLLAR_HINTS =
  /value|spending|funding|cost|amount|revenue|expenditure|salary|compensation|total_?grant|total_?contract|agreement|budget/i;
const RAW_ID_HINTS = /^id$|_id$|^bn$|^reference|^postal|^phone|^fax|^year$|^fiscal/i;

function fmtValue(v: unknown, colName?: string): string {
  if (v === null || v === undefined) return "—";
  if (colName && RAW_ID_HINTS.test(colName)) return String(v);
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) n = parseFloat(v);
  if (n !== null && Number.isFinite(n)) {
    const isDollar = colName ? DOLLAR_HINTS.test(colName) : false;
    if (isDollar) {
      if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
      if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
      if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
      if (Math.abs(n) >= 1e3)
        return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    }
    if (Number.isInteger(n)) return n.toLocaleString();
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(v);
}

/* ==========================================================================
   Per-turn state shape
   ========================================================================== */

type Phase =
  | "understanding"
  | "planning"
  | "writing"
  | "running"
  | "running_step"
  | "summarizing"
  | "checking"
  | "done"
  | "error";

type PlanStep = {
  purpose: string;
  sql: string;
  status: "pending" | "running" | "done" | "error";
  rowCount?: number;
  error?: string;
};

interface Turn {
  id: number;
  question: string;
  lang: Lang;
  phase: Phase;
  phaseStep?: { step: number; total: number; purpose: string };
  sql: string;
  chart_hint: ChartHintLite | null;
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsed: number;
  narrative: string;
  suggestions: string[];
  self_check: string | null;
  plan: PlanStep[] | null;
  error: string | null;
  recovered: boolean;
}

const newTurn = (id: number, question: string, lang: Lang): Turn => ({
  id,
  question,
  lang,
  phase: "understanding",
  sql: "",
  chart_hint: null,
  rows: [],
  rowCount: 0,
  elapsed: 0,
  narrative: "",
  suggestions: [],
  self_check: null,
  plan: null,
  error: null,
  recovered: false,
});

/* ==========================================================================
   Citation rendering: turn "[^N]" markers into clickable <sup>
   ========================================================================== */

function renderNarrative(
  narrative: string,
  onCite: (n: number) => void,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\[\^(\d+)\]/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = regex.exec(narrative)) !== null) {
    if (m.index > lastIndex) {
      parts.push(narrative.slice(lastIndex, m.index));
    }
    const n = parseInt(m[1], 10);
    parts.push(
      <button
        key={`cite-${key++}`}
        type="button"
        onClick={() => onCite(n)}
        aria-label={`Source: row ${n}`}
        style={{
          background: "rgba(11, 61, 104, 0.1)",
          color: "var(--gc-primary)",
          border: "1px solid rgba(11, 61, 104, 0.25)",
          borderRadius: "3px",
          cursor: "pointer",
          padding: "0 4px",
          margin: "0 1px",
          fontSize: "0.7em",
          fontWeight: 700,
          verticalAlign: "super",
          lineHeight: 1,
        }}
      >
        {n}
      </button>,
    );
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < narrative.length) parts.push(narrative.slice(lastIndex));
  return parts;
}

function stripCitations(s: string): string {
  return s.replace(/\[\^\d+\]/g, "").replace(/\s+/g, " ").trim();
}

/* ==========================================================================
   Result table
   ========================================================================== */

function QueryResultTable({
  rows,
  highlightRow,
  rowRefs,
}: {
  rows: Record<string, unknown>[];
  highlightRow: number | null;
  rowRefs: React.MutableRefObject<Record<number, HTMLTableRowElement | null>>;
}) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const getters = columns.reduce<
    Record<string, (r: Record<string, unknown>) => string | number>
  >((acc, c) => {
    acc[c] = (r) => {
      const v = r[c];
      if (v == null) return "";
      if (typeof v === "number") return v;
      const n = Number(v);
      if (!Number.isNaN(n) && String(v).trim() !== "" && /^-?\d/.test(String(v)))
        return n;
      return String(v).toLowerCase();
    };
    return acc;
  }, {});
  const initialKey = columns[0] ?? "_";
  const sort = useClientSort(rows, getters, { key: initialKey, direction: "desc" });
  if (rows.length === 0) return null;

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}
      >
        <thead>
          <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
            {columns.map((col) => (
              <ClientSortableHeader
                key={col}
                columnKey={col}
                label={col.replace(/_/g, " ")}
                activeKey={sort.key}
                direction={sort.direction}
                onSort={sort.toggle}
                align="left"
                defaultDir="desc"
                style={{
                  textAlign: "left",
                  padding: "0.4rem 0.5rem",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {sort.rows.map((row, ri) => {
            const keys = Object.keys(row);
            const idx = rows.indexOf(row); // original (unsorted) 0-based index
            const n = idx + 1;
            const isHi = highlightRow === n;
            return (
              <tr
                key={ri}
                ref={(el) => {
                  rowRefs.current[n] = el;
                }}
                style={{
                  borderBottom: "1px solid var(--gc-border)",
                  background: isHi
                    ? "rgba(255, 215, 0, 0.35)"
                    : ri % 2 === 1
                    ? "var(--gc-bg)"
                    : "transparent",
                  transition: "background 0.3s",
                }}
              >
                {Object.values(row).map((val, ci) => (
                  <td
                    key={ci}
                    style={{
                      padding: "0.35rem 0.5rem",
                      whiteSpace: "nowrap",
                      maxWidth: "300px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {fmtValue(val, keys[ci])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ==========================================================================
   Phase loader
   ========================================================================== */

function PhaseLoader({ turn }: { turn: Turn }) {
  const { lang } = useLang();
  const key =
    turn.phase === "planning"
      ? "ask.loading.planning"
      : turn.phase === "writing"
      ? "ask.loading.writing"
      : turn.phase === "running" || turn.phase === "running_step"
      ? "ask.loading.running"
      : turn.phase === "summarizing"
      ? "ask.loading.summarizing"
      : turn.phase === "checking"
      ? "ask.loading.checking"
      : "ask.loading.understanding";
  const base = t(key, lang);
  const step = turn.phaseStep
    ? ` (${turn.phaseStep.step}/${turn.phaseStep.total}) — ${turn.phaseStep.purpose}`
    : "";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        fontSize: "0.8125rem",
        color: "var(--gc-text-secondary)",
        fontStyle: "italic",
        padding: "0.25rem 0",
      }}
    >
      <span className="pulse-dot" aria-hidden="true" /> {base}
      {step}
    </div>
  );
}

/* ==========================================================================
   Read-aloud button
   ========================================================================== */

function pickBestBrowserVoice(locale: string): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const lcLocale = locale.toLowerCase();
  const lcBase = lcLocale.split("-")[0];
  const matches = voices.filter((v) => {
    const l = v.lang.toLowerCase();
    return l === lcLocale || l.startsWith(lcBase + "-");
  });
  if (matches.length === 0) return null;
  const score = (v: SpeechSynthesisVoice): number => {
    const n = v.name.toLowerCase();
    let s = 0;
    if (/neural|natural|premium|enhanced/.test(n)) s += 100;
    if (/online|google|microsoft/.test(n)) s += 20;
    if (v.lang.toLowerCase() === lcLocale) s += 10;
    if (/samantha|ava|serena|allison|jenny|aria|sylvie|clara|antoine|liam/.test(n)) s += 15;
    if (/novelty|whisper|cellos|organ|trinoids|zarvox|albert|bad news/.test(n)) s -= 200;
    return s;
  };
  return matches.slice().sort((a, b) => score(b) - score(a))[0] ?? matches[0];
}

function ReadAloudButton({ text, lang }: { text: string; lang: Lang }) {
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  // Prime voice list on mount (some browsers populate asynchronously).
  useEffect(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {
        /* voices now available */
      };
    }
  }, []);

  const browserAvailable =
    typeof window !== "undefined" && "speechSynthesis" in window;

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  }, []);

  const speakViaBrowser = useCallback(
    (plain: string) => {
      if (!browserAvailable) return;
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(plain);
      u.lang = speechLocale(lang);
      u.rate = 1.0;
      u.pitch = 1.0;
      const best = pickBestBrowserVoice(u.lang);
      if (best) u.voice = best;
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      utterRef.current = u;
      setSpeaking(true);
      synth.speak(u);
    },
    [browserAvailable, lang]
  );

  const toggle = useCallback(async () => {
    if (speaking) {
      stop();
      return;
    }
    const plain = stripCitations(text);
    if (!plain) return;
    setSpeaking(true);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: plain, lang }),
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        setSpeaking(false);
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => {
        setSpeaking(false);
        URL.revokeObjectURL(url);
      };
      audioRef.current = audio;
      await audio.play();
    } catch {
      // Server TTS unavailable — gracefully fall back to browser voice.
      speakViaBrowser(plain);
    }
  }, [lang, speakViaBrowser, speaking, stop, text]);

  if (!browserAvailable && typeof window !== "undefined") {
    // No browser TTS at all — still show the button; server TTS can work.
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={speaking}
      aria-label={speaking ? t("ask.speak.stop", lang) : t("ask.speak", lang)}
      style={{
        background: speaking ? "var(--gc-primary)" : "var(--gc-bg)",
        color: speaking ? "white" : "var(--gc-text)",
        border: "1px solid var(--gc-border)",
        borderRadius: "6px",
        padding: "0.25rem 0.6rem",
        fontSize: "0.75rem",
        cursor: "pointer",
        minHeight: "32px",
      }}
    >
      {speaking ? "⏹" : "🔊"} {speaking ? t("ask.speak.stop", lang) : t("ask.speak", lang)}
    </button>
  );
}

/* ==========================================================================
   Mic (voice input)
   ========================================================================== */

type SpeechRecognitionConstructor = new () => SpeechRecognitionLite;
interface SpeechRecognitionLite {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function MicButton({
  lang,
  onTranscript,
  disabled,
}: {
  lang: Lang;
  onTranscript: (text: string, final: boolean) => void;
  disabled: boolean;
}) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLite | null>(null);

  const SR = getSpeechRecognition();
  if (!SR) return null;

  const start = () => {
    const rec = new SR();
    rec.lang = speechLocale(lang);
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      onTranscript(last[0].transcript, last.isFinal);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  const stop = () => {
    recRef.current?.stop();
    setListening(false);
  };

  return (
    <button
      type="button"
      onClick={listening ? stop : start}
      aria-pressed={listening}
      aria-label={listening ? t("ask.mic.stop", lang) : t("ask.mic.start", lang)}
      disabled={disabled}
      style={{
        background: listening ? "#d62728" : "var(--gc-bg)",
        color: listening ? "white" : "var(--gc-text)",
        border: "1px solid var(--gc-border)",
        borderRadius: "6px",
        padding: "0 0.75rem",
        minHeight: "44px",
        minWidth: "44px",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: "1rem",
      }}
    >
      {listening ? "●" : "🎤"}
    </button>
  );
}

/* ==========================================================================
   Turn card
   ========================================================================== */

function TurnCard({
  turn,
  onChipClick,
  isLast,
}: {
  turn: Turn;
  onChipClick: (q: string) => void;
  isLast: boolean;
}) {
  const { lang } = useLang();
  const [showSQL, setShowSQL] = useState(false);
  const [showPlan, setShowPlan] = useState(turn.plan !== null && turn.plan.length > 0);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [highlightRow, setHighlightRow] = useState<number | null>(null);
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});

  const onCite = useCallback((n: number) => {
    setView("table");
    setHighlightRow(n);
    setTimeout(() => {
      rowRefs.current[n]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
    setTimeout(() => setHighlightRow(null), 2500);
  }, []);

  const streaming = turn.phase !== "done" && turn.phase !== "error";
  const canChart = hasChart(turn.rows, turn.chart_hint ?? null);

  useEffect(() => {
    if (turn.rows.length > 0 && view === "chart" && !canChart) {
      setView("table");
    }
  }, [turn.rows.length, canChart, view]);

  return (
    <div style={{ marginBottom: "1.75rem" }}>
      {/* Question bubble */}
      <div
        style={{
          background: "var(--gc-primary)",
          color: "white",
          padding: "0.75rem 1rem",
          borderRadius: "8px 8px 2px 8px",
          marginBottom: "0.5rem",
          maxWidth: "85%",
          marginLeft: "auto",
          fontSize: "0.9375rem",
        }}
        lang={turn.lang}
      >
        {turn.question}
      </div>

      {/* Answer */}
      <div
        style={{
          background: "var(--gc-bg-secondary)",
          border: "1px solid var(--gc-border)",
          borderRadius: "2px 8px 8px 8px",
          padding: "1rem",
          maxWidth: "95%",
        }}
      >
        {turn.error ? (
          <div style={{ color: "var(--risk-critical)", fontSize: "0.875rem" }}>
            ⚠️ {turn.error}
          </div>
        ) : (
          <>
            {/* Plan (agent mode) */}
            {turn.plan && turn.plan.length > 0 && (
              <div style={{ marginBottom: "0.75rem" }}>
                <button
                  type="button"
                  onClick={() => setShowPlan((s) => !s)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--gc-secondary)",
                    cursor: "pointer",
                    fontSize: "0.75rem",
                    textDecoration: "underline",
                    padding: 0,
                  }}
                >
                  {showPlan ? t("ask.hide_plan", lang) : t("ask.show_plan", lang)}
                </button>
                {showPlan && (
                  <ol style={{ margin: "0.5rem 0 0 1rem", fontSize: "0.8125rem" }}>
                    {turn.plan.map((s, i) => (
                      <li
                        key={i}
                        style={{
                          color:
                            s.status === "done"
                              ? "var(--gc-text)"
                              : s.status === "running"
                              ? "var(--gc-primary)"
                              : s.status === "error"
                              ? "var(--risk-critical)"
                              : "var(--gc-text-secondary)",
                          fontWeight: s.status === "running" ? 600 : 400,
                        }}
                      >
                        {s.status === "done"
                          ? "✓ "
                          : s.status === "running"
                          ? "⏵ "
                          : s.status === "error"
                          ? "✗ "
                          : "○ "}
                        {s.purpose}
                        {s.rowCount !== undefined && ` (${s.rowCount} ${s.rowCount === 1 ? t("ask.row", lang) : t("ask.rows", lang)})`}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}

            {/* Streaming narrative */}
            {(turn.narrative || streaming) && (
              <div
                role="log"
                aria-live="polite"
                aria-atomic="false"
                lang={turn.lang}
                translate="no"
                data-notranslate
                style={{
                  fontSize: "0.95rem",
                  lineHeight: 1.55,
                  marginBottom: turn.rows.length > 0 ? "0.9rem" : 0,
                  color: "var(--gc-text)",
                }}
              >
                {renderNarrative(turn.narrative, onCite)}
                {streaming && turn.narrative && (
                  <span className="caret-blink" aria-hidden="true">▍</span>
                )}
              </div>
            )}

            {streaming && !turn.narrative && <PhaseLoader turn={turn} />}

            {/* Read aloud */}
            {!streaming && turn.narrative && (
              <div style={{ marginBottom: "0.75rem" }}>
                <ReadAloudButton text={turn.narrative} lang={turn.lang} />
              </div>
            )}

            {/* Self-check */}
            {turn.self_check && (
              <div
                style={{
                  marginTop: "0.5rem",
                  marginBottom: "0.75rem",
                  padding: "0.5rem 0.75rem",
                  background: "rgba(255, 200, 0, 0.1)",
                  border: "1px solid rgba(255, 200, 0, 0.35)",
                  borderRadius: "6px",
                  fontSize: "0.8125rem",
                  color: "var(--gc-text)",
                }}
                lang={turn.lang}
              >
                <strong>{t("ask.selfcheck", lang)}</strong> {turn.self_check}
              </div>
            )}

            {/* Meta */}
            {turn.rows.length > 0 && (
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--gc-text-secondary)",
                  marginBottom: "0.5rem",
                }}
              >
                {turn.rowCount}{" "}
                {turn.rowCount === 1 ? t("ask.row", lang) : t("ask.rows", lang)}
                {turn.elapsed ? ` · ${turn.elapsed}ms` : ""}
                {turn.recovered && " · recovered"}
                {turn.sql && (
                  <button
                    onClick={() => setShowSQL((s) => !s)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--gc-secondary)",
                      cursor: "pointer",
                      marginLeft: "0.75rem",
                      fontSize: "0.75rem",
                      textDecoration: "underline",
                    }}
                  >
                    {showSQL ? t("ask.hide_sql", lang) : t("ask.show_sql", lang)}
                  </button>
                )}
              </div>
            )}

            {showSQL && turn.sql && (
              <pre
                style={{
                  background: "var(--gc-primary)",
                  color: "#e0e0e0",
                  padding: "0.75rem",
                  borderRadius: "4px",
                  fontSize: "0.75rem",
                  overflow: "auto",
                  marginBottom: "0.75rem",
                  whiteSpace: "pre-wrap",
                }}
              >
                {turn.sql}
              </pre>
            )}

            {/* Chart / table toggle + content */}
            {turn.rows.length > 0 && (
              <>
                {canChart && (
                  <div
                    role="group"
                    aria-label="Result display mode"
                    style={{
                      display: "inline-flex",
                      gap: 0,
                      border: "1px solid var(--gc-border)",
                      borderRadius: "6px",
                      overflow: "hidden",
                      marginBottom: "0.75rem",
                    }}
                  >
                    <button
                      type="button"
                      aria-pressed={view === "chart"}
                      onClick={() => setView("chart")}
                      style={{
                        minHeight: "44px",
                        padding: "0.5rem 0.9rem",
                        background:
                          view === "chart" ? "var(--gc-primary)" : "var(--gc-bg)",
                        color: view === "chart" ? "white" : "var(--gc-text)",
                        border: "none",
                        borderRight: "1px solid var(--gc-border)",
                        fontSize: "0.8125rem",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      📊 {t("ask.chart", lang)}
                    </button>
                    <button
                      type="button"
                      aria-pressed={view === "table"}
                      onClick={() => setView("table")}
                      style={{
                        minHeight: "44px",
                        padding: "0.5rem 0.9rem",
                        background:
                          view === "table" ? "var(--gc-primary)" : "var(--gc-bg)",
                        color: view === "table" ? "white" : "var(--gc-text)",
                        border: "none",
                        fontSize: "0.8125rem",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      🗂️ {t("ask.table", lang)}
                    </button>
                  </div>
                )}
                {view === "chart" && canChart ? (
                  <AutoChart rows={turn.rows} hint={turn.chart_hint ?? null} />
                ) : (
                  <QueryResultTable
                    rows={turn.rows}
                    highlightRow={highlightRow}
                    rowRefs={rowRefs}
                  />
                )}
              </>
            )}

            {/* Follow-up chips */}
            {!streaming && turn.suggestions.length > 0 && isLast && (
              <div style={{ marginTop: "1rem" }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--gc-text-secondary)",
                    fontWeight: 600,
                    marginBottom: "0.4rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  {t("ask.followups", lang)}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                  {turn.suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => onChipClick(s)}
                      lang={turn.lang}
                      style={{
                        background: "var(--gc-bg)",
                        border: "1px solid var(--gc-border)",
                        borderRadius: "999px",
                        padding: "0.4rem 0.85rem",
                        fontSize: "0.8125rem",
                        cursor: "pointer",
                        color: "var(--gc-primary)",
                        fontWeight: 500,
                      }}
                    >
                      → {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ==========================================================================
   Main page
   ========================================================================== */

const EXAMPLES: Record<string, { en: string[]; fr: string[] }> = {
  "ask.examples.investigate": {
    en: [
      "Show the largest contracts awarded to IBM",
      "Which 10 departments spent the most on sole-source contracts?",
      "Find charities where directors serve on 3+ boards",
    ],
    fr: [
      "Montre les plus gros contrats attribués à IBM",
      "Quels sont les 10 ministères qui dépensent le plus en contrats à fournisseur unique ?",
      "Trouve les organismes dont les directeurs siègent à 3 conseils ou plus",
    ],
  },
  "ask.examples.find_waste": {
    en: [
      "Which vendors had amendment ratios above 300% last year?",
      "Which charities received over $1M in grants then deregistered?",
      "Contracts split just below the $25K sole-source threshold",
    ],
    fr: [
      "Quels fournisseurs ont eu des ratios d'avenants supérieurs à 300 % l'an dernier ?",
      "Quels organismes ont reçu plus d'1 M$ puis ont été radiés ?",
      "Contrats divisés juste sous le seuil de 25 000 $ pour fournisseur unique",
    ],
  },
  "ask.examples.track_outcomes": {
    en: [
      "Grant spending on housing since 2020 by province",
      "How has defence procurement grown year over year?",
      "Top 5 grant recipients by total funding",
    ],
    fr: [
      "Dépenses en subventions au logement depuis 2020 par province",
      "Comment l'approvisionnement en défense a-t-il augmenté d'une année à l'autre ?",
      "Top 5 des bénéficiaires de subventions par financement total",
    ],
  },
};

/* ==========================================================================
   Conversation-level actions: share link + briefing memo
   ========================================================================== */

function ConversationActions({
  turns,
  lang,
}: {
  turns: Turn[];
  lang: Lang;
}) {
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);

  const onShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lang,
          turns: turns
            .filter((tr) => tr.phase === "done" && !tr.error)
            .map((tr) => ({
              question: tr.question,
              narrative: tr.narrative,
              sql: tr.sql,
              rowCount: tr.rowCount,
            })),
        }),
      });
      const d = await res.json();
      if (d.id) {
        const url = `${window.location.origin}/share/${d.id}`;
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    } catch {
      /* ignore */
    } finally {
      setSharing(false);
    }
  };

  const onMemo = async () => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/memo";
    form.target = "_blank";
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "payload";
    form.appendChild(input);
    // POST with JSON via fetch + open the response HTML
    try {
      const res = await fetch("/api/memo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lang,
          turns: turns
            .filter((tr) => tr.phase === "done" && !tr.error)
            .map((tr) => ({
              question: tr.question,
              narrative: tr.narrative,
              sql: tr.sql,
              rowCount: tr.rowCount,
              rows: tr.rows,
              self_check: tr.self_check,
            })),
        }),
      });
      const html = await res.text();
      const w = window.open("", "_blank");
      if (w) {
        w.document.open();
        w.document.write(html);
        w.document.close();
      }
    } catch {
      /* ignore */
    }
  };

  const btnStyle: React.CSSProperties = {
    background: "var(--gc-bg)",
    color: "var(--gc-primary)",
    border: "1px solid var(--gc-border)",
    borderRadius: "8px",
    padding: "0.5rem 0.9rem",
    fontSize: "0.8125rem",
    fontWeight: 600,
    cursor: "pointer",
    minHeight: "40px",
  };

  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        flexWrap: "wrap",
        padding: "0.75rem 0 0.5rem",
        marginTop: "0.5rem",
        borderTop: "1px dashed var(--gc-border)",
      }}
    >
      <button type="button" onClick={onShare} disabled={sharing} style={btnStyle}>
        🔗 {copied ? t("ask.share.copied", lang) : t("ask.share.copy", lang)}
      </button>
      <button type="button" onClick={onMemo} style={btnStyle}>
        📄 {t("ask.memo.button", lang)}
      </button>
    </div>
  );
}


function AskInner() {
  const { lang } = useLang();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [agent, setAgent] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState("");
  const [briefing, setBriefing] = useState<
    { id: string; emoji: string; headline: string; detail: string; cta: string; seed_question: string }[] | null
  >(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  // Fetch daily briefing for empty state
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/briefing?lang=${lang}`)
      .then((r) => (r.ok ? r.json() : { findings: [] }))
      .then((d) => {
        if (!cancelled && Array.isArray(d.findings)) setBriefing(d.findings);
      })
      .catch(() => {
        if (!cancelled) setBriefing([]);
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const submit = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question || sending) return;
      setSending(true);
      setInput("");
      setVoiceInterim("");

      const id = nextId.current++;
      const history = turns
        .filter((tr) => !tr.error && tr.sql)
        .map((tr) => ({ question: tr.question, sql: tr.sql }));
      const t0 = newTurn(id, question, lang);
      setTurns((prev) => [...prev, t0]);

      const updateTurn = (patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) => {
        setTurns((prev) =>
          prev.map((tr) => {
            if (tr.id !== id) return tr;
            const p = typeof patch === "function" ? patch(tr) : patch;
            return { ...tr, ...p };
          }),
        );
      };

      try {
        await askStream(
          { question, lang, history, agent },
          (evt: AskEvent) => {
            switch (evt.type) {
              case "status":
                updateTurn({
                  phase: evt.phase as Phase,
                  phaseStep:
                    evt.step && evt.total && evt.purpose
                      ? { step: evt.step, total: evt.total, purpose: evt.purpose }
                      : undefined,
                });
                if (evt.phase === "running_step" && evt.step) {
                  updateTurn((tr) => ({
                    plan: tr.plan
                      ? tr.plan.map((s, i) => ({
                          ...s,
                          status:
                            i + 1 < evt.step!
                              ? s.status === "error"
                                ? "error"
                                : "done"
                              : i + 1 === evt.step!
                              ? "running"
                              : "pending",
                        }))
                      : tr.plan,
                  }));
                }
                break;
              case "plan":
                updateTurn({
                  plan: evt.steps.map((s) => ({
                    ...s,
                    status: "pending" as const,
                  })),
                });
                break;
              case "sql":
                updateTurn({
                  sql: evt.sql,
                  chart_hint: evt.chart_hint,
                  recovered: !!evt.recovered,
                });
                break;
              case "rows":
                updateTurn({
                  rows: evt.rows,
                  rowCount: evt.rowCount,
                  elapsed: evt.elapsed,
                });
                break;
              case "step_result":
                updateTurn((tr) => ({
                  plan: tr.plan
                    ? tr.plan.map((s, i) =>
                        i + 1 === evt.step
                          ? { ...s, status: "done", rowCount: evt.rowCount, sql: evt.sql }
                          : s,
                      )
                    : tr.plan,
                }));
                break;
              case "step_error":
                updateTurn((tr) => ({
                  plan: tr.plan
                    ? tr.plan.map((s, i) =>
                        i + 1 === evt.step
                          ? { ...s, status: "error", error: evt.error }
                          : s,
                      )
                    : tr.plan,
                }));
                break;
              case "narrative_token":
                updateTurn((tr) => ({ narrative: tr.narrative + evt.t }));
                break;
              case "suggestions":
                updateTurn({ suggestions: evt.suggestions });
                break;
              case "self_check":
                updateTurn({ self_check: evt.note });
                break;
              case "done":
                updateTurn({ phase: "done" });
                break;
              case "error":
                updateTurn({
                  phase: "error",
                  error: evt.error || t("ask.error.generic", lang),
                  sql: evt.sql ?? "",
                });
                break;
            }
          },
        );
      } catch (err) {
        updateTurn({
          phase: "error",
          error: (err as Error).message || t("ask.error.generic", lang),
        });
      } finally {
        setSending(false);
        textareaRef.current?.focus();
      }
    },
    [agent, lang, sending, turns],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(input);
      return;
    }
    if (e.key === "ArrowUp" && input === "" && turns.length > 0) {
      const last = [...turns].reverse().find((tr) => tr.question);
      if (last) {
        e.preventDefault();
        setInput(last.question);
      }
    }
  };

  const onTranscript = (text: string, final: boolean) => {
    if (final) {
      setInput(text);
      setVoiceInterim("");
    } else {
      setVoiceInterim(text);
    }
  };

  const examplesKeys = useMemo(
    () =>
      [
        "ask.examples.investigate",
        "ask.examples.find_waste",
        "ask.examples.track_outcomes",
      ] as const,
    [],
  );

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: "1.5rem",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        .pulse-dot {
          display: inline-block;
          width: 7px; height: 7px; border-radius: 50%;
          background: var(--gc-primary);
          margin-right: 6px;
          animation: pulse 1.2s ease-in-out infinite;
          vertical-align: middle;
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.25; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.2); }
        }
        @media (prefers-reduced-motion: reduce) {
          .pulse-dot { animation: none; opacity: 0.75; }
          .caret-blink { animation: none; }
        }
        .caret-blink {
          display: inline-block;
          animation: caret 1.0s steps(2) infinite;
          color: var(--gc-primary);
          margin-left: 2px;
        }
        @keyframes caret { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
        }}
      >
        <a
          href="/"
          style={{
            color: "var(--gc-secondary)",
            textDecoration: "none",
            fontSize: "0.875rem",
          }}
        >
          {t("ask.back", lang)}
        </a>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => setTurns([])}
              style={{
                background: "none",
                border: "1px solid var(--gc-border)",
                borderRadius: "6px",
                padding: "0.3rem 0.7rem",
                fontSize: "0.75rem",
                cursor: "pointer",
                color: "var(--gc-text)",
                minHeight: "40px",
              }}
            >
              ↻ {t("ask.clear", lang)}
            </button>
          )}
          <label
            style={{
              display: "inline-flex",
              gap: "0.3rem",
              alignItems: "center",
              fontSize: "0.75rem",
              color: "var(--gc-text-secondary)",
              cursor: "pointer",
              userSelect: "none",
            }}
            title={
              lang === "fr"
                ? "Exécute une enquête en plusieurs étapes : planifie, interroge chaque sous-question, puis synthétise la réponse avec des citations. Plus lent, mais plus rigoureux pour les questions ouvertes."
                : "Runs a multi-step investigation: plans sub-questions, queries each, then synthesizes the answer with citations. Slower, but more rigorous for open-ended questions."
            }
            aria-describedby="investigate-mode-desc"
          >
            <input
              type="checkbox"
              checked={agent}
              onChange={(e) => setAgent(e.target.checked)}
              aria-describedby="investigate-mode-desc"
            />{" "}
            {lang === "fr" ? "Mode enquête" : "Investigate mode"}
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "16px",
                height: "16px",
                borderRadius: "50%",
                border: "1px solid var(--gc-border)",
                fontSize: "0.6875rem",
                fontWeight: 700,
                color: "var(--gc-text-secondary)",
                marginLeft: "0.15rem",
              }}
            >
              ?
            </span>
          </label>
          <LanguageToggle />
        </div>
      </div>
      <p
        id="investigate-mode-desc"
        style={{
          margin: "0 0 0.75rem",
          fontSize: "0.75rem",
          color: "var(--gc-text-secondary)",
          textAlign: "right",
          lineHeight: 1.45,
        }}
      >
        {lang === "fr" ? (
          <>
            <strong>Mode enquête</strong> : planifie les sous-questions, exécute plusieurs requêtes, puis synthétise la réponse avec des citations — plus lent mais plus rigoureux pour les questions ouvertes.
          </>
        ) : (
          <>
            <strong>Investigate mode</strong>: plans sub-questions, runs multiple queries, then synthesizes an answer with citations — slower but more rigorous for open-ended questions.
          </>
        )}
      </p>

      <h1 style={{ fontSize: "2rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
        {t("ask.title", lang)}
      </h1>
      <p
        style={{
          color: "var(--gc-text-secondary)",
          marginBottom: "1.5rem",
          fontSize: "0.9375rem",
        }}
      >
        {t("ask.subtitle", lang)}
      </p>

      {turns.length === 0 && (
        <div style={{ marginBottom: "2rem" }}>
          {briefing === null ? (
            <div
              role="status"
              aria-live="polite"
              style={{
                fontSize: "0.8125rem",
                color: "var(--gc-text-secondary)",
                fontStyle: "italic",
                padding: "1rem 0",
              }}
            >
              <span className="pulse-dot" aria-hidden="true" /> {t("briefing.loading", lang)}
            </div>
          ) : briefing.length > 0 ? (
            <div
              style={{
                border: "1px solid var(--gc-border)",
                borderRadius: "10px",
                padding: "1.25rem",
                background:
                  "linear-gradient(180deg, var(--gc-bg-secondary), var(--gc-bg))",
                marginBottom: "1.5rem",
              }}
            >
              <div
                style={{
                  fontSize: "1.1rem",
                  fontWeight: 700,
                  color: "var(--gc-primary)",
                  marginBottom: "0.25rem",
                }}
                lang={lang}
              >
                {t("briefing.title", lang)}
              </div>
              <div
                style={{
                  fontSize: "0.8125rem",
                  color: "var(--gc-text-secondary)",
                  marginBottom: "1rem",
                }}
                lang={lang}
              >
                {t("briefing.subtitle", lang)}
              </div>
              <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {briefing.map((b, i) => (
                  <li
                    key={b.id}
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      padding: "0.75rem 0",
                      borderTop:
                        i === 0 ? "none" : "1px dashed var(--gc-border)",
                      alignItems: "flex-start",
                    }}
                  >
                    <div
                      aria-hidden="true"
                      style={{
                        fontSize: "1.5rem",
                        minWidth: "2rem",
                        lineHeight: 1,
                        paddingTop: "0.2rem",
                      }}
                    >
                      {b.emoji}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: "0.9375rem",
                          fontWeight: 600,
                          color: "var(--gc-text)",
                          marginBottom: "0.25rem",
                          lineHeight: 1.4,
                        }}
                        lang={lang}
                      >
                        <span
                          style={{
                            display: "inline-block",
                            width: "1.1rem",
                            fontWeight: 700,
                            color: "var(--gc-primary)",
                          }}
                        >
                          {i + 1}.
                        </span>{" "}
                        {b.headline}
                      </div>
                      <div
                        style={{
                          fontSize: "0.8125rem",
                          color: "var(--gc-text-secondary)",
                          marginBottom: "0.35rem",
                          paddingLeft: "1.1rem",
                        }}
                        lang={lang}
                      >
                        {b.detail}
                      </div>
                      <div style={{ paddingLeft: "1.1rem" }}>
                        <button
                          type="button"
                          onClick={() => submit(b.seed_question)}
                          lang={lang}
                          style={{
                            background: "var(--gc-primary)",
                            color: "white",
                            border: "none",
                            borderRadius: "999px",
                            padding: "0.35rem 0.9rem",
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            cursor: "pointer",
                            minHeight: "32px",
                          }}
                        >
                          {b.cta}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          <div
            style={{
              fontSize: "0.8125rem",
              color: "var(--gc-text-secondary)",
              marginBottom: "0.75rem",
              fontWeight: 600,
            }}
          >
            {t("ask.examples", lang)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
            {examplesKeys.map((k) => (
              <div key={k}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--gc-primary)",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: "0.4rem",
                  }}
                >
                  {t(k, lang)}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  {EXAMPLES[k][lang].map((ex) => (
                    <button
                      key={ex}
                      onClick={() => submit(ex)}
                      lang={lang}
                      style={{
                        background: "var(--gc-bg-secondary)",
                        border: "1px solid var(--gc-border)",
                        borderRadius: "6px",
                        padding: "0.55rem 0.8rem",
                        fontSize: "0.8125rem",
                        cursor: "pointer",
                        color: "var(--gc-text)",
                        textAlign: "left",
                        maxWidth: "100%",
                      }}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", marginBottom: "1rem" }}>
        {turns.map((tr, i) => (
          <TurnCard
            key={tr.id}
            turn={tr}
            isLast={i === turns.length - 1}
            onChipClick={submit}
          />
        ))}
        {turns.some((tr) => tr.phase === "done" && !tr.error) && (
          <ConversationActions turns={turns} lang={lang} />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Voice interim preview */}
      {voiceInterim && (
        <div
          aria-live="polite"
          style={{
            fontSize: "0.8125rem",
            color: "var(--gc-text-secondary)",
            fontStyle: "italic",
            marginBottom: "0.25rem",
          }}
        >
          🎤 {voiceInterim}
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        style={{
          display: "flex",
          gap: "0.5rem",
          padding: "0.6rem",
          background: "var(--gc-bg-secondary)",
          borderRadius: "10px",
          border: "1px solid var(--gc-border)",
          position: "sticky",
          bottom: "1rem",
          alignItems: "flex-end",
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            turns.length === 0
              ? t("ask.placeholder.first", lang)
              : t("ask.placeholder.follow", lang)
          }
          lang={lang}
          rows={1}
          disabled={sending}
          style={{
            flex: 1,
            padding: "0.6rem 0.75rem",
            border: "1px solid var(--gc-border)",
            borderRadius: "8px",
            fontSize: "0.9375rem",
            outline: "none",
            background: "var(--gc-bg)",
            color: "var(--gc-text)",
            resize: "none",
            fontFamily: "inherit",
            lineHeight: 1.4,
            minHeight: "44px",
            maxHeight: "200px",
            overflowY: "auto",
          }}
        />
        <MicButton lang={lang} onTranscript={onTranscript} disabled={sending} />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          style={{
            padding: "0 1.25rem",
            background:
              sending || !input.trim() ? "var(--gc-text-secondary)" : "var(--gc-accent)",
            color: "white",
            border: "none",
            borderRadius: "8px",
            fontWeight: 700,
            cursor: sending || !input.trim() ? "not-allowed" : "pointer",
            fontSize: "0.9375rem",
            minHeight: "44px",
          }}
        >
          {sending ? t("ask.loading.short", lang) : t("ask.submit", lang)}
        </button>
      </form>
    </div>
  );
}

export default function AskPage() {
  return <AskInner />;
}
