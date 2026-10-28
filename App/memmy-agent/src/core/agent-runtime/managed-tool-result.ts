/** Version 1 carries bounded MCP content from the authenticated Host. It never
 * discovers URLs, reads files or writes the native tool-image cache. */
export interface ManagedToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
  isError?: boolean;
}
export const MANAGED_TOOL_RESULT_PROTOCOL = 1;
const MAX_BYTES = 16 * 1024 * 1024;
const invalid = () => new Error("Invalid managed runtime tool result");
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => "value" in item);
}

export function parseManagedToolResult(value: unknown): string | ManagedToolResult {
  if (typeof value === "string") { if (Buffer.byteLength(value) > MAX_BYTES) throw invalid(); return value; }
  if (!record(value) || Object.keys(value).some(key => !["content", "isError"].includes(key))
    || !Array.isArray(value.content) || value.content.length > 64
    || value.isError !== undefined && typeof value.isError !== "boolean") throw invalid();
  let size = 0;
  const content = value.content.map((item): ManagedToolResult["content"][number] => {
    if (!record(item)) throw invalid();
    if (item.type === "text" && typeof item.text === "string" && Object.keys(item).every(key => ["type", "text"].includes(key))) {
      size += Buffer.byteLength(item.text); if (size > MAX_BYTES) throw invalid();
      return { type: "text", text: item.text };
    }
    if (item.type === "image" && typeof item.mimeType === "string" && /^image\/(?:png|jpeg|gif|webp)$/u.test(item.mimeType)
      && typeof item.data === "string" && item.data.length > 0 && item.data.length % 4 === 0
      && Object.keys(item).every(key => ["type", "mimeType", "data"].includes(key))) {
      size += item.data.length; if (size > MAX_BYTES) throw invalid();
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(item.data) || Buffer.from(item.data, "base64").toString("base64") !== item.data) throw invalid();
      return { type: "image", mimeType: item.mimeType, data: item.data };
    }
    throw invalid();
  });
  const result: ManagedToolResult = { content, ...(value.isError === undefined ? {} : { isError: value.isError }) };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw invalid();
  return result;
}

/** Bound the HTTP body before parsing; an oversized Host response cannot be buffered unchecked. */
export async function readManagedExecutionResponse(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const parts: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length;
      if (total > MAX_BYTES + 4096) { await reader.cancel(); throw invalid(); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(parts, total).toString("utf8")); } catch { throw invalid(); }
  if (!record(value)) throw invalid();
  return value;
}

export function managedToolResultContent(result: string | ManagedToolResult): string | Array<Record<string, unknown>> {
  if (typeof result === "string") return result;
  const blocks: Array<Record<string, unknown>> = result.content.map(item => item.type === "text" ? { ...item }
    : { type: "image_url", image_url: { url: `data:${item.mimeType};base64,${item.data}`, detail: "auto" } });
  if (result.isError) blocks.unshift({ type: "text", text: "Tool reported an execution error." });
  return blocks.length ? blocks : [{ type: "text", text: "(no output)" }];
}

/** Match the existing string budget across all text blocks without touching images
 * or persisting overflow to a native file. Non-positive budgets retain legacy semantics. */
export function limitManagedToolResultText(content: Array<Record<string, unknown>>, maxChars: number): Array<Record<string, unknown>> {
  if (!(maxChars > 0) || !Number.isFinite(maxChars)) return content;
  const length = content.reduce((total, block) => total + (block.type === "text" && typeof block.text === "string" ? block.text.length : 0), 0);
  if (length <= maxChars) return content;
  let remaining = Math.floor(maxChars), truncated = false, changed = false;
  const limited: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") { limited.push(block); continue; }
    if (truncated) { changed = true; continue; }
    if (block.text.length <= remaining) { remaining -= block.text.length; limited.push(block); continue; }
    const text = `${block.text.slice(0, remaining)}\n... (truncated)`;
    limited.push(text === block.text ? block : { ...block, text });
    changed ||= text !== block.text; truncated = true;
  }
  return changed ? limited : content;
}

/** The event stream is a text log, not a second image transport. */
export function managedToolResultSummary(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  let output = "";
  for (const block of blocks) {
    const text = typeof block === "string" ? block : block?.type === "text" && typeof block.text === "string" ? block.text
      : block?.type === "image_url" || block?.type === "image" ? "[Image attachment]" : "[Structured tool content]";
    const remaining = 32768 - output.length;
    if (text.length + 1 > remaining) return output + text.slice(0, Math.max(remaining, 0)) + "\n[Output truncated]";
    output += text + "\n";
  }
  return output.trimEnd() || "(no output)";
}
