import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(filePath, buffer);
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
