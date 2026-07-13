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
const lucideBundlePath = path.join(projectRoot, "node_modules", "lucide", "dist", "umd", "lucide.min.js");
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const jobs = new Map();
const outputRoots = new Map();
const maxJobs = 20;
const maxOutputRoots = 64;
const maxBatchSize = 12;
const maxBatchConcurrency = 4;
export const DEFAULT_SYNC_EDIT_RESPONSE_FORMAT = "url";
const maxMultipartBytes = 32 * 1024 * 1024;

export async function startWebServer({ host = "127.0.0.1", port = 8787 } = {}) {
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const statusCode = httpStatusForError(error);
      writeJson(response, statusCode, {
        error: {
          message: error?.message || String(error),
          code: error?.code,
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

  const address = server.address();
  return {
    host,
    port: typeof address === "object" && address ? address.port : port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }),
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
    const overrides = connectionOverridesFromHeaders(request);
    const config = getConfig(overrides);
    writeJson(response, 200, {
      ok: true,
      apiKeyConfigured: Boolean(config.apiKey),
      baseUrl: config.baseUrl,
      usingCustomBaseUrl: Boolean(overrides.baseUrl),
      usingCustomApiKey: Boolean(overrides.apiKey),
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
    const body = withConnectionOverrides(await readJsonBody(request), request);
    const job = createGenerationJob(body);
    writeJson(response, 202, publicJob(job));
    return;
  }

  if (url.pathname === "/api/batches" && request.method === "POST") {
    const body = withConnectionOverrides(await readJsonBody(request), request);
    const job = createBatchGenerationJob(body);
    writeJson(response, 202, publicJob(job));
    return;
  }

  if (url.pathname === "/api/edit-jobs" && request.method === "POST") {
    const contentType = request.headers["content-type"] || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await readMultipartForm(request, contentType);
      form.fields = withConnectionOverrides(form.fields, request);
      try {
        const job = createSyncEditJob(form);
        writeJson(response, 202, publicJob(job));
      } catch (error) {
        await cleanupMultipartFiles(form.uploadDir, form.files);
        throw error;
      }
      return;
    }

    const job = createAsyncEditJob(withConnectionOverrides(await readJsonBody(request), request));
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

  if (url.pathname === "/vendor/lucide.js" && request.method === "GET") {
    await serveFile(response, lucideBundlePath);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    writeJson(response, 404, { error: { message: "API route not found.", code: "route_not_found" } });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    writeJson(response, 405, { error: { message: "Method not allowed.", code: "method_not_allowed" } });
    return;
  }

  await serveStatic(response, url.pathname);
}

function createGenerationJob(body) {
  validateGenerationRequest(body);

  const id = randomUUID();
  const job = createBaseJob(id, sanitizeRequest(body), {
    apiKey: cleanString(body.apiKey),
    baseUrl: validatedBaseUrl(body.baseUrl),
  });
  jobs.set(id, job);
  pruneJobs();
  runGenerationJob(job);
  return job;
}

function createBatchGenerationJob(body) {
  validateGenerationRequest(body);
  const count = integerInRange(body.count, 2, maxBatchSize, "count");
  const concurrency = integerInRange(body.concurrency ?? 2, 1, Math.min(maxBatchConcurrency, count), "concurrency");
  const id = randomUUID();
  const request = sanitizeRequest({ ...body, count, concurrency });
  const job = createBaseJob(id, request, {
    apiKey: cleanString(body.apiKey),
    baseUrl: validatedBaseUrl(body.baseUrl),
  });
  job.kind = "batch";
  job.batch = {
    count,
    concurrency,
    outputDir: null,
    manifestPath: null,
    items: Array.from({ length: count }, (_, index) =>
      createBaseJob(randomUUID(), {
        ...request,
        count: undefined,
        concurrency: undefined,
        batchId: id,
        batchIndex: index + 1,
      }),
    ),
  };
  jobs.set(id, job);
  pruneJobs();
  runBatchGenerationJob(job);
  return job;
}

function validateGenerationRequest(body) {
  if (!body || typeof body !== "object") throw requestError("JSON body is required.");
  if (!body.prompt || typeof body.prompt !== "string") throw requestError("prompt is required.");
  if (!body.preset && !body.model) throw requestError("preset or model is required.");
}

function createSyncEditJob(form) {
  if (!form.fields.prompt) throw requestError("prompt is required.");
  if (!form.files.some((file) => file.fieldName === "image")) throw requestError("At least one image file is required.");

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
    baseUrl: validatedBaseUrl(form.fields.baseUrl),
  });
  jobs.set(id, job);
  pruneJobs();
  runSyncEditJob(job, form.files.filter((file) => file.fieldName === "image"));
  return job;
}

function createAsyncEditJob(body) {
  if (!body || typeof body !== "object") throw requestError("JSON body is required.");
  if (!body.prompt || typeof body.prompt !== "string") throw requestError("prompt is required.");
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.filter(Boolean) : [];
  if (!imageUrls.length) throw requestError("imageUrls is required for async edit.");

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
    baseUrl: validatedBaseUrl(body.baseUrl),
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
    batch: job.batch
      ? {
          ...job.batch,
          items: job.batch.items.map((item) => compactJobForMemory(item)),
        }
      : undefined,
  };
}

async function runGenerationJob(job, options = {}) {
  try {
    const config = options.config || getConfig({
      outputDir: job.request.outputDir,
      apiKey: job.configOverrides?.apiKey,
      baseUrl: job.configOverrides?.baseUrl,
    });
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
    await options.onUpdate?.(job);

    const client = new APINebulaClient(config);
    const task = await client.createImageGenerationTask(payload);
    const taskId = task.task_id || task.id;
    if (!taskId) throw new Error(`APINebula did not return a task id: ${JSON.stringify(task)}`);

    job.taskId = taskId;
    job.remoteTask = task;
    job.status = task.status || "queued";
    job.updatedAt = new Date().toISOString();
    await options.onUpdate?.(job);

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
      await options.onUpdate?.(job);
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
        fileStem: options.fileStem,
      });
      job.artifacts = publicArtifacts(artifacts, config.outputDir);
      job.status = "completed";
    } else {
      job.error = job.remoteTask?.error || { message: `Task ended with status ${job.status}.` };
    }

    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    compactStoredJob(job);
    await options.onUpdate?.(job);
  } catch (error) {
    job.status = "failed";
    job.error = { message: error?.message || String(error) };
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    compactStoredJob(job);
    await options.onUpdate?.(job);
  }
}

async function runBatchGenerationJob(job) {
  let persist = async () => {};
  try {
    const config = getConfig({
      outputDir: job.request.outputDir,
      apiKey: job.configOverrides?.apiKey,
      baseUrl: job.configOverrides?.baseUrl,
    });
    const batchDirectory = path.join(config.outputDir, "batches", batchDirectoryName(job));
    const manifestPath = path.join(batchDirectory, "manifest.json");
    const batchConfig = { ...config, outputDir: batchDirectory };
    let manifestWrites = Promise.resolve();

    job.batch.outputDir = batchDirectory;
    job.batch.manifestPath = manifestPath;
    job.artifacts = { manifestPath, metadataPath: manifestPath, imageUrls: [], downloadedFiles: [] };
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    await fsp.mkdir(batchDirectory, { recursive: true });

    persist = () => {
      syncBatchArtifacts(job);
      job.updatedAt = new Date().toISOString();
      manifestWrites = manifestWrites.then(() => writeBatchManifest(job));
      return manifestWrites;
    };
    await persist();

    await runWithConcurrency(job.batch.items, job.batch.concurrency, async (item, index) => {
      await runGenerationJob(item, {
        config: batchConfig,
        fileStem: String(index + 1).padStart(3, "0"),
        onUpdate: persist,
      });
    });

    await manifestWrites;
    const summary = summarizeBatch(job.batch.items);
    job.status = summary.failed === summary.total ? "failed" : summary.failed > 0 ? "partial" : "completed";
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    syncBatchArtifacts(job);
    compactStoredJob(job);
    await writeBatchManifest(job);
  } catch (error) {
    job.status = "failed";
    job.error = { message: error?.message || String(error) };
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    for (const item of job.batch?.items || []) {
      if (item.status !== "queued") continue;
      item.status = "cancelled";
      item.error = { message: "Batch stopped before this item could start." };
      item.completedAt = job.completedAt;
      item.updatedAt = job.completedAt;
    }
    syncBatchArtifacts(job);
    compactStoredJob(job);
    if (job.batch?.manifestPath) {
      try {
        await persist();
        await writeBatchManifest(job);
      } catch {
        // Preserve the original batch error when the manifest also cannot be written.
      }
    }
  }
}

async function runSyncEditJob(job, imageFiles) {
  try {
    const config = getConfig({
      outputDir: job.request.outputDir,
      apiKey: job.configOverrides?.apiKey,
      baseUrl: job.configOverrides?.baseUrl,
    });
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
    const config = getConfig({
      outputDir: job.request.outputDir,
      apiKey: job.configOverrides?.apiKey,
      baseUrl: job.configOverrides?.baseUrl,
    });
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
    count: optionalInteger(body.count),
    concurrency: optionalInteger(body.concurrency),
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
    kind: job.kind || "job",
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    request: job.request,
    payload: job.payload,
    taskId: job.taskId,
    remoteTask: job.remoteTask,
    artifacts: job.artifacts,
    batch: job.batch ? publicBatch(job.batch) : undefined,
    error: job.error,
  };
}

function publicBatch(batch) {
  return {
    count: batch.count,
    concurrency: batch.concurrency,
    outputDir: batch.outputDir,
    manifestPath: batch.manifestPath,
    summary: summarizeBatch(batch.items),
    items: batch.items.map((item, index) => ({
      id: item.id,
      index: index + 1,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt,
      taskId: item.taskId,
      artifacts: item.artifacts,
      error: item.error,
    })),
  };
}

export function summarizeBatch(items = []) {
  const summary = {
    total: items.length,
    queued: 0,
    active: 0,
    completed: 0,
    failed: 0,
    finished: 0,
  };
  for (const item of items) {
    if (item.status === "completed") summary.completed += 1;
    else if (["failed", "cancelled"].includes(item.status)) summary.failed += 1;
    else if (item.status === "queued") summary.queued += 1;
    else summary.active += 1;
  }
  summary.finished = summary.completed + summary.failed;
  return summary;
}

export async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index], index);
      }
    }),
  );
}

function syncBatchArtifacts(job) {
  if (!job.batch) return;
  const imageUrls = [];
  const downloadedFiles = [];
  for (const item of job.batch.items) {
    imageUrls.push(...(item.artifacts?.imageUrls || []));
    downloadedFiles.push(...(item.artifacts?.downloadedFiles || []));
  }
  job.artifacts = {
    manifestPath: job.batch.manifestPath,
    metadataPath: job.batch.manifestPath,
    imageUrls,
    downloadedFiles,
  };
}

async function writeBatchManifest(job) {
  if (!job.batch?.manifestPath) return;
  const manifest = {
    schemaVersion: 1,
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    request: job.request,
    batch: publicBatch(job.batch),
    artifacts: job.artifacts,
    error: job.error,
  };
  await fsp.writeFile(job.batch.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function batchDirectoryName(job) {
  const timestamp = job.createdAt.replace(/[:.]/g, "-");
  return `${timestamp}-${job.id.slice(0, 8)}`;
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

export function publicArtifacts(artifacts, outputDir) {
  return {
    metadataPath: artifacts.metadataPath,
    imageUrls: artifacts.imageUrls,
    downloadedFiles: artifacts.downloadedFiles.map((filePath) => ({
      path: filePath,
      url: fileUrl(filePath, outputDir),
    })),
  };
}

export function fileUrl(filePath, outputDir) {
  const root = path.resolve(outputDir);
  const relative = path.relative(root, path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const rootId = registerOutputRoot(root);
  return `/api/files/${rootId}/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
}

async function serveOutputFile(response, relativePath) {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  const registeredRoot = outputRoots.get(segments[0]);
  const outputDir = registeredRoot || path.resolve(getConfig().outputDir);
  const fileSegments = registeredRoot ? segments.slice(1) : segments;
  if (!fileSegments.length) {
    writeJson(response, 404, { error: { message: "File not found." } });
    return;
  }
  const filePath = path.resolve(outputDir, ...fileSegments);
  if (!isPathInside(outputDir, filePath)) {
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
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw requestError("Request body must be valid JSON.", "invalid_json");
  }
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
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Nebula-Base-Url,X-Nebula-Api-Key");
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

function validatedBaseUrl(value) {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  let url;
  try {
    url = new URL(cleaned);
  } catch {
    throw requestError("baseUrl must be a valid http or https URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw requestError("baseUrl must be a valid http or https URL without credentials.");
  }
  if (url.search || url.hash) {
    throw requestError("baseUrl must not include a query string or fragment.");
  }
  return cleaned.replace(/\/+$/, "");
}

function connectionOverridesFromHeaders(request) {
  return {
    baseUrl: validatedBaseUrl(request.headers["x-nebula-base-url"]),
    apiKey: cleanString(request.headers["x-nebula-api-key"]),
  };
}

function withConnectionOverrides(values, request) {
  const overrides = connectionOverridesFromHeaders(request);
  return {
    ...values,
    ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
    ...(overrides.apiKey ? { apiKey: overrides.apiKey } : {}),
  };
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function integerInRange(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw requestError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function registerOutputRoot(outputDir) {
  for (const [id, root] of outputRoots) {
    if (root === outputDir) return id;
  }
  const id = randomUUID();
  outputRoots.set(id, outputDir);
  if (outputRoots.size > maxOutputRoots) outputRoots.delete(outputRoots.keys().next().value);
  return id;
}

function isPathInside(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requestError(message, code = "invalid_request") {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function httpStatusForError(error) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  if (/too large/i.test(error?.message || "")) return 413;
  return 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
