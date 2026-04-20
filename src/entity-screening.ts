import { datastoreSearch } from "./datastore.js";
import { T3010_IDENTIFICATION_RESOURCE_ID } from "./constants.js";
import { normalizeWhitespace } from "./helpers.js";

export interface ScreeningResult {
  entityName: string;
  businessNumber: string | null;
  governmentRedFlags: Array<{ source: string; severity: "high" | "medium" | "low"; detail: string }>;
  charityStatus: { found: boolean; category: string | null; designation: string | null; flagged: boolean; reason: string | null } | null;
  webSearchResults: Array<{ title: string; url: string; snippet: string }> | null;
  webSearchNote: string | null;
}

export async function screenEntity(options: {
  entityName: string;
  businessNumber?: string | undefined;
  includeWebSearch?: boolean | undefined;
}): Promise<ScreeningResult> {
  const flags: ScreeningResult["governmentRedFlags"] = [];

  // Check T3010 charity status if BN provided
  let charityStatus: ScreeningResult["charityStatus"] = null;
  if (options.businessNumber) {
    try {
      const idResult = await datastoreSearch({
        resourceId: T3010_IDENTIFICATION_RESOURCE_ID,
        filters: { BN: options.businessNumber },
        limit: 1,
      });

      if (idResult.records[0]) {
        const rec = idResult.records[0];
        const designation = norm(rec.Designation);
        const category = norm(rec.Category);
        const isRevoked = designation.toLowerCase().includes("revoked");
        const isAnnulled = designation.toLowerCase().includes("annulled");
        const isFlagged = isRevoked || isAnnulled;

        charityStatus = {
          found: true,
          category,
          designation,
          flagged: isFlagged,
          reason: isFlagged ? `Charity designation is "${designation}"` : null,
        };

        if (isFlagged) {
          flags.push({
            source: "CRA T3010 Charity Status",
            severity: "high",
            detail: `Charity designation: ${designation}`,
          });
        }
      } else {
        charityStatus = { found: false, category: null, designation: null, flagged: false, reason: null };
      }
    } catch {
      // Ignore lookup errors
    }
  }

  // Check Acts of Founded Wrongdoing (search by name in the proactive disclosure)
  try {
    const wrongdoingResult = await datastoreSearch({
      resourceId: "4e4db232-f5e8-43c7-b8b2-439eb7d55475",
      query: options.entityName,
      limit: 5,
    });

    for (const rec of wrongdoingResult.records) {
      flags.push({
        source: "Acts of Founded Wrongdoing",
        severity: "high",
        detail: norm(rec.case_description_en).substring(0, 200) || norm(rec.findings_conclusions).substring(0, 200),
      });
    }
  } catch {
    // Wrongdoing dataset may not support text search — continue
  }

  // Web search layer (optional)
  let webSearchResults: ScreeningResult["webSearchResults"] = null;
  let webSearchNote: string | null = null;

  if (options.includeWebSearch) {
    const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (braveApiKey) {
      try {
        const query = `"${options.entityName}" (fraud OR investigation OR sanction OR violation OR bankruptcy OR enforcement OR penalty OR convicted)`;
        const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&safesearch=off`;
        const response = await fetch(searchUrl, {
          headers: { Accept: "application/json", "X-Subscription-Token": braveApiKey },
        });

        if (response.ok) {
          const body = (await response.json()) as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
          webSearchResults = (body.web?.results ?? []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.description,
          }));
        }
      } catch {
        webSearchNote = "Web search failed. Check BRAVE_SEARCH_API_KEY.";
      }
    } else {
      webSearchNote = "Web search unavailable: set BRAVE_SEARCH_API_KEY environment variable to enable.";
    }
  }

  return {
    entityName: options.entityName,
    businessNumber: options.businessNumber ?? null,
    governmentRedFlags: flags,
    charityStatus,
    webSearchResults,
    webSearchNote,
  };
}

export function formatScreeningText(result: ScreeningResult): string {
  const lines: string[] = [];
  lines.push(`Entity Screening: ${result.entityName}`);
  if (result.businessNumber) lines.push(`Business Number: ${result.businessNumber}`);
  lines.push("");

  // Government red flags
  lines.push("## Government-Sourced Red Flags");
  if (result.governmentRedFlags.length === 0) {
    lines.push("No government red flags found.");
  } else {
    for (const flag of result.governmentRedFlags) {
      const icon = flag.severity === "high" ? "🔴" : flag.severity === "medium" ? "🟡" : "⚪";
      lines.push(`${icon} [${flag.source}] ${flag.detail}`);
    }
  }

  // Charity status
  if (result.charityStatus) {
    lines.push("");
    lines.push("## CRA Charity Status");
    if (result.charityStatus.found) {
      lines.push(`Category: ${result.charityStatus.category} | Designation: ${result.charityStatus.designation}`);
      if (result.charityStatus.flagged) {
        lines.push(`⚠️ ${result.charityStatus.reason}`);
      } else {
        lines.push("Status appears normal.");
      }
    } else {
      lines.push("Not found as a registered charity.");
    }
  }

  // Web search
  if (result.webSearchResults !== null) {
    lines.push("");
    lines.push("## Adverse Media (Web Search)");
    if (result.webSearchResults.length === 0) {
      lines.push("No adverse media results found.");
    } else {
      for (const [i, r] of result.webSearchResults.entries()) {
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        lines.push(`   ${r.snippet.substring(0, 150)}`);
      }
    }
  }

  if (result.webSearchNote) {
    lines.push("");
    lines.push(`Note: ${result.webSearchNote}`);
  }

  return lines.join("\n");
}

function norm(value: unknown): string {
  return normalizeWhitespace(String(value ?? ""));
}
