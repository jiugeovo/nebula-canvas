import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
dotenv.config({ quiet: true });

export function getConfig(overrides = {}) {
  const baseUrl = normalizeBaseUrl(
    overrides.baseUrl || process.env.APINEBULA_BASE_URL || "https://apinebula.com",
  );
  const apiKey = overrides.apiKey || process.env.APINEBULA_API_KEY || "";
  const outputDir = path.resolve(
    overrides.outputDir ||
      process.env.NEBULA_CANVAS_OUTPUT_DIR ||
      process.env.TIANWEN_OUTPUT_DIR ||
      path.join(projectRoot, "outputs"),
  );
  const pollIntervalMs = numberFrom(
    overrides.pollIntervalMs,
    process.env.NEBULA_CANVAS_POLL_INTERVAL_MS || process.env.TIANWEN_POLL_INTERVAL_MS,
    5000,
  );
  const timeoutMs = numberFrom(
    overrides.timeoutMs,
    process.env.NEBULA_CANVAS_TIMEOUT_MS || process.env.TIANWEN_TIMEOUT_MS,
    600000,
  );

  return {
    apiKey,
    baseUrl,
    outputDir,
    pollIntervalMs,
    timeoutMs,
  };
}

export function ensureApiKey(config) {
  if (!config.apiKey) {
    throw new Error("Missing APINEBULA_API_KEY. Set it in the environment or a local .env file.");
  }
}

export async function ensureOutputDir(outputDir) {
  await fs.promises.mkdir(outputDir, { recursive: true });
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, "");
}

function numberFrom(value, envValue, fallback) {
  const raw = value ?? envValue;
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
