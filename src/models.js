export const MODEL_PRESETS = {
  adobe: {
    skill: "nebula-canvas",
    group: "adobe",
    models: ["adobe-gpt-image-2"],
    envModel: "NEBULA_CANVAS_ADOBE_MODEL",
    defaults: {
      model: "adobe-gpt-image-2",
      size: "3504x2336",
      resolution: "4K",
      aspectRatio: "3:2",
      responseFormat: "b64_json",
    },
  },
  banana: {
    skill: "nebula-canvas",
    group: "adobe",
    models: ["adobe-nano-banana", "adobe-nano-banana-pro", "adobe-nano-banana-2"],
    envModel: "NEBULA_CANVAS_BANANA_MODEL",
    defaults: {
      model: "adobe-nano-banana-pro",
      size: "2048x2048",
      resolution: "2K",
      responseFormat: "b64_json",
    },
  },
  image2: {
    skill: "nebula-canvas",
    group: "gpt-image-2-1k",
    models: ["gpt-image-2"],
    envModel: "NEBULA_CANVAS_IMAGE2_MODEL",
    defaults: {
      model: "gpt-image-2",
      size: "1024x1024",
      responseFormat: "b64_json",
    },
  },
};

export function applyPreset(kind, options) {
  const preset = getModelPresets()[kind];
  const cleanOptions = omitEmpty(options);
  if (!preset) return cleanOptions;
  return {
    ...preset.defaults,
    ...cleanOptions,
  };
}

export function getPresetSummary() {
  return Object.entries(getModelPresets()).map(([name, preset]) => ({
    name,
    group: preset.group,
    models: preset.models,
    envModel: preset.envModel,
    defaults: preset.defaults,
  }));
}

export function getModelPresets(env = process.env) {
  return Object.fromEntries(
    Object.entries(MODEL_PRESETS).map(([name, preset]) => [
      name,
      withEnvDefault(preset, env[preset.envModel]),
    ]),
  );
}

function omitEmpty(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
}

function withEnvDefault(preset, model) {
  if (!model) return preset;
  return {
    ...preset,
    defaults: {
      ...preset.defaults,
      model,
    },
  };
}
