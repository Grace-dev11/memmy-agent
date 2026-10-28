// Test/build only: no release metadata, package publishing, desktop control or account credentials.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleRuntime } from "./bundle-runtime.mjs";

const source = fileURLToPath(new URL("../../../", import.meta.url));
// Git Bash's GNU tar interprets a Windows drive prefix as a remote host.
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
const output = path.resolve(process.argv[2] ?? await mkdtemp(path.join(tmpdir(), "memmy-protocol-build-")));
const runtime = path.join(output, "package"), packageDirectory = "App/memmy-agent";
assert.equal(process.platform, process.env.EXPECTED_PLATFORM ?? process.platform);
assert.equal(process.arch, process.env.EXPECTED_ARCH ?? process.arch);
assert.equal(process.versions.node.split(".")[0], "22", "verify with the supported Node 22 runtime");
await mkdir(output, { recursive: true });
const stats = await bundleRuntime({ source, destination: runtime, packageDirectory, kind: "agent", target: { platform: process.platform, arch: process.arch } });
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
console.log(JSON.stringify({ step: "bundle", sourceCommit, platform: process.platform, arch: process.arch, ...stats }));
// Preserve the bundler's exact dependency layout inside a directly installable
// package. The thin CLI entry does not resolve or download any dependencies.
const manifest = JSON.parse(await readFile(path.join(runtime, packageDirectory, "package.json"), "utf8"));
const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
await mkdir(path.join(runtime, "dist"), { recursive: true });
await writeFile(path.join(runtime, "dist/main.js"), 'import "../App/memmy-agent/dist/main.js";\n');
await writeFile(path.join(runtime, "package.json"), JSON.stringify({ name: "@memtensor/memmy-agent", version: manifest.version,
  private: true, type: "module", bin: { memmy: "dist/main.js" }, engines: { node: ">=22" } }, null, 2) + "\n");
await writeFile(path.join(runtime, "agent-runtime.json"), JSON.stringify({ name: "memmy-agent-runtime", version: manifest.version,
  formatVersion: 1, target, entrypoint: "dist/main.js", nodeAbi: process.versions.modules,
  sourceCommit, baseCommit: "167e199023ac59d245436d3cfb0dccbeb0651ace", testBuild: true, published: false,
  nodeVersion: process.version, managedToolResultProtocol: 1 }, null, 2) + "\n");
const archive = `memmy-managed-result-test-${sourceCommit.slice(0, 9)}-${target}.tgz`;
execFileSync(tar, ["-czf", path.join(output, archive), "-C", output, "package"], { stdio: "inherit" });
// Exercise the prebuilt file:.tgz install shape used by Desktop install:memmy:
// extract package/, validate descriptor, place it under the scoped package name.
const consumer = await mkdtemp(path.join(tmpdir(), "memmy-protocol-consumer-"));
execFileSync(tar, ["-xzf", path.join(output, archive), "-C", consumer], { stdio: "inherit" });
const installed = path.join(consumer, "node_modules/@memtensor/memmy-agent");
await mkdir(path.dirname(installed), { recursive: true });
await rename(path.join(consumer, "package"), installed);
const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
const descriptor = JSON.parse(await readFile(path.join(installed, "agent-runtime.json"), "utf8"));
assert.equal(installedManifest.name, "@memtensor/memmy-agent"); assert.equal(installedManifest.bin.memmy, "dist/main.js");
assert.equal(descriptor.name, "memmy-agent-runtime"); assert.equal(descriptor.formatVersion, 1);
assert.equal(descriptor.version, installedManifest.version); assert.equal(descriptor.target, target);
assert.equal(descriptor.entrypoint, "dist/main.js"); assert.equal(descriptor.nodeAbi, process.versions.modules);

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIioAAAAASUVORK5CYII=";
const tool = { name: "product_snapshot_fixture", description: "Return the registered product test snapshot", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
const requests = [], authorizations = [], errors = [];
let mode = "image", calls = 0;
const model = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (req.url === "/authorize") {
      authorizations.push({ body, authorization: req.headers.authorization, mode });
      const result = mode === "image" ? { content: [{ type: "text", text: "PRODUCT_IMAGE_RESULT" }, { type: "image", mimeType: "image/png", data: png }], isError: false } : "LEGACY_STRING_RESULT";
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ decision: "allow", result })); return;
    }
    const workflow = (body.tools ?? []).some(item => item.function?.name === tool.name);
    if (workflow) { requests.push({ mode, body }); calls++; }
    const invoke = workflow && calls === 1;
    const delta = invoke ? { tool_calls: [{ index: 0, id: `snapshot-${mode}`, type: "function", function: { name: tool.name, arguments: "{}" } }] } : { content: workflow ? `Finished ${mode} round trip` : "fixture" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "model", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: invoke ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(); }
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${model.address().port}`;
const home = await mkdtemp(path.join(tmpdir(), "memmy-protocol-home-")), workspace = path.join(home, "workspace");
await mkdir(workspace);
const preset = "protocol-test", modelId = "gpt-4o", config = path.join(home, "config.json");
await writeFile(config, JSON.stringify({
  agents: { defaults: { workspace, provider: "openai", model: modelId, modelPreset: preset } },
  providers: { openai: { apiKey: "model-test", endpoints: { chat: { apiBase: `${base}/v1`, protocol: "openai-chat-completions" } } } },
  modelPresets: { [preset]: { provider: "openai", endpoint: "chat", model: modelId, source: "byok", capabilities: ["agent"] } },
  modelAssignments: { byok: { agent: { candidates: [preset], default: preset } }, account: { agent: { candidates: [], default: null } } },
  app: { modelCatalogVersion: 1 }, tools: { mcpServers: {} }, memmyMemory: { enabled: false },
}));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const token = "b".repeat(64), approvalToken = "a".repeat(64);
let stderr = "", exited = false;
const child = spawn(process.execPath, [path.join(installed, descriptor.entrypoint), "serve", "--host", "127.0.0.1", "--port", String(port), "--config", config, "--workspace", workspace], {
  cwd: home, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, OPENAI_API_KEY: "model-test", MEMMY_AGENT_DATA_DIR: path.join(home, "data"),
    AGENT_MANAGED_EXECUTION_REQUIRED: "1", AGENT_RUNTIME_TOKEN: token, MEMMY_COMPUTER_HISTORY: "0",
    ...Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP"].filter(key => process.env[key]).map(key => [key, process.env[key]])),
  },
});
child.stdout.on("data", () => {}); child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-20000); });
child.once("exit", () => { exited = true; });
try {
  let health;
  for (let attempt = 0; attempt < 240; attempt++) {
    if (exited) throw Error(`Bundled runtime exited: ${stderr}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { health = await response.json(); break; } } catch { /* Wait for this owned runtime to start. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(health?.managedToolResultProtocol, 1, JSON.stringify({ health, stderr }));
  assert.equal(health.managedExecutionProtocol, 2); assert.equal(health.managedExecutionRequired, true);
  for (mode of ["image", "legacy"]) {
    calls = 0;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(60_000), headers: { "content-type": "application/json", "x-agent-runtime-token": token },
      body: JSON.stringify({ stream: true, session_id: `test-${mode}`, messages: [{ role: "user", content: "Use the registered product snapshot." }],
        managed_execution: { protocol: 2, ...(mode === "image" ? { toolResultProtocol: 1 } : {}), tools: [tool], url: `${base}/authorize`, token: approvalToken } }),
    });
    const events = await response.text(); assert.equal(response.status, 200, events);
    assert.ok(events.includes(`Finished ${mode} round trip`), JSON.stringify({ events, stderr }));
    assert.ok(!events.includes(png), "events must only contain a bounded image summary");
    const round = requests.filter(request => request.mode === mode); assert.equal(round.length, 2);
    const blocks = round[1].body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "image_url");
    assert.deepEqual(blocks, mode === "image" ? [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}`, detail: "auto" } }] : []);
    const toolMessages = round[1].body.messages.filter(message => message.role === "tool");
    assert.ok(JSON.stringify(toolMessages).includes(mode === "image" ? "PRODUCT_IMAGE_RESULT" : "LEGACY_STRING_RESULT"));
    assert.ok(!JSON.stringify(toolMessages).includes(png), "image must not become base64 text");
    assert.ok(!JSON.stringify(round).includes(approvalToken), "Host token must not reach the model");
    const authorization = authorizations.filter(request => request.mode === mode); assert.equal(authorization.length, 1);
    assert.equal(authorization[0].authorization, `Bearer ${approvalToken}`); assert.equal(authorization[0].body.toolName, tool.name);
    assert.equal(authorization[0].body.toolResultProtocol, mode === "image" ? 1 : undefined);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ step: "runtime-verification", platform: process.platform, arch: process.arch, installedPackage: installedManifest.name,
    sourceCommit: descriptor.sourceCommit, health, imageRoundTrip: true, legacyStringRoundTrip: true }));
} finally {
  child.kill();
  for (let attempt = 0; attempt < 40 && !exited; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  if (!exited) child.kill("SIGKILL");
  child.stdout.destroy(); child.stderr.destroy();
  await new Promise(resolve => { model.closeAllConnections(); model.close(resolve); });
  await rm(home, { recursive: true, force: true, maxRetries: 5 });
  await rm(consumer, { recursive: true, force: true, maxRetries: 5 });
}
const digest = createHash("sha256").update(await readFile(path.join(output, archive))).digest("hex");
await writeFile(path.join(output, `${archive}.sha256`), `${digest}  ${archive}\n`);
console.log(JSON.stringify({ step: "test-artifact", archive, sha256: digest }));
