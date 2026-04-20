import Link from "next/link";
import { createHmac, timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";

const SECRET =
  process.env.SHARE_SECRET ||
  process.env.ACCESS_CODE ||
  "opengov-share-fallback-secret";

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

type SharedPayload = {
  turns: { q: string; n: string; c: number; s: string }[];
  lang: "en" | "fr";
  ts: number;
};

function decode(id: string): SharedPayload | null {
  const dot = id.indexOf(".");
  if (dot < 0) return null;
  const data = id.slice(0, dot);
  const sig = id.slice(dot + 1);
  const expected = b64url(createHmac("sha256", SECRET).update(data).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(b64urlDecode(data).toString("utf-8")) as SharedPayload;
  } catch {
    return null;
  }
}

export default async function SharedConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const payload = decode(id);
  const lang = payload?.lang ?? "en";
  const isFr = lang === "fr";

  const backLabel = isFr ? "← Retour au tableau de bord" : "← Back to dashboard";
  const askAgainLabel = isFr ? "Poursuivre la conversation" : "Continue the conversation";
  const heading = isFr ? "Conversation partagée" : "Shared conversation";
  const shareTime = payload
    ? new Date(payload.ts).toLocaleString(isFr ? "fr-CA" : "en-CA")
    : "";

  if (!payload) {
    return (
      <div style={{ maxWidth: 720, margin: "3rem auto", padding: "1rem" }}>
        <h1>{isFr ? "Lien invalide" : "Invalid link"}</h1>
        <p>
          {isFr
            ? "Ce lien partagé est invalide ou a été altéré."
            : "This share link is invalid or has been tampered with."}
        </p>
        <Link href="/ask" style={{ color: "var(--gc-primary)" }}>
          {isFr ? "Poser une nouvelle question →" : "Ask a new question →"}
        </Link>
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: "1.5rem",
      }}
      lang={lang}
    >
      <Link
        href="/"
        style={{
          color: "var(--gc-secondary)",
          textDecoration: "none",
          fontSize: "0.875rem",
        }}
      >
        {backLabel}
      </Link>
      <h1 style={{ fontSize: "1.75rem", marginTop: "0.5rem" }}>{heading}</h1>
      <p
        style={{
          color: "var(--gc-text-secondary)",
          fontSize: "0.8125rem",
          marginBottom: "1.5rem",
        }}
      >
        {shareTime}
      </p>

      {payload.turns.map((tr, i) => (
        <div key={i} style={{ marginBottom: "1.5rem" }}>
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
          >
            {tr.q}
          </div>
          <div
            style={{
              background: "var(--gc-bg-secondary)",
              border: "1px solid var(--gc-border)",
              borderRadius: "2px 8px 8px 8px",
              padding: "1rem",
              maxWidth: "95%",
              fontSize: "0.95rem",
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
            }}
          >
            {tr.n.replace(/\[\^\d+\]/g, "")}
            <div
              style={{
                color: "var(--gc-text-secondary)",
                fontSize: "0.75rem",
                marginTop: "0.75rem",
              }}
            >
              {tr.c} {isFr ? (tr.c === 1 ? "ligne" : "lignes") : tr.c === 1 ? "row" : "rows"}
            </div>
          </div>
        </div>
      ))}

      <div style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid var(--gc-border)" }}>
        <Link
          href="/ask"
          style={{
            display: "inline-block",
            background: "var(--gc-primary)",
            color: "white",
            padding: "0.6rem 1.1rem",
            borderRadius: "8px",
            textDecoration: "none",
            fontWeight: 600,
            fontSize: "0.9375rem",
          }}
        >
          {askAgainLabel} →
        </Link>
      </div>
    </div>
  );
}
