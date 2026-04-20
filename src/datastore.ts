import { CATALOG_API_BASE_URL } from "./constants.js";
import { normalizeWhitespace } from "./helpers.js";

export interface DatastoreField {
  id: string;
  type: string;
}

export interface DatastoreSearchResult {
  resourceId: string;
  fields: DatastoreField[];
  records: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

export interface DatastoreSearchOptions {
  resourceId: string;
  query?: string | undefined;
  filters?: Record<string, string | string[]> | undefined;
  fields?: string[] | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function datastoreSearch(options: DatastoreSearchOptions): Promise<DatastoreSearchResult> {
  const params = new URLSearchParams();
  params.set("resource_id", options.resourceId);

  if (options.query) {
    params.set("q", options.query);
  }

  if (options.filters && Object.keys(options.filters).length > 0) {
    params.set("filters", JSON.stringify(options.filters));
  }

  if (options.fields && options.fields.length > 0) {
    params.set("fields", options.fields.join(","));
  }

  if (options.sort) {
    params.set("sort", options.sort);
  }

  params.set("limit", String(options.limit ?? 10));

  if (options.offset) {
    params.set("offset", String(options.offset));
  }

  const url = `${CATALOG_API_BASE_URL}/datastore_search?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "en",
    },
  });

  if (!response.ok) {
    throw new Error(`DataStore search failed with ${response.status} ${response.statusText}`);
  }

  const envelope = (await response.json()) as {
    success: boolean;
    result?: {
      resource_id: string;
      fields: DatastoreField[];
      records: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
    };
    error?: { message?: string };
  };

  if (!envelope.success || !envelope.result) {
    throw new Error(envelope.error?.message ?? "DataStore search failed");
  }

  return {
    resourceId: envelope.result.resource_id,
    fields: envelope.result.fields,
    records: envelope.result.records,
    total: envelope.result.total,
    limit: envelope.result.limit,
    offset: envelope.result.offset,
  };
}

export function formatDatastoreSearchText(result: DatastoreSearchResult, options?: {
  query?: string | undefined;
  title?: string | undefined;
}): string {
  const lines: string[] = [];
  const title = options?.title ?? "DataStore search results";
  lines.push(title);
  lines.push("");

  if (options?.query) {
    lines.push(`Search: "${options.query}"`);
  }

  lines.push(`Total matching records: ${formatCount(result.total)} | Showing: ${formatCount(result.records.length)} (offset ${formatCount(result.offset)})`);

  const userFields = result.fields.filter((f) => !f.id.startsWith("_"));
  lines.push(`Fields: ${userFields.map((f) => f.id).join(", ")}`);

  if (result.records.length > 0) {
    lines.push("");

    const displayFields = pickDisplayFields(userFields, 6);
    const header = `| ${displayFields.map((f) => f.id).join(" | ")} |`;
    const separator = `| ${displayFields.map(() => "---").join(" | ")} |`;
    lines.push(header);
    lines.push(separator);

    for (const record of result.records.slice(0, 20)) {
      const cells = displayFields.map((f) => formatCell(record[f.id]));
      lines.push(`| ${cells.join(" | ")} |`);
    }

    if (result.records.length > 20) {
      lines.push("");
      lines.push(`Only the first 20 records are shown in this table.`);
    }
  } else {
    lines.push("");
    lines.push("No records matched the search criteria.");
  }

  if (result.total > result.records.length) {
    lines.push("");
    lines.push(`There are ${formatCount(result.total - result.records.length)} more records. Increase the limit or use offset for pagination.`);
  }

  return lines.join("\n");
}

function pickDisplayFields(fields: DatastoreField[], max: number): DatastoreField[] {
  if (fields.length <= max) {
    return fields;
  }

  const priorityNames = ["vendor_name", "contract_value", "original_value", "amendment_value", "solicitation_procedure", "owner_org_title", "description_en", "contract_date", "commodity_type", "recipient_name", "agreement_value", "title", "name", "date"];
  const picked: DatastoreField[] = [];
  const seen = new Set<string>();

  for (const name of priorityNames) {
    const field = fields.find((f) => f.id === name);
    if (field && !seen.has(field.id)) {
      picked.push(field);
      seen.add(field.id);
      if (picked.length >= max) {
        return picked;
      }
    }
  }

  for (const field of fields) {
    if (!seen.has(field.id)) {
      picked.push(field);
      seen.add(field.id);
      if (picked.length >= max) {
        return picked;
      }
    }
  }

  return picked;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const str = normalizeWhitespace(String(value));
  if (str.length > 50) {
    return str.substring(0, 49) + "…";
  }

  return str.replace(/\|/g, "\\|");
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
