import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

const SECRET =
  process.env.SHARE_SECRET ||
  process.env.ACCESS_CODE ||
  "opengov-share-fallback-secret";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", SECRET).update(payload).digest());
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      turns?: unknown;
      lang?: string;
    };
    if (!Array.isArray(body.turns) || body.turns.length === 0) {
      return NextResponse.json({ error: "turns required" }, { status: 400 });
    }
    // Keep share payload small — question + narrative + row count per turn
    const condensed = body.turns.slice(0, 20).map((raw) => {
      const t = raw as {
        question?: unknown;
        narrative?: unknown;
        rowCount?: unknown;
        sql?: unknown;
      };
      return {
        q: typeof t.question === "string" ? t.question.slice(0, 500) : "",
        n: typeof t.narrative === "string" ? t.narrative.slice(0, 1500) : "",
        c: typeof t.rowCount === "number" ? t.rowCount : 0,
        s: typeof t.sql === "string" ? t.sql.slice(0, 2000) : "",
      };
    });
    const payload = {
      turns: condensed,
      lang: body.lang === "fr" ? "fr" : "en",
      ts: Date.now(),
    };
    const data = b64url(Buffer.from(JSON.stringify(payload)));
    const sig = sign(data);
    const id = `${data}.${sig}`;
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message?.slice(0, 200) ?? "Unknown error" },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id") ?? "";
  const dot = id.indexOf(".");
  if (dot < 0) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const data = id.slice(0, dot);
  const sig = id.slice(dot + 1);
  const expected = sign(data);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }
  try {
    const payload = JSON.parse(b64urlDecode(data).toString("utf-8"));
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
}
