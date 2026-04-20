import { NextRequest, NextResponse } from "next/server";
import { DefaultAzureCredential } from "@azure/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-41";
const AZURE_OPENAI_API_VERSION = "2024-08-01-preview";

function getAzureOpenAIEndpoint(): string {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) throw new Error("AZURE_OPENAI_ENDPOINT env var is required");
  return endpoint;
}

async function getAzureOpenAIToken(): Promise<string> {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  return token.token;
}

// In-process cache: full batch → translated list. Keyed by (targetLang|hash(batch)).
// Survives across requests in the same container instance. Capped at 2000 entries.
const cache = new Map<string, string[]>();
const MAX_CACHE = 2000;

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

const SYSTEM_PROMPT = `You are a professional Canadian French translator for a government accountability web application. You translate UI text from English into Canadian French (français canadien) using Government of Canada Translation Bureau conventions.

Rules:
1. Preserve all numbers, monetary amounts, dates, percentages, email addresses, URLs, and business numbers (BN) exactly as written.
2. Preserve proper nouns: company names, vendor names, government department acronyms (CRA, CSE, ESDC), program names. Do NOT translate entity names unless they have an established bilingual form (e.g. "Canada Revenue Agency" → "Agence du revenu du Canada" is fine; but "Microsoft" stays "Microsoft").
3. Use the formal "vous" form of address.
4. Use Canadian French spelling (e.g. "courriel" not "email", "rétroaction" not "feedback", "gestion" not "management" where appropriate).
5. Translate idiomatically, not literally. Government accountability terminology: "contract" = contrat; "grant" = subvention; "vendor concentration" = concentration des fournisseurs; "amendment creep" = dérive des avenants; "zombie recipient" = bénéficiaire fantôme; "ghost capacity" = capacité fantôme; "funding loop" = boucle de financement; "sole source" = fournisseur unique; "policy misalignment" = décalage avec les politiques; "adverse media" = couverture médiatique défavorable; "duplicative funding" = financement en double; "contract intelligence" = renseignements sur les contrats; "related parties" = parties liées.
6. Keep the same punctuation structure as the source. Preserve trailing/leading spaces.
7. If the input is only whitespace, an emoji, a number, a currency amount, a BN, or a URL with no natural language, return it UNCHANGED.
8. You will receive a JSON array of strings. Return a JSON array of the SAME length in the SAME order with each string translated. Return ONLY the JSON array, no markdown fences, no commentary.`;

async function translateBatch(
  strings: string[],
  targetLang: "fr"
): Promise<string[]> {
  if (strings.length === 0) return [];

  const key = `${targetLang}|${djb2(JSON.stringify(strings))}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const endpoint = getAzureOpenAIEndpoint();
  const token = await getAzureOpenAIToken();

  const userContent = `Translate each of these ${strings.length} strings to Canadian French (target=${targetLang}). Return JSON array of same length.

${JSON.stringify(strings)}`;

  const res = await fetch(
    `${endpoint}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 4000,
        response_format: { type: "json_object" },
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`openai ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = data.choices?.[0]?.message?.content ?? "";

  // The model returns either a raw JSON array, or an object wrapping one.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  let arr: unknown = null;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const first = Object.values(obj).find(Array.isArray);
    if (first) arr = first;
  }

  if (!Array.isArray(arr) || arr.length !== strings.length) {
    // Fallback: return originals rather than breaking the page.
    return strings;
  }

  const out: string[] = arr.map((v, i) => (typeof v === "string" ? v : strings[i]));

  if (cache.size >= MAX_CACHE) {
    // simple FIFO eviction
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, out);
  return out;
}

export async function POST(req: NextRequest) {
  let body: { strings?: unknown; targetLang?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const strings = Array.isArray(body.strings)
    ? body.strings.filter((s): s is string => typeof s === "string")
    : [];
  const targetLang = body.targetLang === "fr" ? "fr" : null;

  if (!targetLang) {
    return NextResponse.json({ strings });
  }
  if (strings.length === 0) {
    return NextResponse.json({ strings: [] });
  }
  if (strings.length > 300) {
    return NextResponse.json({ error: "batch too large (max 300)" }, { status: 413 });
  }

  try {
    const out = await translateBatch(strings, targetLang);
    return NextResponse.json({ strings: out });
  } catch (err) {
    // Fail open: return source strings so the page still renders.
    console.error("translate error:", err);
    return NextResponse.json({ strings, error: String(err) }, { status: 200 });
  }
}
