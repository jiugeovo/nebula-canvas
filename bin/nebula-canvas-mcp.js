#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { APINebulaClient, buildGenerationPayload, saveTaskArtifacts } from "../src/apinebula.js";
import { getConfig } from "../src/config.js";
import { applyPreset } from "../src/models.js";

const server = new McpServer({
  name: "nebula-canvas",
  version: "0.1.0",
});

server.tool(
  "nebula_canvas_generate_image",
  "Generate an image with APINebula async image tasks, poll until completion, and save returned artifacts.",
  {
    prompt: z.string().min(1),
    model: z.string().optional(),
    preset: z.enum(["adobe", "banana", "image2"]).optional(),
    size: z.string().optional(),
    resolution: z.string().optional(),
    aspectRatio: z.string().optional(),
    quality: z.string().optional(),
    responseFormat: z.string().optional(),
    outputDir: z.string().optional(),
    noDownload: z.boolean().optional(),
  },
  async (args) => {
    if (!args.model && !args.preset) {
      throw new Error("Provide either model or preset.");
    }

    const config = getConfig({ outputDir: args.outputDir });
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
    const result = await client.generateImageAsync(payload);
    const artifacts = await saveTaskArtifacts({
      taskId: result.taskId,
      model: payload.model,
      finalTask: result.finalTask,
      outputDir: config.outputDir,
      download: !args.noDownload,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              taskId: result.taskId,
              status: result.finalTask.status,
              model: result.finalTask.model || payload.model,
              metadataPath: artifacts.metadataPath,
              imageUrls: artifacts.imageUrls,
              downloadedFiles: artifacts.downloadedFiles,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "nebula_canvas_get_task",
  "Get APINebula async image task details.",
  {
    taskId: z.string().min(1),
  },
  async ({ taskId }) => {
    const config = getConfig();
    const client = new APINebulaClient(config);
    const task = await client.getImageTask(taskId, { detail: true });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(task, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

