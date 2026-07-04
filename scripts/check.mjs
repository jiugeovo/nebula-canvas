import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGenerationPayload, extractImageUrls } from "../src/apinebula.js";
import { applyPreset, getPresetSummary } from "../src/models.js";
import { startWebServer } from "../src/web-server.js";

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
