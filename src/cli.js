import path from "node:path";
import { APINebulaClient, buildGenerationPayload, saveTaskArtifacts } from "./apinebula.js";
import { getConfig } from "./config.js";
import { applyPreset, getPresetSummary } from "./models.js";

export async function runCli(argv = process.argv.slice(2)) {
  const [domain, action, ...rest] = argv;

  if (!domain || domain === "-h" || domain === "--help") {
    printHelp();
    return 0;
  }

  if (domain === "models") {
    console.log(JSON.stringify(getPresetSummary(), null, 2));
    return 0;
  }

  if (domain !== "image" || action !== "generate") {
    throw new Error(`Unknown command: ${[domain, action].filter(Boolean).join(" ")}`);
  }

  const args = parseArgs(rest);
  if (!args.prompt) throw new Error("Missing --prompt.");
  if (!args.model && !args.preset) throw new Error("Missing --model or --preset.");

  const config = getConfig({
    baseUrl: args.baseUrl,
    outputDir: args.outputDir,
    pollIntervalMs: args.pollIntervalMs,
    timeoutMs: args.timeoutMs,
  });

  const options = applyPreset(args.preset, {
    model: args.model,
    prompt: args.prompt,
    size: args.size,
    resolution: args.resolution,
    aspectRatio: args.aspectRatio,
    quality: args.quality,
    responseFormat: args.responseFormat || "b64_json",
  });

  const payload = buildGenerationPayload(options);
  const client = new APINebulaClient(config);

  console.error(`Submitting async image task for ${payload.model}...`);
  const result = await client.generateImageAsync(payload, {
    wait: !args.noWait,
    pollIntervalMs: config.pollIntervalMs,
    timeoutMs: config.timeoutMs,
  });

  const finalTask = result.finalTask;
  const artifacts = await saveTaskArtifacts({
    taskId: result.taskId,
    model: payload.model,
    finalTask,
    outputDir: config.outputDir,
    download: !args.noDownload,
  });

  console.log(
    JSON.stringify(
      {
        taskId: result.taskId,
        status: finalTask.status,
        model: finalTask.model || payload.model,
        outputDir: path.resolve(config.outputDir),
        metadataPath: artifacts.metadataPath,
        imageUrls: artifacts.imageUrls,
        downloadedFiles: artifacts.downloadedFiles,
      },
      null,
      2,
    ),
  );

  if (finalTask.status && finalTask.status !== "completed" && finalTask.status !== "queued") {
    return 2;
  }

  return 0;
}

function parseArgs(args) {
  const result = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = toCamel(rawKey);

    if (["noWait", "noDownload"].includes(key)) {
      result[key] = true;
      continue;
    }

    const value = inlineValue ?? args[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    result[key] = value;
  }

  return result;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`NebulaCanvas

Usage:
  nebula-canvas image generate --model <model> --prompt <prompt> [options]
  nebula-canvas image generate --preset <adobe|banana|image2> --prompt <prompt> [options]
  nebula-canvas models

Options:
  --size <widthxheight>
  --resolution <1K|2K|4K>
  --aspect-ratio <ratio>
  --quality <low|medium|high|auto>
  --response-format <b64_json|url>
  --output-dir <path>
  --base-url <url>
  --poll-interval-ms <ms>
  --timeout-ms <ms>
  --no-download
  --no-wait
`);
}

