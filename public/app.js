const state = {
  presets: [],
  jobs: [],
  activeJobId: null,
  pollTimer: null,
};

const form = document.querySelector("#generateForm");
const presetSelect = document.querySelector("#presetSelect");
const modelSelect = document.querySelector("#modelSelect");
const sizeInput = document.querySelector("#sizeInput");
const resolutionSelect = document.querySelector("#resolutionSelect");
const aspectRatioInput = document.querySelector("#aspectRatioInput");
const outputDirInput = document.querySelector("#outputDirInput");
const healthStatus = document.querySelector("#healthStatus");
const activeJob = document.querySelector("#activeJob");
const jobList = document.querySelector("#jobList");
const jobTemplate = document.querySelector("#jobTemplate");

document.querySelector("#refreshPresets").addEventListener("click", loadPresets);
document.querySelector("#refreshJobs").addEventListener("click", loadJobs);
presetSelect.addEventListener("change", syncPresetDefaults);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const payload = {
    preset: data.preset,
    model: data.model,
    prompt: data.prompt,
    size: data.size,
    resolution: data.resolution,
    aspectRatio: data.aspectRatio,
    quality: data.quality,
    outputDir: data.outputDir,
    noDownload: form.elements.noDownload.checked,
  };

  try {
    const job = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify(cleanPayload(payload)),
    });
    state.activeJobId = job.id;
    await loadJobs();
    startPolling();
  } catch (error) {
    renderError(error);
  }
});

await init();

async function init() {
  await loadHealth();
  await loadPresets();
  await loadJobs();
  startPolling();
}

async function loadHealth() {
  try {
    const health = await api("/api/health");
    healthStatus.textContent = health.apiKeyConfigured ? "已连接" : "未配置 Key";
    healthStatus.style.color = health.apiKeyConfigured ? "var(--ok)" : "var(--warn)";
  } catch {
    healthStatus.textContent = "服务异常";
    healthStatus.style.color = "var(--danger)";
  }
}

async function loadPresets() {
  const data = await api("/api/presets");
  state.presets = data.presets || [];
  presetSelect.innerHTML = "";
  for (const preset of state.presets) {
    presetSelect.append(new Option(preset.name, preset.name));
  }
  syncPresetDefaults();
}

async function loadJobs() {
  const data = await api("/api/jobs");
  state.jobs = data.jobs || [];
  if (!state.activeJobId && state.jobs[0]) state.activeJobId = state.jobs[0].id;
  renderJobs();
}

function syncPresetDefaults() {
  const preset = state.presets.find((item) => item.name === presetSelect.value);
  if (!preset) return;

  modelSelect.innerHTML = "";
  const models = new Set([preset.defaults?.model, ...(preset.models || [])].filter(Boolean));
  for (const model of models) {
    modelSelect.append(new Option(model, model));
  }
  modelSelect.value = preset.defaults?.model || "";
  sizeInput.value = preset.defaults?.size || "";
  resolutionSelect.value = preset.defaults?.resolution || "";
  aspectRatioInput.value = preset.defaults?.aspectRatio || "";
}

function renderJobs() {
  const active = state.jobs.find((job) => job.id === state.activeJobId);
  renderActiveJob(active);

  jobList.innerHTML = "";
  for (const job of state.jobs) {
    const node = jobTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('[data-field="status"]').textContent = job.status;
    node.querySelector('[data-field="model"]').textContent = job.payload?.model || job.request?.model || job.request?.preset || "";
    node.querySelector('[data-field="prompt"]').textContent = job.request?.prompt || "";
    node.querySelector('[data-field="taskId"]').textContent = job.taskId || job.id;
    node.querySelector('[data-field="updatedAt"]').textContent = formatTime(job.updatedAt);
    node.addEventListener("click", () => {
      state.activeJobId = job.id;
      renderJobs();
    });
    jobList.append(node);
  }
}

function renderActiveJob(job) {
  if (!job) {
    activeJob.className = "empty";
    activeJob.textContent = "暂无任务";
    return;
  }

  const imageFiles = job.artifacts?.downloadedFiles || [];
  const imageUrls = job.artifacts?.imageUrls || [];
  activeJob.className = "active-card";
  activeJob.innerHTML = `
    <div class="active-top">
      <div>
        <h2>${escapeHtml(job.payload?.model || job.request?.model || job.request?.preset || "任务")}</h2>
        <p>${escapeHtml(job.request?.prompt || "")}</p>
      </div>
      <span class="badge ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
    </div>
    <div class="details">
      <div>任务 ID：${escapeHtml(job.taskId || job.id)}</div>
      <div>更新时间：${escapeHtml(formatTime(job.updatedAt))}</div>
      ${job.error ? `<div>错误：${escapeHtml(job.error.message || JSON.stringify(job.error))}</div>` : ""}
      ${job.artifacts?.metadataPath ? `<div>元数据：${escapeHtml(job.artifacts.metadataPath)}</div>` : ""}
    </div>
    ${renderImages(imageFiles, imageUrls)}
    <details>
      <summary>查看 JSON</summary>
      <pre>${escapeHtml(JSON.stringify(job, null, 2))}</pre>
    </details>
  `;
}

function renderImages(files, urls) {
  const items = [];
  for (const file of files) {
    if (file.url) items.push({ href: file.url, src: file.url, title: file.path });
  }
  for (const url of urls) {
    items.push({ href: url, src: url, title: url });
  }
  if (!items.length) return "";
  return `
    <div class="image-grid">
      ${items
        .map(
          (item) => `
            <a href="${escapeAttr(item.href)}" target="_blank" title="${escapeAttr(item.title)}">
              <img src="${escapeAttr(item.src)}" alt="Generated image" />
            </a>
          `,
        )
        .join("")}
    </div>
  `;
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    const hasRunning = state.jobs.some((job) => !["completed", "failed", "cancelled"].includes(job.status));
    if (hasRunning) await loadJobs();
  }, 3000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}

function cleanPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function renderError(error) {
  activeJob.className = "active-card";
  activeJob.innerHTML = `
    <div class="active-top">
      <h2>提交失败</h2>
      <span class="badge failed">failed</span>
    </div>
    <div class="details">${escapeHtml(error.message || String(error))}</div>
  `;
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
