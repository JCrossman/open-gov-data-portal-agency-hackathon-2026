import { NextRequest, NextResponse } from "next/server";
import { DefaultAzureCredential } from "@azure/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Azure Neural TTS — produces far more natural audio than browser speechSynthesis.
// Uses AAD (managed identity) because local-auth is disabled on the resource.

const REGION = process.env.AZURE_SPEECH_REGION;
const RESOURCE_ID = process.env.AZURE_SPEECH_RESOURCE_ID;

const VOICES: Record<"en" | "fr", string> = {
  en: "en-CA-ClaraNeural",
  fr: "fr-CA-SylvieNeural",
};

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return c;
    }
  });
}

async function getToken(): Promise<string> {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  return token.token;
}

export async function POST(req: NextRequest) {
  if (!REGION) {
    return NextResponse.json({ error: "TTS not configured" }, { status: 501 });
  }

  let body: { text?: string; lang?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const text = String(body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (text.length > 5000) return NextResponse.json({ error: "text too long" }, { status: 413 });

  const lang: "en" | "fr" = body.lang === "fr" ? "fr" : "en";
  const voice = VOICES[lang];
  const locale = lang === "fr" ? "fr-CA" : "en-CA";

  const ssml = `<speak version="1.0" xml:lang="${locale}" xmlns:mstts="http://www.w3.org/2001/mstts"><voice name="${voice}"><mstts:express-as style="friendly"><prosody rate="-4%">${escapeXml(text)}</prosody></mstts:express-as></voice></speak>`;

  let token: string;
  try {
    token = await getToken();
  } catch (err) {
    return NextResponse.json({ error: "auth failed", detail: String(err) }, { status: 500 });
  }

  const res = await fetch(
    `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        // Azure Speech AAD format: `aad#<resourceId>#<token>`
        Authorization: RESOURCE_ID
          ? `Bearer aad#${RESOURCE_ID}#${token}`
          : `Bearer ${token}`,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "opengov-app",
      },
      body: ssml,
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `TTS upstream ${res.status}`, detail: detail.slice(0, 500) },
      { status: 502 }
    );
  }

  const audio = await res.arrayBuffer();
  return new NextResponse(audio, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
