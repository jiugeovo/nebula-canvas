export const MODEL_PRESETS = {
  adobe: {
    skill: "nebula-canvas-adobe-image",
    group: "adobe",
    models: ["adobe-gpt-image-2"],
    defaults: {
      model: "adobe-gpt-image-2",
      size: "3504x2336",
      resolution: "4K",
      aspectRatio: "3:2",
      responseFormat: "b64_json",
    },
  },
  banana: {
    skill: "nebula-canvas-banana-image",
    group: "adobe",
    models: ["adobe-nano-banana", "adobe-nano-banana-pro", "adobe-nano-banana-2"],
    defaults: {
      model: "adobe-nano-banana-pro",
      size: "2048x2048",
      resolution: "2K",
      responseFormat: "b64_json",
    },
  },
  image2: {
    skill: "nebula-canvas-image2",
    group: "gpt-image-2-1k",
    models: ["gpt-image-2"],
    defaults: {
      model: "gpt-image-2",
      size: "1024x1024",
      responseFormat: "b64_json",
    },
  },
};

export function applyPreset(kind, options) {
  const preset = MODEL_PRESETS[kind];
  const cleanOptions = omitEmpty(options);
  if (!preset) return cleanOptions;
  return {
    ...preset.defaults,
    ...cleanOptions,
  };
}

export function getPresetSummary() {
  return Object.entries(MODEL_PRESETS).map(([name, preset]) => ({
    name,
    group: preset.group,
    models: preset.models,
    defaults: preset.defaults,
  }));
}

function omitEmpty(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
}

