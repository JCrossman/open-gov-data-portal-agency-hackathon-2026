import { datastoreSearch } from "./datastore.js";
import { T3010_DIRECTORS_RESOURCE_ID } from "./constants.js";
import { normalizeWhitespace } from "./helpers.js";

export interface DirectorRecord {
  bn: string;
  lastName: string;
  firstName: string;
  position: string;
  atArmsLength: string;
  startDate: string;
}

export interface DirectorSearchResult {
  directors: DirectorRecord[];
  total: number;
  multiBoardFlags: Array<{ name: string; boards: Array<{ bn: string; position: string }> }>;
}

export async function searchCharityDirectors(options: {
  lastName?: string | undefined;
  firstName?: string | undefined;
  bn?: string | undefined;
  limit?: number | undefined;
}): Promise<DirectorSearchResult> {
  const filters: Record<string, string> = {};
  if (options.bn) filters.BN = options.bn;
  if (options.lastName) filters["Last Name"] = options.lastName;
  if (options.firstName) filters["First Name"] = options.firstName;

  const result = await datastoreSearch({
    resourceId: T3010_DIRECTORS_RESOURCE_ID,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    limit: options.limit ?? 100,
  });

  const directors = result.records.map(parseDirectorRecord);
  const multiBoardFlags = detectMultiBoard(directors);

  return { directors, total: result.total, multiBoardFlags };
}

export function formatDirectorSearchText(result: DirectorSearchResult, options?: { lastName?: string | undefined; bn?: string | undefined }): string {
  const lines: string[] = [];
  lines.push("Charity Directors/Officers Search (T3010)");
  lines.push("");

  if (options?.lastName) lines.push(`Last name: ${options.lastName}`);
  if (options?.bn) lines.push(`BN: ${options.bn}`);
  lines.push(`Total matching records: ${fmt(result.total)} | Showing: ${fmt(result.directors.length)}`);

  if (result.multiBoardFlags.length > 0) {
    lines.push("");
    lines.push(`⚠️ MULTI-BOARD INDIVIDUALS: ${result.multiBoardFlags.length} person(s) sit on multiple charity boards`);
    for (const flag of result.multiBoardFlags) {
      lines.push(`  ${flag.name} — ${flag.boards.length} boards:`);
      for (const board of flag.boards) {
        lines.push(`    BN ${board.bn} as ${board.position}`);
      }
    }
  }

  if (result.directors.length > 0) {
    lines.push("");
    lines.push("| Last Name | First Name | BN | Position | At Arm's Length | Start Date |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const dir of result.directors.slice(0, 30)) {
      lines.push(`| ${dir.lastName} | ${dir.firstName} | ${dir.bn} | ${dir.position} | ${dir.atArmsLength} | ${dir.startDate} |`);
    }
  }

  return lines.join("\n");
}

function detectMultiBoard(directors: DirectorRecord[]): DirectorSearchResult["multiBoardFlags"] {
  const byName = new Map<string, Array<{ bn: string; position: string }>>();

  for (const dir of directors) {
    const key = `${dir.lastName.toUpperCase()}|${dir.firstName.toUpperCase()}`;
    if (!byName.has(key)) byName.set(key, []);
    const boards = byName.get(key)!;
    if (!boards.some((b) => b.bn === dir.bn)) {
      boards.push({ bn: dir.bn, position: dir.position });
    }
  }

  return Array.from(byName.entries())
    .filter(([, boards]) => boards.length >= 2)
    .map(([key, boards]) => ({
      name: key.replace(/\|/g, ", "),
      boards,
    }));
}

function parseDirectorRecord(record: Record<string, unknown>): DirectorRecord {
  return {
    bn: norm(record.BN),
    lastName: norm(record["Last Name"]),
    firstName: norm(record["First Name"]),
    position: norm(record.Position),
    atArmsLength: norm(record["At Arm's Length"]),
    startDate: norm(record["Start Date"]),
  };
}

function norm(value: unknown): string {
  return normalizeWhitespace(String(value ?? ""));
}

function fmt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
