import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { DefaultAzureCredential } from "@azure/identity";

const EMBEDDING_DEPLOYMENT = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 256;
const API_VERSION = "2024-08-01-preview";

function getAzureOpenAIEndpoint(): string {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) throw new Error("AZURE_OPENAI_ENDPOINT env var is required");
  return endpoint;
}

async function getEmbedding(text: string): Promise<number[]> {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  const url = `${getAzureOpenAIEndpoint()}/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=${API_VERSION}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: [text], dimensions: EMBEDDING_DIMENSIONS }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

export async function GET(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get("name")?.trim();
    const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 10), 50);
    const source = request.nextUrl.searchParams.get("source"); // filter: vendor, charity, grant_recipient

    if (!name) {
      return NextResponse.json({ error: "Provide ?name= parameter" }, { status: 400 });
    }

    // Generate embedding for the search term
    const embedding = await getEmbedding(name);
    const vectorLiteral = `[${embedding.join(",")}]`;

    // Find similar entities using cosine distance
    let sourceFilter = "";
    const params: unknown[] = [vectorLiteral, limit];
    if (source) {
      sourceFilter = "AND source = $3";
      params.push(source);
    }

    const matches = await query<{
      entity_name: string;
      source: string;
      bn: string | null;
      similarity: number;
    }>(`
      SELECT entity_name, source, bn,
             1 - (embedding <=> $1::vector) AS similarity
      FROM entity_embeddings
      WHERE 1 = 1 ${sourceFilter}
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, params);

    return NextResponse.json({
      query: name,
      matches: matches.map((m) => ({
        name: m.entity_name,
        source: m.source,
        bn: m.bn,
        similarity: Number(Number(m.similarity).toFixed(4)),
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message?.substring(0, 200) },
      { status: 500 },
    );
  }
}
