import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Busboy from "busboy";
import {
  APINebulaClient,
  buildEditFields,
  buildEditTaskPayload,
  buildGenerationPayload,
  saveImageResponseArtifacts,
  saveTaskArtifacts,
} from "./apinebula.js";
import { getConfig } from "./config.js";
import { applyPreset, getPresetSummary } from "./models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const jobs = new Map();
const maxJobs = 20;
export const DEFAULT_SYNC_EDIT_RESPONSE_FORMAT = "url";
const maxMultipartBytes = 32 * 1024 * 1024;

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

  if (url.pathname === "/api/edit-jobs" && request.method === "POST") {
    const contentType = request.headers["content-type"] || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await readMultipartForm(request, contentType);
      try {
        const job = createSyncEditJob(form);
        writeJson(response, 202, publicJob(job));
      } catch (error) {
        await cleanupMultipartFiles(form.uploadDir, form.files);
        throw error;
      }
      return;
    }

    const job = createAsyncEditJob(await readJsonBody(request));
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
  const job = createBaseJob(id, sanitizeRequest(body), {
    apiKey: cleanString(body.apiKey),
  });
  jobs.set(id, job);
  pruneJobs();
  runGenerationJob(job);
  return job;
}

function createSyncEditJob(form) {
  if (!form.fields.prompt) throw new Error("prompt is required.");
  if (!form.files.some((file) => file.fieldName === "image")) throw new Error("At least one image file is required.");

  const id = randomUUID();
  const request = sanitizeEditRequest({
    mode: "edit-sync",
    model: form.fields.model || "gpt-image-2",
    prompt: form.fields.prompt,
    size: form.fields.size || "1024x1024",
    quality: form.fields.quality || "high",
    responseFormat: form.fields.responseFormat || form.fields.response_format || DEFAULT_SYNC_EDIT_RESPONSE_FORMAT,
    inputFidelity: form.fields.inputFidelity || form.fields.input_fidelity || "high",
    outputDir: form.fields.outputDir,
    noDownload: form.fields.noDownload === "true",
  });
  request.imageFiles = form.files
    .filter((file) => file.fieldName === "image")
    .map((file) => ({ filename: file.filename, contentType: file.contentType, size: file.size }));

  const job = createBaseJob(id, request, {
    apiKey: cleanString(form.fields.apiKey),
  });
  jobs.set(id, job);
  pruneJobs();
  runSyncEditJob(job, form.files.filter((file) => file.fieldName === "image"));
  return job;
}

function createAsyncEditJob(body) {
  if (!body || typeof body !== "object") throw new Error("JSON body is required.");
  if (!body.prompt || typeof body.prompt !== "string") throw new Error("prompt is required.");
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.filter(Boolean) : [];
  if (!imageUrls.length) throw new Error("imageUrls is required for async edit.");

  const id = randomUUID();
  const request = sanitizeEditRequest({
    mode: "edit-async",
    model: body.model || "gpt-image-2",
    prompt: body.prompt,
    imageUrls,
    size: body.size,
    quality: body.quality || "high",
    responseFormat: body.responseFormat || "b64_json",
    outputDir: body.outputDir,
    noDownload: body.noDownload,
  });

  const job = createBaseJob(id, request, {
    apiKey: cleanString(body.apiKey),
  });
  jobs.set(id, job);
  pruneJobs();
  runAsyncEditJob(job);
  return job;
}

function createBaseJob(id, request, configOverrides = {}) {
  return {
    id,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    request,
    payload: null,
    taskId: null,
    remoteTask: null,
    artifacts: null,
    error: null,
    configOverrides,
  };
}

export function compactJobForMemory(job) {
  return {
    ...job,
    configOverrides: undefined,
    remoteTask: compactLargeResponse(job.remoteTask),
  };
}

async function runGenerationJob(job) {
  try {
    const config = getConfig({ outputDir: job.request.outputDir, apiKey: job.configOverrides?.apiKey });
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
      job.status = "saving";
      job.updatedAt = new Date().toISOString();
      const artifacts = await saveTaskArtifacts({
        taskId,
        model: payload.model,
        finalTask: job.remoteTask,
        outputDir: config.outputDir,
        download: !job.request.noDownload,
      });
      job.artifacts = publicArtifacts(artifacts, config.outputDir);
      job.status = "completed";
    } else {
      job.error = job.remoteTask?.error || { message: `Task ended with status ${job.status}.` };
    }

    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    compactStoredJob(job);
  } catch (error) {
    job.status = "failed";
    job.error = { message: error?.message || String(error) };
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    compactStoredJob(job);
  }
}

async function runSyncEditJob(job, imageFiles) {
  try {
    const config = getConfig({ outputDir: job.request.outputDir, apiKey: job.configOverrides?.apiKey });
    const fields = buildEditFields({
      model: job.request.model || "gpt-image-2",
      prompt: job.request.prompt,
      size: job.request.size,
      quality: job.request.quality,
      responseFormat: job.request.responseFormat || DEFAULT_SYNC_EDIT_RESPONSE_FORMAT,
      inputFidelity: job.request.inputFidelity || "high",
    });

    job.payload = { ...fields, image_count: imageFiles.length };
    job.status = "submitting";
    job.updatedAt = new Date().toISOString();

    const client = new APINebulaClient(config);
    const response = await client.editImages({
      fields,
      images: imageFiles.map((file) => ({
        path: file.path,
        filename: file.filename,
        contentType: file.contentType,
      })),
    });

    job.remoteTask = response;
    job.status = "saving";
    job.updatedAt = new Date().toISOString();
    const artifacts = await saveImageResponseArtifacts({
      response,
      model: fields.model,
      outputDir: config.outputDir,
      download: !job.request.noDownload,
    });
    job.artifacts = publicArtifacts(artifacts, config.outputDir);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    compactStoredJob(job);
  } catch (error) {
    job.status = "failed";
    job.error = { message: error?.message || String(error) };
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    compactStoredJob(job);
  } finally {
    await cleanupTempFiles(imageFiles);
  }
}

async function runAsyncEditJob(job) {
  try {
    const config = getConfig({ outputDir: job.request.outputDir, apiKey: job.configOverrides?.apiKey });
    const payload = buildEditTaskPayload({
      model: job.request.model || "gpt-image-2",
      prompt: job.request.prompt,
      imageUrls: job.request.imageUrls,
      size: job.request.size,
      quality: job.request.quality,
      responseFormat: job.request.responseFormat || "b64_json",
    });

    job.payload = payload;
    job.status = "submitting";
    job.updatedAt = new Date().toISOString();

    const client = new APINebulaClient(config);
    const task = await client.createImageEditTask(payload);
    const taskId = task.task_id || task.id;
    if (!taskId) throw new Error(`APINebula did not return a task id: ${JSON.stringify(task)}`);

    job.taskId = taskId;
    job.remoteTask = task;
    job.status = task.status || "queued";
    job.updatedAt = new Date().toISOString();

    const started = Date.now();
    while (!terminalStatuses.has(job.status)) {
      if (Date.now() - started > config.timeoutMs) {
        throw new Error(`Timed out waiting for image edit task ${taskId}.`);
      }
      await sleep(config.pollIntervalMs);
      const remoteTask = await client.getImageTask(taskId, { detail: true });
      job.remoteTask = remoteTask;
      job.status = remoteTask.status || job.status;
      job.updatedAt = new Date().toISOString();
    }

    if (job.status === "completed") {
      job.status = "saving";
      job.updatedAt = new Date().toISOString();
      const artifacts = await saveTaskArtifacts({
        taskId,
        model: payload.model,
        finalTask: job.remoteTask,
        outputDir: config.outputDir,
        download: !job.request.noDownload,
      });
      job.artifacts = publicArtifacts(artifacts, config.outputDir);
      job.status = "completed";
    } else {
      job.error = job.remoteTask?.error || { message: `Task ended with status ${job.status}.` };
    }

    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    compactStoredJob(job);
  } catch (error) {
    job.status = "failed";
    job.error = { message: error?.message || String(error) };
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    compactStoredJob(job);
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

function sanitizeEditRequest(body) {
  return {
    mode: cleanString(body.mode),
    model: cleanString(body.model),
    prompt: cleanString(body.prompt),
    imageUrls: Array.isArray(body.imageUrls) ? body.imageUrls.map(cleanString).filter(Boolean) : undefined,
    size: cleanString(body.size),
    quality: cleanString(body.quality),
    responseFormat: cleanString(body.responseFormat),
    inputFidelity: cleanString(body.inputFidelity),
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

function compactStoredJob(job) {
  const compacted = compactJobForMemory(job);
  Object.keys(job).forEach((key) => delete job[key]);
  Object.assign(job, compacted);
}

function compactLargeResponse(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(compactLargeResponse);

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "b64_json" && typeof item === "string") {
      result[key] = "[omitted]";
    } else {
      result[key] = compactLargeResponse(item);
    }
  }
  return result;
}

function pruneJobs() {
  const sorted = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const job of sorted.slice(maxJobs)) {
    jobs.delete(job.id);
  }
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
  const body = await readRequestBody(request, 1024 * 1024);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

async function readMultipartForm(request, contentType) {
  const uploadDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nebula-canvas-upload-"));
  const fields = {};
  const files = [];
  let totalFileBytes = 0;

  return new Promise((resolve, reject) => {
    const parser = Busboy({
      headers: { "content-type": contentType },
      limits: {
        files: 8,
        fileSize: maxMultipartBytes,
        fieldSize: 128 * 1024,
        fields: 32,
      },
    });

    const pendingWrites = [];
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.unpipe(parser);
      request.resume();
      cleanupMultipartFiles(uploadDir, files).finally(() => reject(error));
    };

    parser.on("field", (name, value) => {
      fields[name] = value;
    });

    parser.on("file", (fieldName, stream, info) => {
      const filename = path.basename(info.filename || "upload.bin");
      const tempPath = path.join(uploadDir, `${randomUUID()}-${filename}`);
      const file = {
        fieldName,
        filename,
        contentType: info.mimeType || "application/octet-stream",
        path: tempPath,
        size: 0,
      };
      files.push(file);

      stream.on("data", (chunk) => {
        file.size += chunk.length;
        totalFileBytes += chunk.length;
        if (totalFileBytes > maxMultipartBytes) {
          fail(new Error("Request body is too large."));
        }
      });
      stream.on("limit", () => fail(new Error("Uploaded file is too large.")));

      const write = new Promise((resolveWrite, rejectWrite) => {
        const output = fs.createWriteStream(tempPath);
        output.on("finish", resolveWrite);
        output.on("error", rejectWrite);
        stream.on("error", rejectWrite);
        stream.pipe(output);
      });
      pendingWrites.push(write);
    });

    parser.on("error", fail);
    parser.on("finish", async () => {
      if (settled) return;
      try {
        await Promise.all(pendingWrites);
        settled = true;
        resolve({ fields, files, uploadDir });
      } catch (error) {
        fail(error);
      }
    });

    request.pipe(parser);
  });
}

async function cleanupTempFiles(files) {
  const uploadDirs = new Set();
  await Promise.all(
    (files || [])
      .filter((file) => file?.path)
      .map(async (file) => {
        uploadDirs.add(path.dirname(file.path));
        try {
          await fsp.unlink(file.path);
        } catch {
          // Temporary upload may already have been removed.
        }
      }),
  );

  await Promise.all(
    [...uploadDirs].map(async (uploadDir) => {
      try {
        await fsp.rm(uploadDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }),
  );
}

async function cleanupMultipartFiles(uploadDir, files) {
  await cleanupTempFiles(files);
  try {
    await fsp.rm(uploadDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
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
