import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedExecutionScope, executeManagedTool, withManagedExecution, withManagedFileCall, withAuthorizedReadPath } from "../../../src/core/agent-runtime/managed-execution.js";
import { limitManagedToolResultText, managedToolResultContent, managedToolResultSummary, parseManagedToolResult, readManagedExecutionResponse } from "../../../src/core/agent-runtime/managed-tool-result.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { ToolCallRequest } from "../../../src/providers/base.js";
import { OpenAICompatProvider } from "../../../src/providers/openai-compat-provider.js";
import { convertMessages } from "../../../src/providers/openai-responses/converters.js";
import * as artifacts from "../../../src/utils/artifacts.js";
import * as helpers from "../../../src/utils/helpers.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIioAAAAASUVORK5CYII=";
const image = () => ({ content: [{ type: "text", text: "Current window" }, { type: "image", data: png, mimeType: "image/png" }] });
const credential = { protocol: 2, tools: [{ name: "computer_use_snapshot", description: "Host product tool", inputSchema: { type: "object" } }],
  url: "http://127.0.0.1:12345/authorize", token: "a".repeat(64) };
const scope = (protocol?: unknown, signal = new AbortController().signal) => createManagedExecutionScope({ ...credential,
  ...(protocol === undefined ? {} : { toolResultProtocol: protocol }) }, signal);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("accepts negotiated generic MCP content and keeps old strings compatible", async () => {
  const requests: any[] = []; let output: unknown = image();
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { requests.push(JSON.parse(init.body)); return Response.json({ decision: "allow", result: output }); }));
  for (const name of ["computer_use_snapshot", "read_file", "generate_image", "future_product_tool"]) {
    expect((await withManagedExecution(scope(1), () => executeManagedTool(name, { toolResultProtocol: 9 }))).result).toEqual(image());
    expect(requests.at(-1).toolResultProtocol).toBe(1); expect(requests.at(-1).args.toolResultProtocol).toBe(9);
  }
  await expect(withManagedExecution(scope(), () => executeManagedTool("computer_use_snapshot", {}))).rejects.toThrow("require protocol 1");
  expect(requests.at(-1)).not.toHaveProperty("toolResultProtocol");
  output = "legacy result";
  for (const protocol of [undefined, 1]) expect((await withManagedExecution(scope(protocol), () => executeManagedTool("read_file", {}))).result).toBe(output);
  for (const protocol of [null, "1", 0, 2]) expect(() => scope(protocol)).toThrow("Unsupported managed tool result protocol");
});

it("rejects invalid blocks, external URLs, excessive data and getter-backed values", () => {
  for (const value of [null, {}, { content: "bad" }, { content: [], isError: "true" }, { content: [], path: "/private" },
    { content: [{ type: "image_url", image_url: { url: "https://example.test" } }] },
    { content: [{ type: "resource_link", uri: "file:///private/secret" }] },
    { content: [{ type: "image", mimeType: "image/svg+xml", data: png }] },
    { content: [{ type: "image", mimeType: "image/png", data: "Zh==" }] },
    { content: [{ type: "image", mimeType: "image/png", data: "" }] },
    { content: [{ type: "image", mimeType: "image/png", data: png, url: "https://example.test" }] },
    { content: Array.from({ length: 65 }, () => ({ type: "text", text: "" })) },
    { content: [{ type: "text", text: "x".repeat(16 * 1024 * 1024 + 1) }] },
  ]) expect(() => parseManagedToolResult(value)).toThrow("Invalid managed runtime tool result");
  let read = false;
  expect(() => parseManagedToolResult({ content: [{ type: "text", get text() { read = true; return "bad"; } }] })).toThrow();
  expect(read).toBe(false);
  const original = image(), result = parseManagedToolResult(original);
  original.content[0].text = "changed"; expect(result).toEqual(image());
  expect(managedToolResultContent(parseManagedToolResult({ content: [] }))).toEqual([{ type: "text", text: "(no output)" }]);
});

it("bounds the HTTP response while reading and cancels oversized transport bodies", async () => {
  const cancel = vi.fn(); let sent = 0;
  const response = new Response(new ReadableStream({ pull(controller) { sent++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel }));
  await expect(readManagedExecutionResponse(response)).rejects.toThrow("Invalid managed runtime tool result");
  expect(cancel).toHaveBeenCalledOnce(); expect(sent).toBeLessThanOrEqual(19);
});

it.each([false, true])("retains executed tool errors and content without falling back to native execution (failOnToolError=%s)", async failOnToolError => {
  vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", result: { ...image(), isError: true } })));
  const native = vi.fn(); const events: any[] = [], managed = scope(1); managed.onEvent = event => events.push(event);
  const [result] = await withManagedExecution(managed, () => new AgentRunner().executeTools(new AgentRunSpec({ failOnToolError,
    tools: { execute: native, get: () => ({ readOnly: true }) } as any }), [new ToolCallRequest({ id: "image", name: "computer_use_snapshot", arguments: {} })]));
  expect(native).not.toHaveBeenCalled(); expect(result.event).toMatchObject({ status: "error", executionError: { kind: "execution", code: "managed_tool_reported_error" } });
  expect(result.result).toContainEqual({ type: "text", text: "Tool reported an execution error." });
  expect(result.result[2].image_url.url).toBe(`data:image/png;base64,${png}`);
  expect(Boolean(result.error)).toBe(failOnToolError);
  expect(events.at(-1)).toMatchObject({ ok: false }); expect(JSON.stringify(events)).not.toContain(png);
});

it("drops late images after a turn ends or is cancelled", async () => {
  for (const method of ["closed", "aborted"]) {
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const controller = new AbortController(), managed = scope(1, controller.signal);
    const pending = withManagedExecution(managed, () => executeManagedTool("computer_use_snapshot", {}));
    if (method === "closed") managed.active = false; else controller.abort();
    release(Response.json({ decision: "allow", result: image() }));
    await expect(pending).rejects.toThrow("run has ended");
  }
});

it("uses the same text budget for negotiated text blocks and legacy strings without writing caches", async () => {
  vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
  const persistText = vi.spyOn(helpers, "maybePersistToolResult").mockImplementation(() => { throw new Error("native text write forbidden"); });
  let output: unknown;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", result: output })));
  const run = async (protocol?: 1, maxToolResultChars = 4) => {
    const [result] = await withManagedExecution(scope(protocol), () => new AgentRunner().executeTools(new AgentRunSpec({ maxToolResultChars,
      tools: { execute: vi.fn(), get: () => ({ readOnly: true }) } as any }),
    [new ToolCallRequest({ id: "bounded", name: "read_file", arguments: {} })]));
    return result.result;
  };
  output = "abcdefgh";
  const legacy = await run();
  expect(legacy).toBe("abcd\n... (truncated)"); expect(await run(1)).toBe(legacy);
  output = { content: [{ type: "text", text: "abcdefgh" }] };
  expect(await run(1)).toEqual([{ type: "text", text: legacy }]);
  expect(await run(1, 0)).toEqual([{ type: "text", text: "abcdefgh" }]);
  expect(persistText).not.toHaveBeenCalled();
});

it("shares one text budget across mixed blocks while preserving every image", async () => {
  vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
  const storeImage = vi.spyOn(artifacts, "storeToolImageArtifact").mockImplementation(() => { throw new Error("native image write forbidden"); });
  const persistText = vi.spyOn(helpers, "maybePersistToolResult").mockImplementation(() => { throw new Error("native text write forbidden"); });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", result: { content: [
    { type: "text", text: "ab" }, image().content[1], { type: "text", text: "cdefgh" },
    { type: "text", text: "must be omitted" }, image().content[1], { type: "text", text: "also omitted" },
  ] } })));
  const [result] = await withManagedExecution(scope(1), () => new AgentRunner().executeTools(new AgentRunSpec({ maxToolResultChars: 5,
    tools: { execute: vi.fn(), get: () => ({ readOnly: true }) } as any }),
  [new ToolCallRequest({ id: "mixed", name: "computer_use_snapshot", arguments: {} })]));
  const picture = { type: "image_url", image_url: { url: `data:image/png;base64,${png}`, detail: "auto" } };
  expect(result.result).toEqual([{ type: "text", text: "ab" }, picture, { type: "text", text: "cde\n... (truncated)" }, picture]);
  expect(storeImage).not.toHaveBeenCalled(); expect(persistText).not.toHaveBeenCalled();
});

it("keeps image blocks after an exact text boundary and applies the budget idempotently", () => {
  const picture = { type: "image_url", image_url: { url: `data:image/png;base64,${png}`, detail: "auto" } };
  const original = [{ type: "text", text: "abcd" }, picture, { type: "text", text: "ef" }, picture];
  const limited = limitManagedToolResultText(original, 4);
  expect(limited).toEqual([{ type: "text", text: "abcd" }, picture, { type: "text", text: "\n... (truncated)" }, picture]);
  expect(limited[1]).toBe(picture); expect(limited[3]).toBe(picture);
  expect(limitManagedToolResultText(limited, 4)).toBe(limited);
  expect(limitManagedToolResultText(original, 0)).toBe(original);
  expect(limitManagedToolResultText(original, 6)).toBe(original);
  expect(original[2]).toEqual({ type: "text", text: "ef" });
});

it("an error result cannot authorize the legacy path traversal helper to read a file", async () => {
  vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", result: { content: [{ type: "text", text: "Read failed" }], isError: true } })));
  const read = vi.fn(async () => "private");
  await expect(withManagedExecution(scope(1), () => withManagedFileCall("parent", () => withAuthorizedReadPath("/private/file", read))))
    .rejects.toThrow("managed_tool_reported_error");
  expect(read).not.toHaveBeenCalled();
});

it("carries an actual HTTP Host image into the next model HTTP request without native image or text caches", async () => {
  vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
  const storeImage = vi.spyOn(artifacts, "storeToolImageArtifact").mockImplementation(() => { throw new Error("native image write forbidden"); });
  const persistText = vi.spyOn(helpers, "maybePersistToolResult").mockImplementation(() => { throw new Error("native text write forbidden"); });
  const requests: any[] = [], authorizations: any[] = [];
  const workspace = await mkdtemp(join(tmpdir(), "memmy-managed-result-"));
  const server = createServer(async (req, res) => {
    let text = ""; for await (const part of req) text += part;
    const body = JSON.parse(text); res.setHeader("content-type", "application/json");
    if (req.url === "/authorize") {
      authorizations.push({ body, token: req.headers.authorization });
      res.end(JSON.stringify({ decision: "allow", result: image() })); return;
    }
    requests.push(body);
    res.end(JSON.stringify({ id: "chat", object: "chat.completion", created: 1, model: "gpt-4o",
      choices: [{ index: 0, message: requests.length === 1 ? { role: "assistant", content: "", tool_calls: [
        { id: "snapshot", type: "function", function: { name: "computer_use_snapshot", arguments: "{}" } },
      ] } : { role: "assistant", content: "Observed the supplied image" }, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const managed = createManagedExecutionScope({ ...credential, url: `${base}/authorize`, toolResultProtocol: 1 }, new AbortController().signal);
    const events: any[] = []; managed.onEvent = event => events.push(event);
    const provider = new OpenAICompatProvider({ apiKey: "model-test", apiBase: `${base}/v1`, defaultModel: "gpt-4o" });
    const result = await withManagedExecution(managed, () => new AgentRunner(provider).run(new AgentRunSpec({
      tools: new ToolRegistry(), workspace, maxIterations: 3, maxToolResultChars: 4,
      initialMessages: [{ role: "user", content: "Inspect this window" }], model: "gpt-4o",
    })));
    expect(result.finalContent).toBe("Observed the supplied image"); expect(requests).toHaveLength(2);
    expect(authorizations[0]).toMatchObject({ body: { toolName: "computer_use_snapshot", toolResultProtocol: 1 }, token: `Bearer ${credential.token}` });
    const imageBlocks = requests[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((block: any) => block.type === "image_url");
    expect(imageBlocks).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${png}`, detail: "auto" } }]);
    expect(requests[1].messages.filter((message: any) => message.role === "tool").map((message: any) => message.content).join()).not.toContain(png);
    expect(JSON.stringify(requests)).not.toContain(credential.token); expect(JSON.stringify(events)).not.toContain(png);
    // The existing Responses converter must also retain an image input, not JSON/base64 text.
    const [, responses] = convertMessages(result.messages);
    expect(responses.find(item => item.type === "function_call_output")?.output).toContainEqual({ type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "auto" });
    expect(storeImage).not.toHaveBeenCalled(); expect(persistText).not.toHaveBeenCalled(); expect(await readdir(workspace)).toEqual([]);
    expect(managedToolResultSummary(result.messages.find(message => message.role === "tool")?.content)).not.toContain(png);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(workspace, { recursive: true, force: true });
  }
});
