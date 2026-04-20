import { datastoreSearch } from "./datastore.js";
import { T3010_QUALIFIED_DONEES_RESOURCE_ID } from "./constants.js";
import { normalizeWhitespace } from "./helpers.js";

export interface CharityTransfer {
  donorBN: string;
  doneeBN: string;
  doneeName: string;
  totalGifts: number | null;
  associated: string;
  city: string;
  province: string;
}

export interface TransferSearchResult {
  transfers: CharityTransfer[];
  total: number;
  reciprocalFlags: Array<{ bnA: string; bnB: string; aToB: number | null; bToA: number | null }>;
}

export async function searchCharityTransfers(options: {
  donorBN?: string | undefined;
  doneeBN?: string | undefined;
  doneeName?: string | undefined;
  limit?: number | undefined;
}): Promise<TransferSearchResult> {
  const filters: Record<string, string> = {};
  if (options.donorBN) filters.BN = options.donorBN;
  if (options.doneeBN) filters["Donee BN"] = options.doneeBN;
  if (options.doneeName) filters["Donee Name"] = options.doneeName;

  const result = await datastoreSearch({
    resourceId: T3010_QUALIFIED_DONEES_RESOURCE_ID,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    limit: options.limit ?? 100,
  });

  const transfers = result.records.map(parseTransfer);

  // Check for reciprocal transfers
  const reciprocalFlags = await detectReciprocalTransfers(transfers);

  return { transfers, total: result.total, reciprocalFlags };
}

export async function detectFundingLoops(startingBN: string, maxHops: number = 2): Promise<{
  chain: Array<{ fromBN: string; toBN: string; toName: string; amount: number | null }>;
  loopDetected: boolean;
  loopBN: string | null;
}> {
  const visited = new Set<string>();
  const chain: Array<{ fromBN: string; toBN: string; toName: string; amount: number | null }> = [];
  let currentBN = startingBN;
  visited.add(currentBN);

  for (let hop = 0; hop < maxHops; hop++) {
    const result = await datastoreSearch({
      resourceId: T3010_QUALIFIED_DONEES_RESOURCE_ID,
      filters: { BN: currentBN },
      limit: 20,
    });

    if (result.records.length === 0) break;

    // Follow the largest transfer
    const transfers = result.records.map(parseTransfer).filter((t) => t.doneeBN && t.totalGifts !== null);
    transfers.sort((a, b) => (b.totalGifts ?? 0) - (a.totalGifts ?? 0));

    for (const transfer of transfers) {
      chain.push({ fromBN: currentBN, toBN: transfer.doneeBN, toName: transfer.doneeName, amount: transfer.totalGifts });

      if (visited.has(transfer.doneeBN) || transfer.doneeBN === startingBN) {
        return { chain, loopDetected: true, loopBN: transfer.doneeBN };
      }

      visited.add(transfer.doneeBN);
      currentBN = transfer.doneeBN;
      break;
    }
  }

  return { chain, loopDetected: false, loopBN: null };
}

export function formatTransferSearchText(result: TransferSearchResult, options?: { donorBN?: string | undefined; doneeBN?: string | undefined }): string {
  const lines: string[] = [];
  lines.push("Charity-to-Charity Transfers (T3010 Qualified Donees)");
  lines.push("");

  if (options?.donorBN) lines.push(`Donor BN: ${options.donorBN}`);
  if (options?.doneeBN) lines.push(`Donee BN: ${options.doneeBN}`);
  lines.push(`Total matching records: ${fmt(result.total)} | Showing: ${fmt(result.transfers.length)}`);

  if (result.reciprocalFlags.length > 0) {
    lines.push("");
    lines.push(`⚠️ RECIPROCAL TRANSFERS DETECTED: ${result.reciprocalFlags.length} pair(s)`);
    for (const flag of result.reciprocalFlags) {
      lines.push(`  ${flag.bnA} → ${flag.bnB}: ${fmtDollars(flag.aToB)} | ${flag.bnB} → ${flag.bnA}: ${fmtDollars(flag.bToA)}`);
    }
  }

  if (result.transfers.length > 0) {
    lines.push("");
    lines.push("| Donor BN | Donee BN | Donee Name | Total Gifts | Associated | Province |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const t of result.transfers.slice(0, 30)) {
      lines.push(`| ${t.donorBN} | ${t.doneeBN} | ${trunc(t.doneeName, 30)} | ${fmtDollars(t.totalGifts)} | ${t.associated} | ${t.province} |`);
    }
  }

  return lines.join("\n");
}

export function formatLoopDetectionText(result: Awaited<ReturnType<typeof detectFundingLoops>>, startingBN: string): string {
  const lines: string[] = [];
  lines.push(`Funding Loop Detection starting from BN: ${startingBN}`);
  lines.push("");

  if (result.chain.length === 0) {
    lines.push("No outgoing transfers found for this charity.");
    return lines.join("\n");
  }

  lines.push("Transfer chain:");
  for (const [i, step] of result.chain.entries()) {
    lines.push(`  ${i + 1}. ${step.fromBN} → ${step.toBN} (${step.toName}) — ${fmtDollars(step.amount)}`);
  }

  if (result.loopDetected) {
    lines.push("");
    lines.push(`⚠️ LOOP DETECTED: BN ${result.loopBN} appears again in the chain.`);
    if (result.loopBN === startingBN) {
      lines.push("Money has circled back to the original charity.");
    }
  } else {
    lines.push("");
    lines.push("No loop detected within the search depth.");
  }

  return lines.join("\n");
}

async function detectReciprocalTransfers(transfers: CharityTransfer[]): Promise<TransferSearchResult["reciprocalFlags"]> {
  const flags: TransferSearchResult["reciprocalFlags"] = [];
  const checked = new Set<string>();

  for (const transfer of transfers) {
    if (!transfer.doneeBN || !transfer.donorBN) continue;
    const pairKey = [transfer.donorBN, transfer.doneeBN].sort().join("|");
    if (checked.has(pairKey)) continue;
    checked.add(pairKey);

    // Check if the donee also gives back to the donor
    try {
      const reverseResult = await datastoreSearch({
        resourceId: T3010_QUALIFIED_DONEES_RESOURCE_ID,
        filters: { BN: transfer.doneeBN, "Donee BN": transfer.donorBN },
        limit: 1,
      });

      if (reverseResult.records.length > 0) {
        const reverse = parseTransfer(reverseResult.records[0]!);
        flags.push({
          bnA: transfer.donorBN,
          bnB: transfer.doneeBN,
          aToB: transfer.totalGifts,
          bToA: reverse.totalGifts,
        });
      }
    } catch {
      // Ignore errors in reverse lookup
    }
  }

  return flags;
}

function parseTransfer(record: Record<string, unknown>): CharityTransfer {
  return {
    donorBN: norm(record.BN),
    doneeBN: norm(record["Donee BN"]),
    doneeName: norm(record["Donee Name"]),
    totalGifts: parseNum(record["Total Gifts"]),
    associated: norm(record.Associated),
    city: norm(record.City),
    province: norm(record.Province),
  };
}

function parseNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,\s]/g, "").trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function norm(value: unknown): string {
  return normalizeWhitespace(String(value ?? ""));
}

function trunc(value: string, max: number): string {
  const v = value.replace(/[\\|]/g, "\\$&");
  return v.length <= max ? v : v.substring(0, max - 1) + "…";
}

function fmtDollars(value: number | null): string {
  if (value === null) return "—";
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}`;
}

function fmt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
