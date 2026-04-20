import type { NormalizedResource } from "./catalog.js";
import { isStructuredTextResource } from "./helpers.js";

export function selectRecommendedResource(
  resources: NormalizedResource[],
  options?: {
    preferAnalysisFriendly?: boolean | undefined;
    preferGeoJson?: boolean | undefined;
  },
): NormalizedResource | null {
  let best: { resource: NormalizedResource; score: number } | null = null;

  for (const resource of resources) {
    const score = scoreResource(resource, {
      preferAnalysisFriendly: options?.preferAnalysisFriendly ?? false,
      preferGeoJson: options?.preferGeoJson ?? false,
    });
    if (!best || score > best.score) {
      best = { resource, score };
    }
  }

  return best?.resource ?? null;
}

function scoreResource(
  resource: NormalizedResource,
  options: {
    preferAnalysisFriendly: boolean;
    preferGeoJson: boolean;
  },
): number {
  let score = 0;

  if (isStructuredTextResource(resource.format, resource.mimeType, resource.url)) {
    score += 100;
  }

  const format = (resource.format ?? "").toUpperCase();
  if (format === "CSV") {
    score += options.preferAnalysisFriendly ? 40 : 25;
  } else if (format === "GEOJSON") {
    score += options.preferGeoJson ? 80 : options.preferAnalysisFriendly ? 35 : 30;
  } else if (format === "JSON") {
    score += options.preferGeoJson ? 10 : options.preferAnalysisFriendly ? 35 : 30;
  } else if (format === "JSONL") {
    score += options.preferAnalysisFriendly ? 30 : 20;
  } else if (format === "XML") {
    score += 15;
  } else if (format === "TXT") {
    score += 10;
  } else if (format === "HTML" && options.preferAnalysisFriendly) {
    score -= 20;
  }

  if (options.preferGeoJson && looksGeoJsonLike(resource)) {
    score += 60;
  }

  if (resource.datastoreActive) {
    score += 15;
  }

  if ((resource.resourceType ?? "").toLowerCase() === "api") {
    score += options.preferAnalysisFriendly ? 5 : 10;
  }

  return score;
}

export function looksGeoJsonLike(resource: Pick<NormalizedResource, "format" | "mimeType" | "url">): boolean {
  const format = (resource.format ?? "").toUpperCase();
  const mimeType = (resource.mimeType ?? "").toLowerCase();
  const url = resource.url.toLowerCase();

  return (
    format === "GEOJSON"
    || mimeType.includes("application/geo+json")
    || url.endsWith(".geojson")
    || url.includes("f=geojson")
  );
}
