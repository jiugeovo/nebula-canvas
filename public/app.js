const TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const ACTIVE_STATUSES = new Set(["queued", "submitting", "pending", "processing", "running", "saving"]);
const MODE_META = {
  generate: {
    title: "新建图像",
    submit: "生成图像",
    icon: "sparkles",
    prompt: "描述主体、场景、构图、光线、风格与文字要求",
  },
  "edit-sync": {
    title: "本地改图",
    submit: "开始改图",
    icon: "image-plus",
    prompt: "说明需要保留的内容，以及希望如何调整画面",
  },
  "edit-async": {
    title: "URL 改图",
    submit: "提交改图",
    icon: "link-2",
    prompt: "说明需要保留的内容，以及希望如何调整画面",
  },
};
const STATUS_META = {
  queued: { label: "排队中", tone: "working" },
  submitting: { label: "提交中", tone: "working" },
  pending: { label: "等待处理", tone: "working" },
  processing: { label: "生成中", tone: "working" },
  running: { label: "生成中", tone: "working" },
  saving: { label: "保存中", tone: "working" },
  completed: { label: "已完成", tone: "success" },
  partial: { label: "部分完成", tone: "warning" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};
const PRESET_LABELS = {
  adobe: "Adobe",
  banana: "Banana",
  image2: "Image 2",
};
const STORAGE_KEYS = {
  baseUrl: "nebula-canvas.base-url",
  apiKey: "nebula-canvas.api-key",
};

const state = {
  presets: [],
  jobs: [],
  activeJobId: null,
  pollTimer: null,
  polling: false,
  mode: "generate",
  jobFilter: "all",
  previewUrls: [],
  health: null,
  batchConcurrency: 2,
  connection: loadConnectionSettings(),
};

const elements = {
  form: document.querySelector("#generateForm"),
  composerTitle: document.querySelector("#composerTitle"),
  presetSelect: document.querySelector("#presetSelect"),
  modelSelect: document.querySelector("#modelSelect"),
  sizeInput: document.querySelector("#sizeInput"),
  resolutionSelect: document.querySelector("#resolutionSelect"),
  aspectRatioInput: document.querySelector("#aspectRatioInput"),
  qualitySelect: document.querySelector("#qualitySelect"),
  outputDirInput: document.querySelector("#outputDirInput"),
  imageInput: document.querySelector("#imageInput"),
  imageUrlsInput: document.querySelector("#imageUrlsInput"),
  inputFidelitySelect: document.querySelector("#inputFidelitySelect"),
  promptInput: document.querySelector("#promptInput"),
  batchCountInput: document.querySelector("#batchCountInput"),
  concurrencySelect: document.querySelector("#concurrencySelect"),
  concurrencyField: document.querySelector("#concurrencyField"),
  batchModeLabel: document.querySelector("#batchModeLabel"),
  batchSummary: document.querySelector("#batchSummary"),
  submitButton: document.querySelector("#submitButton"),
  submitMeta: document.querySelector("#submitMeta"),
  formAlert: document.querySelector("#formAlert"),
  openConnectionSettings: document.querySelector("#openConnectionSettings"),
  healthLabel: document.querySelector("#healthLabel"),
  healthMeta: document.querySelector("#healthMeta"),
  groupLabel: document.querySelector("#groupLabel"),
  activeJob: document.querySelector("#activeJob"),
  jobList: document.querySelector("#jobList"),
  jobCount: document.querySelector("#jobCount"),
  jobTemplate: document.querySelector("#jobTemplate"),
  reusePrompt: document.querySelector("#reusePrompt"),
  promptCount: document.querySelector("#promptCount"),
  urlCount: document.querySelector("#urlCount"),
  fileCount: document.querySelector("#fileCount"),
  filePreviews: document.querySelector("#filePreviews"),
  dropzone: document.querySelector("#dropzone"),
  toastRegion: document.querySelector("#toastRegion"),
  connectionDialog: document.querySelector("#connectionDialog"),
  connectionForm: document.querySelector("#connectionForm"),
  connectionBaseUrlInput: document.querySelector("#connectionBaseUrlInput"),
  connectionApiKeyInput: document.querySelector("#connectionApiKeyInput"),
  connectionKeyNote: document.querySelector("#connectionKeyNote"),
  connectionPreview: document.querySelector("#connectionPreview"),
};

wireEvents();
refreshIcons();
await init();

function wireEvents() {
  document.querySelector("#refreshHealth").addEventListener("click", (event) => runButtonTask(event.currentTarget, loadHealth));
  document.querySelector("#refreshJobs").addEventListener("click", (event) =>
    runButtonTask(event.currentTarget, () => loadJobs({ announceError: true })),
  );
  elements.reusePrompt.addEventListener("click", reuseActiveJob);
  elements.presetSelect.addEventListener("change", syncPresetDefaults);
  elements.modelSelect.addEventListener("change", updateSubmitMeta);
  elements.imageInput.addEventListener("change", () => setImageFiles(elements.imageInput.files));
  elements.imageUrlsInput.addEventListener("input", updateUrlCount);
  elements.promptInput.addEventListener("input", updatePromptCount);
  elements.batchCountInput.addEventListener("input", updateBatchControls);
  elements.batchCountInput.addEventListener("change", normalizeBatchCount);
  elements.concurrencySelect.addEventListener("change", () => {
    state.batchConcurrency = Number(elements.concurrencySelect.value || 1);
    updateBatchSummary();
  });
  elements.form.addEventListener("input", updateSubmitMeta);
  elements.form.addEventListener("submit", handleSubmit);
  elements.activeJob.addEventListener("click", handleActiveJobAction);
  elements.openConnectionSettings.addEventListener("click", openConnectionDialog);
  elements.connectionForm.addEventListener("submit", applyConnectionSettings);
  document.querySelector("#closeConnectionSettings").addEventListener("click", closeConnectionDialog);
  document.querySelector("#resetConnectionSettings").addEventListener("click", resetConnectionSettings);
  document.querySelector("#toggleConnectionApiKey").addEventListener("click", toggleConnectionApiKeyVisibility);
  elements.connectionDialog.addEventListener("click", closeDialogFromBackdrop);

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  document.querySelectorAll("[data-job-filter]").forEach((button) => {
    button.addEventListener("click", () => setJobFilter(button.dataset.jobFilter));
  });
  document.querySelectorAll("[data-step]").forEach((button) => {
    button.addEventListener("click", () => stepBatchCount(Number(button.dataset.step)));
  });

  for (const eventName of ["dragenter", "dragover"]) {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropzone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropzone.classList.remove("is-dragging");
    });
  }
  elements.dropzone.addEventListener("drop", (event) => setImageFiles(event.dataTransfer?.files || []));
  elements.dropzone.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    elements.imageInput.click();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.jobs.some(isActiveJob)) loadJobs();
  });
  window.addEventListener("beforeunload", clearPreviewUrls);
}

async function init() {
  setMode(state.mode);
  const results = await Promise.allSettled([loadHealth(), loadPresets(), loadJobs()]);
  if (results[1].status === "rejected") {
    showFormAlert("模型预设加载失败，请确认本地服务已启动。", "danger");
  }
  startPolling();
}

async function loadHealth() {
  try {
    const health = await api("/api/health");
    state.health = health;
    elements.openConnectionSettings.dataset.state = health.apiKeyConfigured ? "ready" : "warning";
    elements.healthLabel.textContent = health.apiKeyConfigured ? "服务就绪" : "需要 API Key";
    elements.healthMeta.textContent = health.usingCustomBaseUrl || health.usingCustomApiKey ? "使用网页连接设置" : "使用服务端配置";
    elements.openConnectionSettings.title = `服务：${health.baseUrl}\n输出：${health.outputDir}`;
    elements.outputDirInput.placeholder = health.outputDir ? `默认：${health.outputDir}` : "使用默认输出目录";
    return health;
  } catch (error) {
    state.health = null;
    elements.openConnectionSettings.dataset.state = "error";
    elements.healthLabel.textContent = "服务异常";
    elements.healthMeta.textContent = "无法连接本地服务";
    throw error;
  }
}

async function loadPresets() {
  const selected = elements.presetSelect.value || "image2";
  const data = await api("/api/presets");
  state.presets = data.presets || [];
  elements.presetSelect.replaceChildren();
  for (const preset of state.presets) {
    elements.presetSelect.append(new Option(PRESET_LABELS[preset.name] || preset.name, preset.name));
  }
  if (state.presets.some((preset) => preset.name === selected)) elements.presetSelect.value = selected;
  syncPresetDefaults();
}

async function loadJobs({ announceError = false } = {}) {
  try {
    const data = await api("/api/jobs");
    state.jobs = data.jobs || [];
    if (!state.jobs.some((job) => job.id === state.activeJobId)) {
      state.activeJobId = state.jobs[0]?.id || null;
    }
    renderJobs();
    return data;
  } catch (error) {
    if (announceError) showToast(friendlyError(error), "danger");
    throw error;
  }
}

function setMode(mode) {
  if (!MODE_META[mode]) return;
  state.mode = mode;
  const meta = MODE_META[mode];

  document.querySelectorAll("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  toggleModeNodes("[data-generate-only]", mode !== "generate");
  toggleModeNodes("[data-edit-only]", mode === "generate");
  toggleModeNodes("[data-edit-sync-only]", mode !== "edit-sync");
  toggleModeNodes("[data-edit-async-only]", mode !== "edit-async");

  elements.composerTitle.textContent = meta.title;
  elements.promptInput.placeholder = meta.prompt;
  elements.submitButton.innerHTML = `<i data-lucide="${meta.icon}"></i><span>${meta.submit}</span>`;
  hideFormAlert();
  syncPresetDefaults();
  updateBatchControls();
  refreshIcons();
}

function toggleModeNodes(selector, hidden) {
  document.querySelectorAll(selector).forEach((node) => {
    node.hidden = hidden;
  });
}

function syncPresetDefaults() {
  if (state.mode !== "generate") {
    replaceSelectOptions(elements.modelSelect, ["gpt-image-2"], "gpt-image-2");
    elements.sizeInput.value = "1024x1536";
    elements.qualitySelect.value = "high";
    elements.resolutionSelect.value = "";
    elements.aspectRatioInput.value = "";
    setModelGroup("image-2-1k");
    updateSubmitMeta();
    return;
  }

  const preset = state.presets.find((item) => item.name === elements.presetSelect.value);
  if (!preset) {
    updateSubmitMeta();
    return;
  }

  const models = [...new Set([preset.defaults?.model, ...(preset.models || [])].filter(Boolean))];
  replaceSelectOptions(elements.modelSelect, models, preset.defaults?.model);
  elements.sizeInput.value = preset.defaults?.size || "";
  elements.qualitySelect.value = preset.defaults?.quality || "";
  elements.resolutionSelect.value = preset.defaults?.resolution || "";
  elements.aspectRatioInput.value = preset.defaults?.aspectRatio || "";
  setModelGroup(preset.group || "未指定");
  updateSubmitMeta();
}

function setModelGroup(group) {
  elements.groupLabel.textContent = group;
  elements.groupLabel.title = group;
}

function replaceSelectOptions(select, values, selected) {
  select.replaceChildren(...values.map((value) => new Option(value, value)));
  if (selected) select.value = selected;
}

async function handleSubmit(event) {
  event.preventDefault();
  hideFormAlert();
  if (!validateForm()) return;

  setSubmitting(true);
  try {
    const job = state.mode === "generate" ? await submitGeneration() : await submitEdit();
    state.activeJobId = job.id;
    await loadJobs();
    showToast(job.kind === "batch" ? `批次已提交，共 ${job.batch?.count || getBatchCount()} 张` : "任务已提交", "success");
  } catch (error) {
    showFormAlert(friendlyError(error), "danger");
  } finally {
    setSubmitting(false);
  }
}

function validateForm() {
  if (!elements.form.reportValidity()) return false;
  if (state.mode === "edit-sync" && !elements.imageInput.files.length) {
    showFormAlert("请至少添加一张参考图。", "warning");
    elements.dropzone.focus();
    return false;
  }
  if (state.mode === "edit-async") {
    const urls = parseImageUrls();
    if (!urls.length) {
      showFormAlert("请至少填写一个公网图片 URL。", "warning");
      elements.imageUrlsInput.focus();
      return false;
    }
    if (urls.some((url) => !isHttpUrl(url))) {
      showFormAlert("参考图地址必须是有效的 http 或 https URL。", "warning");
      elements.imageUrlsInput.focus();
      return false;
    }
  }
  return true;
}

async function submitGeneration() {
  const data = Object.fromEntries(new FormData(elements.form).entries());
  const count = getBatchCount();
  const payload = cleanPayload({
    preset: data.preset,
    model: data.model,
    prompt: data.prompt,
    size: data.size,
    resolution: data.resolution,
    aspectRatio: data.aspectRatio,
    quality: data.quality,
    outputDir: data.outputDir,
    noDownload: elements.form.elements.noDownload.checked,
    count: count > 1 ? count : undefined,
    concurrency: count > 1 ? Number(data.concurrency || 1) : undefined,
  });
  return api(count > 1 ? "/api/batches" : "/api/jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function submitEdit() {
  const data = Object.fromEntries(new FormData(elements.form).entries());
  if (state.mode === "edit-sync") {
    const body = new FormData();
    body.append("model", data.model || "gpt-image-2");
    body.append("prompt", data.prompt);
    body.append("size", data.size || "1024x1536");
    body.append("quality", data.quality || "high");
    body.append("responseFormat", "url");
    body.append("inputFidelity", data.inputFidelity || "high");
    if (data.outputDir) body.append("outputDir", data.outputDir);
    body.append("noDownload", elements.form.elements.noDownload.checked ? "true" : "false");
    for (const file of elements.imageInput.files) body.append("image", file);
    return api("/api/edit-jobs", { method: "POST", body });
  }

  return api("/api/edit-jobs", {
    method: "POST",
    body: JSON.stringify(
      cleanPayload({
        model: data.model || "gpt-image-2",
        prompt: data.prompt,
        imageUrls: parseImageUrls(),
        size: data.size || "1024x1536",
        quality: data.quality || "high",
        responseFormat: "b64_json",
        outputDir: data.outputDir,
        noDownload: elements.form.elements.noDownload.checked,
      }),
    ),
  });
}

function renderJobs() {
  const active = state.jobs.find((job) => job.id === state.activeJobId);
  renderActiveJob(active);
  elements.jobCount.textContent = String(state.jobs.length);
  elements.jobList.replaceChildren();

  const filteredJobs = state.jobs.filter(matchesJobFilter);
  if (!filteredJobs.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = state.jobs.length ? "没有符合筛选条件的任务" : "提交任务后会显示在这里";
    elements.jobList.append(empty);
    return;
  }

  for (const job of filteredJobs) {
    const node = elements.jobTemplate.content.firstElementChild.cloneNode(true);
    const status = getStatusMeta(job.status);
    node.dataset.status = normalizeStatus(job.status);
    node.classList.toggle("active", job.id === state.activeJobId);
    node.setAttribute("aria-current", job.id === state.activeJobId ? "true" : "false");
    node.querySelector('[data-field="status"]').textContent = status.label;
    node.querySelector('[data-field="model"]').textContent = getJobModel(job);
    const batchMeta = node.querySelector('[data-field="batch"]');
    if (job.kind === "batch") {
      const summary = getBatchSummary(job);
      batchMeta.hidden = false;
      batchMeta.textContent = `${summary.finished}/${summary.total} · ${summary.completed} 成功${summary.failed ? ` · ${summary.failed} 失败` : ""}`;
    }
    node.querySelector('[data-field="prompt"]').textContent = job.request?.prompt || "无提示词";
    node.querySelector('[data-field="updatedAt"]').textContent = formatCompactTime(job.updatedAt);
    node.querySelector('[data-field="updatedAt"]').dateTime = job.updatedAt || "";
    node.addEventListener("click", () => {
      state.activeJobId = job.id;
      renderJobs();
    });
    elements.jobList.append(node);
  }
}

function renderActiveJob(job) {
  elements.reusePrompt.hidden = !job;
  if (!job) {
    elements.activeJob.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon" aria-hidden="true"><i data-lucide="images"></i></span>
        <h3>画布已就绪</h3>
        <p>新任务会显示在这里</p>
      </div>
    `;
    refreshIcons();
    return;
  }

  const status = getStatusMeta(job.status);
  const mode = getJobMode(job);
  const batchSummary = getBatchSummary(job);
  const error = job.error
    ? friendlyError(job.error.message || JSON.stringify(job.error))
    : job.kind === "batch" && job.status === "failed" && batchSummary.failed
      ? `批次中的 ${batchSummary.failed} 个任务全部失败。请展开任务详情查看各项错误。`
      : "";
  const imageItems = getImageItems(job);
  elements.activeJob.innerHTML = `
    <article class="task-view">
      <header class="task-header">
        <div class="task-title-block">
          <span class="task-kicker">${escapeHtml(job.kind === "batch" ? `批量生成 · ${batchSummary.total} 张` : mode.label)}</span>
          <h3>${escapeHtml(getJobModel(job))}</h3>
          <p>${escapeHtml(job.request?.prompt || "无提示词")}</p>
        </div>
        <span class="status-badge" data-tone="${status.tone}">
          ${isActiveJob(job) ? '<i class="spin" data-lucide="loader-circle"></i>' : statusIcon(job.status)}
          ${escapeHtml(status.label)}
        </span>
      </header>

      ${job.kind === "batch" ? renderBatchOverview(job, batchSummary) : ""}
      ${renderTaskBody(job, imageItems, error)}

      <footer class="task-footer">
        <div class="task-facts">
          <span><i data-lucide="clock-3"></i>${escapeHtml(formatTime(job.updatedAt))}</span>
          ${job.kind === "batch" ? `<span><i data-lucide="layers-3"></i>并发 ${escapeHtml(job.batch?.concurrency || 1)}</span>` : ""}
          <button type="button" class="text-action" data-copy-value="${escapeAttr(job.taskId || job.id)}" title="复制任务 ID">
            <i data-lucide="copy"></i><span>${escapeHtml(shortId(job.taskId || job.id))}</span>
          </button>
        </div>
        <details class="job-details">
          <summary>任务详情 <i data-lucide="chevron-down"></i></summary>
          <div class="job-detail-content">
            ${job.batch?.manifestPath ? renderPathRow("批次清单", job.batch.manifestPath) : job.artifacts?.metadataPath ? renderPathRow("元数据", job.artifacts.metadataPath) : ""}
            ${job.kind === "batch" ? renderBatchErrors(job.batch?.items || []) : ""}
            ${renderPathRows(job.artifacts?.downloadedFiles || [])}
            <pre data-json-job-id="${escapeAttr(job.id)}">展开后加载</pre>
          </div>
        </details>
      </footer>
    </article>
  `;

  const details = elements.activeJob.querySelector(".job-details");
  details?.addEventListener("toggle", () => {
    const pre = details.querySelector("pre");
    if (!details.open || !pre || pre.dataset.loaded) return;
    pre.textContent = JSON.stringify(job, null, 2);
    pre.dataset.loaded = "true";
  });
  refreshIcons();
}

function renderTaskBody(job, images, error) {
  if (error) {
    return `
      <div class="error-state">
        <span class="error-icon"><i data-lucide="triangle-alert"></i></span>
        <div>
          <h4>任务未完成</h4>
          <p>${escapeHtml(error)}</p>
        </div>
      </div>
    `;
  }
  if (images.length) return renderImages(images);
  if (isActiveJob(job)) {
    if (job.kind === "batch") {
      return `
        <div class="batch-waiting-state">
          <i class="spin" data-lucide="loader-circle"></i>
          <span>已完成的图片会逐张出现在这里</span>
        </div>
      `;
    }
    return renderProcessingState(job.status);
  }
  return `
    <div class="result-empty">
      <i data-lucide="image-plus"></i>
      <h4>任务已完成，但没有可预览的图片</h4>
      <p>图片可能仅保存在远程响应或元数据中。</p>
    </div>
  `;
}

function renderBatchOverview(job, summary) {
  const progress = summary.total ? Math.round((summary.finished / summary.total) * 100) : 0;
  return `
    <section class="batch-overview" aria-label="批次进度">
      <div class="batch-progress-head">
        <div>
          <strong>${summary.finished} / ${summary.total}</strong>
          <span>已处理</span>
        </div>
        <div class="batch-counts">
          <span data-tone="success">${summary.completed} 成功</span>
          <span data-tone="working">${summary.active + summary.queued} 进行中</span>
          ${summary.failed ? `<span data-tone="danger">${summary.failed} 失败</span>` : ""}
        </div>
      </div>
      <div class="batch-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
        <span style="width: ${progress}%"></span>
      </div>
      <div class="batch-item-strip">
        ${(job.batch?.items || []).map((item) => renderBatchItem(item)).join("")}
      </div>
    </section>
  `;
}

function renderBatchItem(item) {
  const status = getStatusMeta(item.status);
  const image = (item.artifacts?.downloadedFiles || []).find((file) => safeImageUrl(file.url));
  const active = ACTIVE_STATUSES.has(item.status) && item.status !== "queued";
  return `
    <div class="batch-item" data-status="${escapeAttr(normalizeStatus(item.status))}" title="${escapeAttr(`第 ${item.index} 张 · ${status.label}`)}">
      ${image ? `<img src="${escapeAttr(image.url)}" alt="批次结果 ${item.index}" />` : `<span>${String(item.index).padStart(2, "0")}</span>`}
      <i data-lucide="${item.status === "completed" ? "check" : ["failed", "cancelled"].includes(item.status) ? "x" : item.status === "queued" ? "clock-3" : "loader-circle"}"${active ? ' class="spin"' : ""}></i>
    </div>
  `;
}

function renderBatchErrors(items) {
  const failedItems = items.filter((item) => item.error);
  if (!failedItems.length) return "";
  return `
    <div class="batch-error-list">
      <strong>失败项</strong>
      ${failedItems
        .map(
          (item) => `
            <div>
              <span>#${String(item.index).padStart(2, "0")}</span>
              <p>${escapeHtml(friendlyError(item.error?.message || item.error))}</p>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderImages(items) {
  return `
    <div class="result-gallery" data-count="${items.length}">
      ${items
        .map(
          (item, index) => `
            <figure class="result-image">
              <img src="${escapeAttr(item.src)}" alt="生成结果 ${index + 1}" loading="eager" />
              <figcaption>
                <span>结果 ${index + 1}</span>
                <span class="image-actions">
                  ${item.path ? `<button type="button" data-copy-value="${escapeAttr(item.path)}" title="复制本地路径" aria-label="复制本地路径"><i data-lucide="copy"></i></button>` : ""}
                  <a href="${escapeAttr(item.href)}" target="_blank" rel="noopener noreferrer" title="打开原图" aria-label="打开原图"><i data-lucide="external-link"></i></a>
                </span>
              </figcaption>
            </figure>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderProcessingState(status) {
  const step = status === "saving" ? 3 : ["processing", "running"].includes(status) ? 2 : 1;
  const message = status === "saving" ? "图片正在写入输出目录" : step === 2 ? "模型正在生成画面" : "任务正在进入处理队列";
  return `
    <div class="processing-state">
      <span class="processing-icon"><i class="spin" data-lucide="loader-circle"></i></span>
      <h4>${escapeHtml(getStatusMeta(status).label)}</h4>
      <p>${escapeHtml(message)}</p>
      <ol class="task-progress" aria-label="任务进度">
        ${renderProgressStep("提交", 1, step)}
        ${renderProgressStep("生成", 2, step)}
        ${renderProgressStep("保存", 3, step)}
      </ol>
    </div>
  `;
}

function renderProgressStep(label, value, current) {
  const className = value < current ? "done" : value === current ? "current" : "";
  return `<li class="${className}"><span></span>${label}</li>`;
}

function renderPathRows(files) {
  return files.map((file, index) => renderPathRow(`图片 ${index + 1}`, file.path)).join("");
}

function renderPathRow(label, value) {
  return `
    <div class="path-row">
      <span>${escapeHtml(label)}</span>
      <code title="${escapeAttr(value)}">${escapeHtml(value)}</code>
      <button type="button" data-copy-value="${escapeAttr(value)}" title="复制路径" aria-label="复制路径"><i data-lucide="copy"></i></button>
    </div>
  `;
}

function getImageItems(job) {
  const localFiles = (job.artifacts?.downloadedFiles || [])
    .filter((file) => safeImageUrl(file.url))
    .map((file) => ({ src: safeImageUrl(file.url), href: safeImageUrl(file.url), path: file.path }));
  if (localFiles.length) return localFiles;
  return [...new Set(job.artifacts?.imageUrls || [])]
    .map((url) => safeImageUrl(url))
    .filter(Boolean)
    .map((url) => ({ src: url, href: url, path: null }));
}

function setJobFilter(filter) {
  state.jobFilter = filter;
  document.querySelectorAll("[data-job-filter]").forEach((button) => {
    const active = button.dataset.jobFilter === filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderJobs();
}

function matchesJobFilter(job) {
  if (state.jobFilter === "active") return isActiveJob(job);
  if (state.jobFilter === "failed") return job.status === "failed" || job.status === "partial";
  return true;
}

function reuseActiveJob() {
  const job = state.jobs.find((item) => item.id === state.activeJobId);
  if (!job) return;
  const request = job.request || {};
  setMode(request.mode || "generate");

  if (request.preset && [...elements.presetSelect.options].some((option) => option.value === request.preset)) {
    elements.presetSelect.value = request.preset;
    syncPresetDefaults();
  }
  if (request.model) ensureSelectValue(elements.modelSelect, request.model);
  elements.promptInput.value = request.prompt || "";
  elements.sizeInput.value = request.size || elements.sizeInput.value;
  elements.qualitySelect.value = request.quality || "";
  elements.resolutionSelect.value = request.resolution || "";
  elements.aspectRatioInput.value = request.aspectRatio || "";
  elements.inputFidelitySelect.value = request.inputFidelity || "high";
  elements.outputDirInput.value = request.outputDir || "";
  elements.form.elements.noDownload.checked = Boolean(request.noDownload);
  elements.batchCountInput.value = request.count || 1;
  state.batchConcurrency = request.concurrency || 2;
  updateBatchControls();
  if (request.imageUrls) elements.imageUrlsInput.value = request.imageUrls.join("\n");
  updatePromptCount();
  updateUrlCount();
  updateSubmitMeta();
  document.querySelector(".composer-pane").scrollIntoView({ behavior: "smooth", block: "start" });
  elements.promptInput.focus({ preventScroll: true });
  showToast("已载入任务参数", "success");
}

function ensureSelectValue(select, value) {
  if (![...select.options].some((option) => option.value === value)) select.append(new Option(value, value));
  select.value = value;
}

function handleActiveJobAction(event) {
  const copyButton = event.target.closest("[data-copy-value]");
  if (copyButton) copyText(copyButton.dataset.copyValue);
}

async function copyText(value) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast("已复制到剪贴板", "success");
}

function setImageFiles(files) {
  const fileList = [...files];
  const accepted = fileList.filter((file) => ["image/png", "image/jpeg", "image/webp"].includes(file.type)).slice(0, 8);
  if (!accepted.length) {
    elements.imageInput.value = "";
    renderFilePreviews();
    showFormAlert("请选择 PNG、JPEG 或 WebP 图片。", "warning");
    return;
  }
  if (accepted.length < fileList.length) {
    showFormAlert(fileList.length > 8 ? "单次最多添加 8 张参考图。" : "已忽略不支持的文件格式。", "warning");
  }
  const transfer = new DataTransfer();
  accepted.forEach((file) => transfer.items.add(file));
  elements.imageInput.files = transfer.files;
  renderFilePreviews();
}

function renderFilePreviews() {
  clearPreviewUrls();
  const files = [...elements.imageInput.files].slice(0, 8);
  elements.fileCount.textContent = `${files.length} / 8`;
  elements.filePreviews.replaceChildren();
  files.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    state.previewUrls.push(url);
    const item = document.createElement("div");
    item.className = "file-preview";
    item.innerHTML = `
      <img src="${escapeAttr(url)}" alt="参考图 ${index + 1}" />
      <span title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</span>
      <button type="button" title="移除 ${escapeAttr(file.name)}" aria-label="移除 ${escapeAttr(file.name)}"><i data-lucide="x"></i></button>
    `;
    item.querySelector("button").addEventListener("click", () => removeImageFile(index));
    elements.filePreviews.append(item);
  });
  refreshIcons();
}

function removeImageFile(index) {
  const transfer = new DataTransfer();
  [...elements.imageInput.files].forEach((file, fileIndex) => {
    if (fileIndex !== index) transfer.items.add(file);
  });
  elements.imageInput.files = transfer.files;
  renderFilePreviews();
}

function clearPreviewUrls() {
  state.previewUrls.forEach((url) => URL.revokeObjectURL(url));
  state.previewUrls = [];
}

function parseImageUrls() {
  return elements.imageUrlsInput.value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function updatePromptCount() {
  elements.promptCount.textContent = `${[...elements.promptInput.value].length} 字`;
}

function updateUrlCount() {
  elements.urlCount.textContent = `${parseImageUrls().length} 个链接`;
}

function updateSubmitMeta() {
  const selection = elements.modelSelect.value
    || (state.mode === "generate" ? PRESET_LABELS[elements.presetSelect.value] || "图像生成" : "gpt-image-2");
  const size = elements.sizeInput.value || "默认尺寸";
  const count = state.mode === "generate" ? getBatchCount() : 1;
  const batchMeta = count > 1 ? ` · ${count} 张 · 并发 ${elements.concurrencySelect.value}` : "";
  elements.submitMeta.textContent = `${selection} · ${size}${batchMeta}`;
}

function updateBatchControls() {
  const count = getBatchCount();
  const maxConcurrency = Math.min(4, count);
  elements.concurrencySelect.replaceChildren(
    ...Array.from({ length: maxConcurrency }, (_, index) => new Option(`${index + 1} 个任务`, String(index + 1))),
  );
  elements.concurrencySelect.disabled = count === 1;
  elements.concurrencySelect.value = String(Math.min(state.batchConcurrency, maxConcurrency));
  elements.concurrencyField.classList.toggle("is-disabled", count === 1);
  elements.batchModeLabel.textContent = count === 1 ? "单张" : `批量 ${count} 张`;
  updateBatchSummary();
}

function updateBatchSummary() {
  const count = getBatchCount();
  elements.batchSummary.innerHTML = count === 1
    ? '<i data-lucide="layers-3"></i><span>单张任务</span>'
    : `<i data-lucide="layers-3"></i><span>将创建 ${count} 个任务，同时处理 ${elements.concurrencySelect.value} 个</span>`;
  const meta = MODE_META[state.mode];
  if (state.mode === "generate" && !elements.submitButton.disabled) {
    elements.submitButton.innerHTML = `<i data-lucide="${meta.icon}"></i><span>${count > 1 ? `生成 ${count} 张` : meta.submit}</span>`;
  }
  updateSubmitMeta();
  refreshIcons();
}

function normalizeBatchCount() {
  elements.batchCountInput.value = String(getBatchCount());
  updateBatchControls();
}

function stepBatchCount(delta) {
  elements.batchCountInput.value = String(Math.min(12, Math.max(1, getBatchCount() + delta)));
  updateBatchControls();
}

function getBatchCount() {
  const value = Number(elements.batchCountInput.value);
  return Number.isFinite(value) ? Math.min(12, Math.max(1, Math.round(value))) : 1;
}

function openConnectionDialog() {
  elements.connectionBaseUrlInput.value = state.connection.baseUrl || state.health?.baseUrl || "https://apinebula.com";
  elements.connectionApiKeyInput.value = state.connection.apiKey || "";
  elements.connectionKeyNote.textContent = state.connection.apiKey
    ? "当前标签页已设置网页 Key"
    : state.health?.apiKeyConfigured
      ? "留空时使用服务端环境中的 Key"
      : "当前没有可用 Key，请在此输入";
  updateConnectionPreview();
  elements.connectionDialog.showModal();
  elements.connectionBaseUrlInput.focus();
}

function closeConnectionDialog() {
  elements.connectionDialog.close();
}

function closeDialogFromBackdrop(event) {
  if (event.target === elements.connectionDialog) closeConnectionDialog();
}

async function applyConnectionSettings(event) {
  event.preventDefault();
  const baseUrl = normalizeBaseUrlInput(elements.connectionBaseUrlInput.value);
  if (!baseUrl) {
    elements.connectionBaseUrlInput.setCustomValidity("请输入有效的 http 或 https 地址");
    elements.connectionBaseUrlInput.reportValidity();
    return;
  }
  elements.connectionBaseUrlInput.setCustomValidity("");
  state.connection = {
    baseUrl,
    apiKey: elements.connectionApiKeyInput.value.trim(),
  };
  persistConnectionSettings();
  updateConnectionPreview("connecting");
  try {
    await loadHealth();
    updateConnectionPreview(state.health?.apiKeyConfigured ? "ready" : "warning");
    showToast("连接设置已应用", "success");
    setTimeout(closeConnectionDialog, 250);
  } catch (error) {
    updateConnectionPreview("error", friendlyError(error));
  }
}

async function resetConnectionSettings() {
  state.connection = { baseUrl: "", apiKey: "" };
  localStorage.removeItem(STORAGE_KEYS.baseUrl);
  sessionStorage.removeItem(STORAGE_KEYS.apiKey);
  elements.connectionApiKeyInput.value = "";
  try {
    await loadHealth();
    elements.connectionBaseUrlInput.value = state.health?.baseUrl || "https://apinebula.com";
    updateConnectionPreview(state.health?.apiKeyConfigured ? "ready" : "warning");
    showToast("已恢复服务端配置", "success");
  } catch (error) {
    updateConnectionPreview("error", friendlyError(error));
  }
}

function toggleConnectionApiKeyVisibility(event) {
  const visible = elements.connectionApiKeyInput.type === "text";
  elements.connectionApiKeyInput.type = visible ? "password" : "text";
  event.currentTarget.title = visible ? "显示 API Key" : "隐藏 API Key";
  event.currentTarget.setAttribute("aria-label", event.currentTarget.title);
  event.currentTarget.innerHTML = `<i data-lucide="${visible ? "eye" : "eye-off"}"></i>`;
  refreshIcons();
}

function updateConnectionPreview(stateName, message) {
  const currentState = stateName || (state.health?.apiKeyConfigured ? "ready" : "warning");
  const baseUrl = normalizeBaseUrlInput(elements.connectionBaseUrlInput.value) || "地址待填写";
  const labels = {
    connecting: ["正在应用", "检查连接配置"],
    ready: ["设置已应用", baseUrl],
    warning: ["还需要 API Key", baseUrl],
    error: ["配置不可用", message || "请检查 URL 后重试"],
  };
  const [label, meta] = labels[currentState] || labels.warning;
  elements.connectionPreview.dataset.state = currentState;
  elements.connectionPreview.querySelector("strong").textContent = label;
  elements.connectionPreview.querySelector("small").textContent = meta;
}

function loadConnectionSettings() {
  try {
    return {
      baseUrl: localStorage.getItem(STORAGE_KEYS.baseUrl) || "",
      apiKey: sessionStorage.getItem(STORAGE_KEYS.apiKey) || "",
    };
  } catch {
    return { baseUrl: "", apiKey: "" };
  }
}

function persistConnectionSettings() {
  try {
    if (state.connection.baseUrl) localStorage.setItem(STORAGE_KEYS.baseUrl, state.connection.baseUrl);
    else localStorage.removeItem(STORAGE_KEYS.baseUrl);
    if (state.connection.apiKey) sessionStorage.setItem(STORAGE_KEYS.apiKey, state.connection.apiKey);
    else sessionStorage.removeItem(STORAGE_KEYS.apiKey);
  } catch {
    // Private browsing may disable web storage; the in-memory settings still work.
  }
}

function normalizeBaseUrlInput(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function setSubmitting(submitting) {
  elements.submitButton.disabled = submitting;
  const meta = MODE_META[state.mode];
  const count = state.mode === "generate" ? getBatchCount() : 1;
  elements.submitButton.innerHTML = submitting
    ? '<i class="spin" data-lucide="loader-circle"></i><span>正在提交</span>'
    : `<i data-lucide="${meta.icon}"></i><span>${count > 1 ? `生成 ${count} 张` : meta.submit}</span>`;
  refreshIcons();
}

function showFormAlert(message, tone = "danger") {
  elements.formAlert.hidden = false;
  elements.formAlert.dataset.tone = tone;
  elements.formAlert.innerHTML = `<i data-lucide="triangle-alert"></i><span>${escapeHtml(message)}</span>`;
  refreshIcons();
}

function hideFormAlert() {
  elements.formAlert.hidden = true;
  elements.formAlert.textContent = "";
}

function showToast(message, tone = "neutral") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.tone = tone;
  toast.innerHTML = `${statusIcon(tone === "success" ? "completed" : tone === "danger" ? "failed" : "queued")}<span>${escapeHtml(message)}</span>`;
  elements.toastRegion.append(toast);
  refreshIcons();
  setTimeout(() => toast.classList.add("leaving"), 2600);
  setTimeout(() => toast.remove(), 3000);
}

async function runButtonTask(button, task) {
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    await task();
  } catch {
    // The task updates its own visible error state.
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (document.hidden || state.polling || !state.jobs.some(isActiveJob)) return;
    state.polling = true;
    try {
      await loadJobs();
    } catch {
      // A manual refresh will surface persistent connection errors.
    } finally {
      state.polling = false;
    }
  }, 3000);
}

async function api(path, options = {}) {
  const connectionHeaders = cleanPayload({
    "X-Nebula-Base-Url": state.connection.baseUrl,
    "X-Nebula-Api-Key": state.connection.apiKey,
  });
  const headers = options.body instanceof FormData
    ? { ...connectionHeaders, ...(options.headers || {}) }
    : { "Content-Type": "application/json", ...connectionHeaders, ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.details = data?.error;
    throw error;
  }
  return data;
}

function friendlyError(error) {
  const message = String(error?.message || error || "未知错误");
  if (/Missing APINEBULA_API_KEY/i.test(message)) return "未配置 API Key。请打开顶部连接设置输入网页 Key，或在服务端 .env 中配置。";
  if (/403|无权访问.*Adobe/i.test(message)) return "当前 API Key 没有对应模型组的访问权限，请检查令牌分组。";
  if (/无可用渠道|distributor/i.test(message)) return "当前令牌分组没有该模型的可用渠道，请更换匹配的 Key 或模型。";
  if (/任务超时|Timed out/i.test(message)) return "远程任务处理超时。任务 ID 已保留，可稍后重试或查询结果。";
  if (/fetch failed/i.test(message)) return "连接 APINebula 失败，请检查网络后重试。";
  if (/Request body is too large|Uploaded file is too large/i.test(message)) return "上传内容超过 32 MB 限制，请压缩图片后重试。";
  return message;
}

function getJobModel(job) {
  return job.payload?.model || job.request?.model || PRESET_LABELS[job.request?.preset] || job.request?.preset || "图像任务";
}

function getJobMode(job) {
  const mode = job.request?.mode || "generate";
  return {
    generate: { label: "图像生成" },
    "edit-sync": { label: "本地改图" },
    "edit-async": { label: "URL 改图" },
  }[mode] || { label: mode };
}

function getStatusMeta(status) {
  return STATUS_META[status] || { label: status || "未知状态", tone: "neutral" };
}

function statusIcon(status) {
  if (status === "completed") return '<i data-lucide="circle-check"></i>';
  if (status === "partial") return '<i data-lucide="circle-alert"></i>';
  if (status === "failed" || status === "cancelled") return '<i data-lucide="circle-x"></i>';
  return '<i data-lucide="clock-3"></i>';
}

function isActiveJob(job) {
  return ACTIVE_STATUSES.has(job.status) || !TERMINAL_STATUSES.has(job.status);
}

function getBatchSummary(job) {
  return job.batch?.summary || { total: 0, queued: 0, active: 0, completed: 0, failed: 0, finished: 0 };
}

function normalizeStatus(status) {
  return /^[a-z-]+$/.test(status || "") ? status : "unknown";
}

function formatTime(value) {
  if (!value) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatCompactTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function safeImageUrl(value) {
  if (typeof value !== "string") return "";
  if (value.startsWith("/api/files/")) return value;
  return isHttpUrl(value) ? value : "";
}

function cleanPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { "stroke-width": 1.8 } });
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
