import fs from "node:fs";
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
import { compactJobForMemory, startWebServer } from "../src/web-server.js";

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

const urls = extractImageUrls({
  detail: {
    data: [{ download_url: "https://example.com/a.png" }, { url: "https://example.com/b.png" }],
  },
});

assert(urls.length === 2, "extract urls");
assert(getPresetSummary().length === 3, "preset summary");

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

const server = await startWebServer({ host: "127.0.0.1", port: 0 });
await server.close();

console.log("NebulaCanvas checks passed.");

function assert(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
}
