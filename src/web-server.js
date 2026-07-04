import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { APINebulaClient, buildGenerationPayload, saveTaskArtifacts } from "./apinebula.js";
import { getConfig } from "./config.js";
import { applyPreset, getPresetSummary } from "./models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const jobs = new Map();

export async function startWebServer({ host = "127.0.0.1", port = 8787 } = {}) {
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      writeJson(response, 500, {
        error: {
          message: error?.message || String(error),
        },
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    host,
    port,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handleRequest(request, response) {
  setCommonHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, "http://localhost");

  if (url.pathname === "/api/health" && request.method === "GET") {
    const config = getConfig();
    writeJson(response, 200, {
      ok: true,
      apiKeyConfigured: Boolean(config.apiKey),
      baseUrl: config.baseUrl,
      outputDir: config.outputDir,
      presets: getPresetSummary(),
    });
    return;
  }

  if (url.pathname === "/api/presets" && request.method === "GET") {
    writeJson(response, 200, { presets: getPresetSummary() });
    return;
  }

  if (url.pathname === "/api/jobs" && request.method === "GET") {
    writeJson(response, 200, {
      jobs: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob),
    });
    return;
  }

  if (url.pathname === "/api/jobs" && request.method === "POST") {
    const body = await readJsonBody(request);
    const job = createGenerationJob(body);
    writeJson(response, 202, publicJob(job));
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && request.method === "GET") {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      writeJson(response, 404, { error: { message: "Job not found." } });
      return;
    }
    writeJson(response, 200, publicJob(job));
    return;
  }

  if (url.pathname.startsWith("/api/files/") && request.method === "GET") {
    await serveOutputFile(response, decodeURIComponent(url.pathname.slice("/api/files/".length)));
    return;
  }

  await serveStatic(response, url.pathname);
}

function createGenerationJob(body) {
  if (!body || typeof body !== "object") throw new Error("JSON body is required.");
  if (!body.prompt || typeof body.prompt !== "string") throw new Error("prompt is required.");
  if (!body.preset && !body.model) throw new Error("preset or model is required.");

  const id = randomUUID();
  const job = {
    id,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    request: sanitizeRequest(body),
    payload: null,
    taskId: null,
    remoteTask: null,
    artifacts: null,
    error: null,
  };
  jobs.set(id, job);
  runGenerationJob(job);
  return job;
}

async function runGenerationJob(job) {
  try {
    const config = getConfig({ outputDir: job.request.outputDir });
    const payload = buildGenerationPayload(
      applyPreset(job.request.preset, {
        model: job.request.model,
        prompt: job.request.prompt,
        size: job.request.size,
        resolution: job.request.resolution,
        aspectRatio: job.request.aspectRatio,
        quality: job.request.quality,
        responseFormat: job.request.responseFormat || "b64_json",
      }),
    );

    job.payload = payload;
    job.status = "submitting";
    job.updatedAt = new Date().toISOString();

    const client = new APINebulaClient(config);
    const task = await client.createImageGenerationTask(payload);
    const taskId = task.task_id || task.id;
    if (!taskId) throw new Error(`APINebula did not return a task id: ${JSON.stringify(task)}`);

    job.taskId = taskId;
    job.remoteTask = task;
    job.status = task.status || "queued";
    job.updatedAt = new Date().toISOString();

    const started = Date.now();
    while (!terminalStatuses.has(job.status)) {
      if (Date.now() - started > config.timeoutMs) {
        throw new Error(`Timed out waiting for image task ${taskId}.`);
      }
      await sleep(config.pollIntervalMs);
      const remoteTask = await client.getImageTask(taskId, { detail: true });
      job.remoteTask = remoteTask;
      job.status = remoteTask.status || job.status;
      job.updatedAt = new Date().toISOString();
    }

    if (job.status === "completed") {
      const artifacts = await saveTaskArtifacts({
        taskId,
        model: payload.model,
        finalTask: job.remoteTask,
        outputDir: config.outputDir,
        download: !job.request.noDownload,
      });
      job.artifacts = publicArtifacts(artifacts, config.outputDir);
    } else {
      job.error = job.remoteTask?.error || { message: `Task ended with status ${job.status}.` };
    }

    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
  } catch (error) {
    job.status = "failed";
    job.error = { message: error?.message || String(error) };
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
  }
}

function sanitizeRequest(body) {
  return {
    preset: cleanString(body.preset),
    model: cleanString(body.model),
    prompt: cleanString(body.prompt),
    size: cleanString(body.size),
    resolution: cleanString(body.resolution),
    aspectRatio: cleanString(body.aspectRatio),
    quality: cleanString(body.quality),
    responseFormat: cleanString(body.responseFormat),
    outputDir: cleanString(body.outputDir),
    noDownload: Boolean(body.noDownload),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    request: job.request,
    payload: job.payload,
    taskId: job.taskId,
    remoteTask: job.remoteTask,
    artifacts: job.artifacts,
    error: job.error,
  };
}

function publicArtifacts(artifacts, outputDir) {
  return {
    metadataPath: artifacts.metadataPath,
    imageUrls: artifacts.imageUrls,
    downloadedFiles: artifacts.downloadedFiles.map((filePath) => ({
      path: filePath,
      url: fileUrl(filePath, outputDir),
    })),
  };
}

function fileUrl(filePath, outputDir) {
  const relative = path.relative(path.resolve(outputDir), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return `/api/files/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
}

async function serveOutputFile(response, relativePath) {
  const config = getConfig();
  const outputDir = path.resolve(config.outputDir);
  const filePath = path.resolve(outputDir, relativePath);
  if (!filePath.startsWith(outputDir + path.sep)) {
    writeJson(response, 403, { error: { message: "File is outside output directory." } });
    return;
  }
  await serveFile(response, filePath);
}

async function serveStatic(response, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(publicDir, `.${cleanPath}`);
  if (!filePath.startsWith(publicDir + path.sep)) {
    writeJson(response, 403, { error: { message: "Static file is outside public directory." } });
    return;
  }
  await serveFile(response, filePath, true);
}

async function serveFile(response, filePath, fallbackToIndex = false) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    if (fallbackToIndex) {
      await serveFile(response, path.join(publicDir, "index.html"));
      return;
    }
    writeJson(response, 404, { error: { message: "File not found." } });
    return;
  }
  if (!stat.isFile()) {
    writeJson(response, 404, { error: { message: "File not found." } });
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": stat.size,
  });
  fs.createReadStream(filePath).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(data, null, 2)}\n`);
}

function setCommonHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream"
  );
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
