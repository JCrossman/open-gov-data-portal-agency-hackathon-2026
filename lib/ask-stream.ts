// Client-side SSE consumer for /api/ask. Dispatches typed events to callbacks.

import type { Lang } from "./i18n";

export type AskEvent =
  | { type: "status"; phase: string; step?: number; total?: number; purpose?: string }
  | { type: "plan"; steps: { purpose: string; sql: string }[] }
  | { type: "sql"; sql: string; chart_hint: ChartHintLite | null; recovered?: boolean }
  | { type: "rows"; rows: Record<string, unknown>[]; rowCount: number; elapsed: number }
  | { type: "narrative_token"; t: string }
  | { type: "step_result"; step: number; purpose: string; sql: string; rowCount: number; preview: Record<string, unknown>[] }
  | { type: "step_error"; step: number; error: string }
  | { type: "suggestions"; suggestions: string[] }
  | { type: "self_check"; note: string }
  | { type: "done" }
  | { type: "error"; error: string; sql?: string };

export type ChartHintLite = {
  type: "bar" | "line" | "kpi" | "stacked_bar" | "grouped_bar" | "multi_line";
  x?: string;
  y?: string;
  series?: string;
  title?: string;
};

export interface AskRequest {
  question: string;
  lang: Lang;
  history?: { question: string; sql: string }[];
  agent?: boolean;
  signal?: AbortSignal;
}

export async function askStream(
  req: AskRequest,
  onEvent: (evt: AskEvent) => void,
): Promise<void> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: req.question,
      lang: req.lang,
      history: req.history ?? [],
      agent: req.agent ?? false,
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* ignore */
    }
    onEvent({ type: "error", error: msg });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = frame.split("\n");
      let eventName = "message";
      let dataLine = "";
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      try {
        const payload = JSON.parse(dataLine) as Record<string, unknown>;
        onEvent({ type: eventName as AskEvent["type"], ...payload } as AskEvent);
        if (eventName === "done" || eventName === "error") return;
      } catch {
        // ignore malformed frame
      }
    }
  }
}
