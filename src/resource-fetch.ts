import { DEFAULT_MAX_BYTES, DEFAULT_MAX_CHARS } from "./constants.js";
import { isStructuredTextResource } from "./helpers.js";

export interface ResourceFetchResult {
  fetchedDirectly: boolean;
  directFetchReason: string;
  requestedUrl: string;
  finalUrl: string;
  contentType: string | null;
  contentLength: number | null;
  format: string | null;
  mimeType: string | null;
  previewText: string | null;
  previewTruncated: boolean;
  bytesRead: number;
}

export async function fetchResourcePreview(options: {
  url: string;
  format?: string | null;
  mimeType?: string | null;
  maxBytes?: number;
  maxChars?: number;
}): Promise<ResourceFetchResult> {
  const response = await fetch(options.url, {
    headers: {
      "Accept-Language": "en",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Resource request failed with ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type");
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
  const shouldFetchDirectly = isStructuredTextResource(options.format, contentType ?? options.mimeType, response.url);

  if (!shouldFetchDirectly) {
    return {
      fetchedDirectly: false,
      directFetchReason: "Resource appears to be binary or non-textual, so metadata and the source URL are returned instead of inline content.",
      requestedUrl: options.url,
      finalUrl: response.url,
      contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      format: options.format ?? null,
      mimeType: options.mimeType ?? null,
      previewText: null,
      previewTruncated: false,
      bytesRead: 0,
    };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const body = await readBodyPreview(response, maxBytes);
  const previewText = new TextDecoder().decode(body.bytes).slice(0, maxChars);

  return {
    fetchedDirectly: true,
    directFetchReason: "Resource looks like structured text, so a bounded inline preview was fetched.",
    requestedUrl: options.url,
    finalUrl: response.url,
    contentType,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
    format: options.format ?? null,
    mimeType: options.mimeType ?? null,
    previewText,
    previewTruncated: body.truncated || previewText.length >= maxChars,
    bytesRead: body.bytes.byteLength,
  };
}

async function readBodyPreview(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    const fallback = new Uint8Array(await response.arrayBuffer());
    if (fallback.byteLength <= maxBytes) {
      return { bytes: fallback, truncated: false };
    }

    return {
      bytes: fallback.subarray(0, maxBytes),
      truncated: true,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value || value.byteLength === 0) {
      continue;
    }

    const remaining = maxBytes - bytesRead;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }

    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      bytesRead += remaining;
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    bytesRead += value.byteLength;
  }

  const merged = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    bytes: merged,
    truncated,
  };
}

