import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import MultipartFormData from "form-data";
import { ensureApiKey, ensureOutputDir } from "./config.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export class APINebulaClient {
  constructor(config) {
    this.config = config;
    ensureApiKey(config);
  }

  async createImageGenerationTask(payload) {
    return this.postJson("/v1/image-tasks/generations", payload);
  }

  async createImageEditTask(payload) {
    return this.postJson("/v1/image-tasks/edits", payload);
  }

  async editImages(payload) {
    const form = new MultipartFormData();

    for (const [key, value] of Object.entries(payload.fields || {})) {
      if (value !== undefined && value !== null && value !== "") {
        form.append(key, String(value));
      }
    }

    for (const file of payload.images || []) {
      await appendFileInput(form, "image", file, "image.png");
    }

    if (payload.mask) {
      await appendFileInput(form, "mask", payload.mask, "mask.png");
    }

    return postMultipartJson(`${this.config.baseUrl}/v1/images/edits`, form, {
      Authorization: `Bearer ${this.config.apiKey}`,
    });
  }

  async getImageTask(taskId, { detail = true } = {}) {
    const suffix = detail ? "?detail=true" : "";
    return this.getJson(`/v1/image-tasks/${encodeURIComponent(taskId)}${suffix}`);
  }

  async waitForImageTask(taskId, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? this.config.pollIntervalMs;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const started = Date.now();
    let lastTask;

    while (Date.now() - started <= timeoutMs) {
      lastTask = await this.getImageTask(taskId, { detail: true });
      if (TERMINAL_STATUSES.has(lastTask.status)) return lastTask;
      await sleep(pollIntervalMs);
    }

    const status = lastTask?.status ? ` Last status: ${lastTask.status}.` : "";
    throw new Error(`Timed out waiting for image task ${taskId}.${status}`);
  }

  async generateImageAsync(payload, options = {}) {
    const task = await this.createImageGenerationTask(payload);
    const taskId = task.task_id || task.id;
    if (!taskId) {
      throw new Error(`APINebula did not return a task id: ${JSON.stringify(task)}`);
    }
    const finalTask = options.wait === false ? task : await this.waitForImageTask(taskId, options);
    return { taskId, task, finalTask };
  }

  async editImageAsync(payload, options = {}) {
    const task = await this.createImageEditTask(payload);
    const taskId = task.task_id || task.id;
    if (!taskId) {
      throw new Error(`APINebula did not return a task id: ${JSON.stringify(task)}`);
    }
    const finalTask = options.wait === false ? task : await this.waitForImageTask(taskId, options);
    return { taskId, task, finalTask };
  }

  async postJson(pathname, payload) {
    const response = await fetch(`${this.config.baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: stringifyJsonForRequest(payload),
    });
    return readJsonResponse(response);
  }

  async getJson(pathname) {
    const response = await fetch(`${this.config.baseUrl}${pathname}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });
    return readJsonResponse(response);
  }
}

export function buildGenerationPayload(options) {
  const payload = {
    model: options.model,
    prompt: options.prompt,
  };

  setIfPresent(payload, "size", options.size);
  setIfPresent(payload, "resolution", options.resolution);
  setIfPresent(payload, "aspect_ratio", options.aspectRatio);
  setIfPresent(payload, "quality", options.quality);
  setIfPresent(payload, "response_format", options.responseFormat);

  return payload;
}

export function buildEditTaskPayload(options) {
  const payload = {
    model: options.model,
    prompt: options.prompt,
    images: (options.imageUrls || []).map((imageUrl) => ({ image_url: imageUrl })),
  };

  setIfPresent(payload, "size", options.size);
  setIfPresent(payload, "quality", options.quality);
  setIfPresent(payload, "response_format", options.responseFormat);

  return payload;
}

export function buildEditFields(options) {
  const fields = {
    model: options.model,
    prompt: options.prompt,
  };

  setIfPresent(fields, "size", options.size);
  setIfPresent(fields, "quality", options.quality);
  setIfPresent(fields, "response_format", options.responseFormat);
  setIfPresent(fields, "input_fidelity", options.inputFidelity);
  setIfPresent(fields, "background", options.background);
  setIfPresent(fields, "moderation", options.moderation);

  return fields;
}

export function stringifyJsonForRequest(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7E]/g, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

export function extractImageUrls(task) {
  const urls = [];
  const candidates = [
    task?.url,
    task?.image_url,
    task?.download_url,
    ...(Array.isArray(task?.data) ? task.data : []),
    ...(Array.isArray(task?.detail?.data) ? task.detail.data : []),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "string" && isHttpUrl(candidate)) {
      urls.push(candidate);
      continue;
    }
    if (typeof candidate === "object") {
      for (const key of ["download_url", "url", "image_url"]) {
        if (isHttpUrl(candidate[key])) urls.push(candidate[key]);
      }
    }
  }

  return [...new Set(urls)];
}

export async function saveTaskArtifacts({ taskId, model, finalTask, outputDir, download = true }) {
  await ensureOutputDir(outputDir);
  const safeModel = sanitizeName(model || finalTask?.model || "image");
  const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeModel}-${taskId}`;
  const metadataPath = path.join(outputDir, `${stem}.json`);
  await fs.promises.writeFile(metadataPath, `${JSON.stringify(finalTask, null, 2)}\n`, "utf8");

  const imageUrls = extractImageUrls(finalTask);
  const downloadedFiles = [];

  if (download) {
    for (let index = 0; index < imageUrls.length; index += 1) {
      const url = imageUrls[index];
      const filePath = path.join(outputDir, `${stem}-${index + 1}${extensionFromUrl(url)}`);
      await downloadFile(url, filePath);
      downloadedFiles.push(filePath);
    }
  }

  return {
    metadataPath,
    imageUrls,
    downloadedFiles,
  };
}

export async function saveImageResponseArtifacts({ response, model, outputDir, download = true }) {
  await ensureOutputDir(outputDir);
  const safeModel = sanitizeName(model || "image-edit");
  const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeModel}-edit`;
  const metadataPath = path.join(outputDir, `${stem}.json`);
  await fs.promises.writeFile(metadataPath, `${JSON.stringify(omitBase64Payloads(response), null, 2)}\n`, "utf8");

  const imageUrls = extractImageUrls(response);
  const downloadedFiles = [];

  const items = Array.isArray(response?.data) ? response.data : [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (download && item?.b64_json) {
      const filePath = path.join(outputDir, `${stem}-${index + 1}.png`);
      await fs.promises.writeFile(filePath, Buffer.from(item.b64_json, "base64"));
      downloadedFiles.push(filePath);
    }
  }

  if (download) {
    for (let index = 0; index < imageUrls.length; index += 1) {
      const url = imageUrls[index];
      const filePath = path.join(outputDir, `${stem}-url-${index + 1}${extensionFromUrl(url)}`);
      await downloadFile(url, filePath);
      downloadedFiles.push(filePath);
    }
  }

  return {
    metadataPath,
    imageUrls,
    downloadedFiles,
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`APINebula returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    const message = json?.error?.message || json?.message || JSON.stringify(json);
    throw new Error(`APINebula HTTP ${response.status}: ${message}`);
  }

  return json;
}

async function downloadFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(filePath, buffer);
    return;
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setIfPresent(object, key, value) {
  if (value !== undefined && value !== null && value !== "") object[key] = value;
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function sanitizeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "image";
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    if (/^\.[a-zA-Z0-9]{1,8}$/.test(ext)) return ext;
  } catch {
    // Fall through to a stable image extension.
  }
  return `-${crypto.randomBytes(4).toString("hex")}.png`;
}

async function appendFileInput(form, fieldName, file, defaultFilename) {
  const filename = file.filename || (file.path ? path.basename(file.path) : defaultFilename);
  const contentType = file.contentType || (file.path ? contentTypeFromPath(file.path) : "application/octet-stream");

  if (file.buffer) {
    form.append(fieldName, file.buffer, {
      filename,
      contentType,
      knownLength: file.buffer.length,
    });
    return;
  }

  if (file.path) {
    const options = {
      filename,
      contentType,
    };
    try {
      options.knownLength = (await fs.promises.stat(file.path)).size;
    } catch {
      // Chunked upload is fine when the local size cannot be read.
    }
    form.append(fieldName, fs.createReadStream(file.path), options);
    return;
  }

  throw new Error("Image file must include a buffer or path.");
}

async function postMultipartJson(urlString, form, headers = {}) {
  const { statusCode, text } = await submitMultipartForm(urlString, form, headers);
  return parseJsonResponseText(statusCode, text);
}

async function submitMultipartForm(urlString, form, headers = {}) {
  const url = new URL(urlString);
  const transport = url.protocol === "https:" ? https : http;
  const requestHeaders = form.getHeaders(headers);

  try {
    requestHeaders["content-length"] = await new Promise((resolve, reject) => {
      form.getLength((error, length) => (error ? reject(error) : resolve(length)));
    });
  } catch {
    // Streams without a known length can still be sent with chunked transfer.
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: requestHeaders,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    form.on("error", reject);
    form.pipe(request);
  });
}

function parseJsonResponseText(statusCode, text) {
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`APINebula returned non-JSON HTTP ${statusCode}: ${text.slice(0, 500)}`);
  }

  if (statusCode < 200 || statusCode >= 300) {
    const message = json?.error?.message || json?.message || JSON.stringify(json);
    throw new Error(`APINebula HTTP ${statusCode}: ${message}`);
  }

  return json;
}

function contentTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    }[ext] || "application/octet-stream"
  );
}

function omitBase64Payloads(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(omitBase64Payloads);

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "b64_json" && typeof item === "string" ? "[omitted]" : omitBase64Payloads(item),
    ]),
  );
}
