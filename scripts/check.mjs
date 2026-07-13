import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEditFields,
  buildEditTaskPayload,
  buildGenerationPayload,
  extractImageUrls,
  stringifyJsonForRequest,
} from "../src/apinebula.js";
import { applyPreset, getPresetSummary } from "../src/models.js";
import {
  DEFAULT_SYNC_EDIT_RESPONSE_FORMAT,
  compactJobForMemory,
  fileUrl,
  runWithConcurrency,
  startWebServer,
  summarizeBatch,
} from "../src/web-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const payload = buildGenerationPayload({
  model: "adobe-gpt-image-2",
  prompt: "test",
  size: "1024x1024",
  resolution: "1K",
  aspectRatio: "1:1",
  responseFormat: "b64_json",
});

assert(payload.model === "adobe-gpt-image-2", "payload model");
assert(payload.aspect_ratio === "1:1", "payload aspect_ratio");

const asciiJson = stringifyJsonForRequest({
  prompt: "古风人物",
  model: "adobe-gpt-image-2",
});
assert(asciiJson.includes("\\u53e4\\u98ce\\u4eba\\u7269"), "request json escapes non-ascii");
assert(!asciiJson.includes("古风人物"), "request json is ascii-safe");

const editFields = buildEditFields({
  model: "gpt-image-2",
  prompt: "edit",
  size: "1024x1536",
  quality: "high",
  responseFormat: "b64_json",
  inputFidelity: "high",
});
assert(editFields.input_fidelity === "high", "edit fields input_fidelity");
assert(editFields.response_format === "b64_json", "edit fields response_format");
assert(DEFAULT_SYNC_EDIT_RESPONSE_FORMAT === "url", "sync edit defaults to url response format");

const editTaskPayload = buildEditTaskPayload({
  model: "gpt-image-2",
  prompt: "edit async",
  imageUrls: ["https://example.com/input.png"],
  quality: "high",
});
assert(editTaskPayload.images[0].image_url === "https://example.com/input.png", "async edit image url");

const compactedJob = compactJobForMemory({
  configOverrides: { apiKey: "secret" },
  remoteTask: { data: [{ b64_json: "x".repeat(100) }], detail: { data: [{ b64_json: "y".repeat(100) }] } },
});
assert(!compactedJob.configOverrides?.apiKey, "compact removes api key");
assert(compactedJob.remoteTask.data[0].b64_json === "[omitted]", "compact top-level b64");
assert(compactedJob.remoteTask.detail.data[0].b64_json === "[omitted]", "compact nested b64");

const compactedBatch = compactJobForMemory({
  batch: {
    items: [{ configOverrides: { apiKey: "child-secret" }, remoteTask: { b64_json: "large" } }],
  },
});
assert(!compactedBatch.batch.items[0].configOverrides?.apiKey, "compact removes child api key");
assert(compactedBatch.batch.items[0].remoteTask.b64_json === "[omitted]", "compact child b64");

const batchSummary = summarizeBatch([
  { status: "completed" },
  { status: "failed" },
  { status: "running" },
  { status: "queued" },
]);
assert(batchSummary.completed === 1, "batch completed summary");
assert(batchSummary.failed === 1, "batch failed summary");
assert(batchSummary.active === 1, "batch active summary");
assert(batchSummary.queued === 1, "batch queued summary");
assert(batchSummary.finished === 2, "batch finished summary");

let activeWorkers = 0;
let maxActiveWorkers = 0;
const processedItems = [];
await runWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
  activeWorkers += 1;
  maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
  await new Promise((resolve) => setTimeout(resolve, 5));
  processedItems.push(item);
  activeWorkers -= 1;
});
assert(maxActiveWorkers === 2, "batch concurrency limit");
assert(processedItems.sort().join(",") === "0,1,2,3,4", "batch processes every item");

const urls = extractImageUrls({
  detail: {
    data: [{ download_url: "https://example.com/a.png" }, { url: "https://example.com/b.png" }],
  },
});

assert(urls.length === 2, "extract urls");
assert(getPresetSummary().length === 3, "preset summary");
assert(getPresetSummary().find((preset) => preset.name === "image2")?.group === "image-2-1k", "image2 token group");

process.env.NEBULA_CANVAS_BANANA_MODEL = "adobe-nano-banana-2";
assert(applyPreset("banana", { prompt: "x" }).model === "adobe-nano-banana-2", "env model");
assert(applyPreset("banana", { model: "adobe-nano-banana", prompt: "x" }).model === "adobe-nano-banana", "cli model override");
delete process.env.NEBULA_CANVAS_BANANA_MODEL;

const skill = "nebula-canvas";
const file = path.join(root, "skills", skill, "SKILL.md");
const content = fs.readFileSync(file, "utf8");
assert(content.startsWith("---\n"), `${skill} frontmatter`);
assert(content.includes(`name: ${skill}`), `${skill} name`);
assert(content.includes("description:"), `${skill} description`);

const tempOutputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nebula-canvas-check-"));
const nestedOutputDir = path.join(tempOutputDir, "nested");
const tempImage = path.join(nestedOutputDir, "check.png");
await fs.promises.mkdir(nestedOutputDir);
await fs.promises.writeFile(tempImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const customFileUrl = fileUrl(tempImage, tempOutputDir);
assert(/^\/api\/files\/[0-9a-f-]+\/nested\/check\.png$/.test(customFileUrl), "custom output file url");

const mockApi = await startMockApi();
const previousEnv = {
  apiKey: process.env.APINEBULA_API_KEY,
  baseUrl: process.env.APINEBULA_BASE_URL,
  pollInterval: process.env.NEBULA_CANVAS_POLL_INTERVAL_MS,
  timeout: process.env.NEBULA_CANVAS_TIMEOUT_MS,
};
process.env.APINEBULA_API_KEY = "test-key";
process.env.APINEBULA_BASE_URL = mockApi.baseUrl;
process.env.NEBULA_CANVAS_POLL_INTERVAL_MS = "5";
process.env.NEBULA_CANVAS_TIMEOUT_MS = "2000";

const server = await startWebServer({ host: "127.0.0.1", port: 0 });
try {
  assert(server.port > 0, "dynamic web port");
  const baseUrl = `http://${server.host}:${server.port}`;
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert(healthResponse.ok, "web health endpoint");

  const customHealthResponse = await fetch(`${baseUrl}/api/health`, {
    headers: {
      "X-Nebula-Base-Url": mockApi.baseUrl,
      "X-Nebula-Api-Key": "web-test-key",
    },
  });
  const customHealth = await customHealthResponse.json();
  assert(customHealth.baseUrl === mockApi.baseUrl, "web base url override");
  assert(customHealth.apiKeyConfigured, "web api key override");
  assert(customHealth.usingCustomBaseUrl, "custom base url marker");
  assert(customHealth.usingCustomApiKey, "custom api key marker");

  const invalidBaseUrlResponse = await fetch(`${baseUrl}/api/health`, {
    headers: { "X-Nebula-Base-Url": "file:///tmp/invalid" },
  });
  assert(invalidBaseUrlResponse.status === 400, "invalid web base url status");

  const iconResponse = await fetch(`${baseUrl}/vendor/lucide.js`);
  assert(iconResponse.ok, "local icon bundle");
  assert(iconResponse.headers.get("content-type")?.startsWith("text/javascript"), "icon bundle content type");

  const customFileResponse = await fetch(`${baseUrl}${customFileUrl}`);
  assert(customFileResponse.ok, "custom output file route");
  assert((await customFileResponse.arrayBuffer()).byteLength === 4, "custom output file content");

  const invalidJsonResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert(invalidJsonResponse.status === 400, "invalid json status");
  assert((await invalidJsonResponse.json()).error.code === "invalid_json", "invalid json error code");

  const invalidBatchResponse = await fetch(`${baseUrl}/api/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset: "image2", prompt: "test", count: 13, concurrency: 2 }),
  });
  assert(invalidBatchResponse.status === 400, "batch count limit status");

  const invalidConcurrencyResponse = await fetch(`${baseUrl}/api/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset: "image2", prompt: "test", count: 2, concurrency: 4 }),
  });
  assert(invalidConcurrencyResponse.status === 400, "batch concurrency limit status");

  const batchOutputDir = path.join(tempOutputDir, "batch-output");
  const batchResponse = await fetch(`${baseUrl}/api/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Nebula-Base-Url": mockApi.baseUrl,
      "X-Nebula-Api-Key": "web-test-key",
    },
    body: JSON.stringify({
      preset: "image2",
      prompt: "batch integration test",
      count: 3,
      concurrency: 2,
      outputDir: batchOutputDir,
    }),
  });
  assert(batchResponse.status === 202, "batch accepted");
  const acceptedBatch = await batchResponse.json();
  assert(!JSON.stringify(acceptedBatch).includes("web-test-key"), "batch response omits web api key");
  assert(!acceptedBatch.request?.baseUrl, "batch response omits web base url config");
  assert(!acceptedBatch.configOverrides, "batch response omits connection overrides");
  const completedBatch = await waitForJob(baseUrl, acceptedBatch.id);
  assert(completedBatch.status === "completed", "batch completed");
  assert(completedBatch.batch.summary.completed === 3, "batch completed item count");
  assert(completedBatch.batch.summary.failed === 0, "batch failed item count");
  assert(mockApi.maxActive === 2, "batch integration concurrency");
  assert(completedBatch.artifacts.downloadedFiles.length === 3, "batch downloaded file count");
  assert(completedBatch.artifacts.downloadedFiles.every((file) => /^00[1-3]\.png$/.test(path.basename(file.path))), "batch numbered files");
  assert(fs.existsSync(completedBatch.batch.manifestPath), "batch manifest exists");
  const manifest = JSON.parse(await fs.promises.readFile(completedBatch.batch.manifestPath, "utf8"));
  assert(manifest.batch.items.length === 3, "batch manifest item count");
  assert(!JSON.stringify(manifest).includes("test-key"), "batch manifest omits env api key");
  assert(!JSON.stringify(manifest).includes("web-test-key"), "batch manifest omits web api key");
  assert(!manifest.request?.baseUrl, "batch manifest omits web base url config");
  assert(!manifest.configOverrides, "batch manifest omits connection overrides");

  const missingRouteResponse = await fetch(`${baseUrl}/api/missing`);
  assert(missingRouteResponse.status === 404, "missing api route status");
} finally {
  await server.close();
  await mockApi.close();
  restoreEnv("APINEBULA_API_KEY", previousEnv.apiKey);
  restoreEnv("APINEBULA_BASE_URL", previousEnv.baseUrl);
  restoreEnv("NEBULA_CANVAS_POLL_INTERVAL_MS", previousEnv.pollInterval);
  restoreEnv("NEBULA_CANVAS_TIMEOUT_MS", previousEnv.timeout);
  await fs.promises.rm(tempOutputDir, { recursive: true, force: true });
}

console.log("NebulaCanvas checks passed.");

function assert(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

async function startMockApi() {
  const polls = new Map();
  let nextTask = 0;
  let active = 0;
  let maxActive = 0;
  let baseUrl;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, baseUrl);
    if (request.method === "POST" && url.pathname === "/v1/image-tasks/generations") {
      for await (const _chunk of request) {
        // Consume the request before responding.
      }
      const taskId = `mock-${++nextTask}`;
      polls.set(taskId, 0);
      active += 1;
      maxActive = Math.max(maxActive, active);
      respondJson(response, 200, { task_id: taskId, status: "queued" });
      return;
    }
    const taskMatch = url.pathname.match(/^\/v1\/image-tasks\/(mock-\d+)$/);
    if (request.method === "GET" && taskMatch) {
      const taskId = taskMatch[1];
      const pollCount = (polls.get(taskId) || 0) + 1;
      polls.set(taskId, pollCount);
      if (pollCount < 2) {
        respondJson(response, 200, { task_id: taskId, status: "processing" });
      } else {
        active -= 1;
        respondJson(response, 200, {
          task_id: taskId,
          status: "completed",
          detail: { data: [{ url: `${baseUrl}/images/${taskId}.png` }] },
        });
      }
      return;
    }
    if (request.method === "GET" && /^\/images\/mock-\d+\.png$/.test(url.pathname)) {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      response.end(png);
      return;
    }
    respondJson(response, 404, { error: { message: "Mock route not found." } });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    get maxActive() {
      return maxActive;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function waitForJob(baseUrl, jobId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, { signal: AbortSignal.timeout(1000) });
    const job = await response.json();
    if (["completed", "partial", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for local batch ${jobId}.`);
}

function respondJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  response.end(body);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
