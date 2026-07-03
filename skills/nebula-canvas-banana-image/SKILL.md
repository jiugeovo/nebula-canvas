---
name: nebula-canvas-banana-image
description: Generate images through APINebula's Nano Banana models with NebulaCanvas. Use when the user asks Codex to create images with adobe-nano-banana, adobe-nano-banana-pro, adobe-nano-banana-2, Nano Banana, Banana Pro, Banana 2, Gemini-style image models, or wants Codex to call NebulaCanvas's MCP/CLI async image workflow for Banana image generation.
---

# NebulaCanvas Banana Image

Use this skill to generate images with APINebula Nano Banana models through NebulaCanvas's async image task workflow.

## Configuration

Require these environment variables in the NebulaCanvas MCP server or shell:

```env
APINEBULA_API_KEY=your_api_key_here
APINEBULA_BASE_URL=https://apinebula.com
NEBULA_CANVAS_OUTPUT_DIR=./outputs
```

Use an APINebula token created from the `adobe` group. In APINebula's current model names, use the `adobe-` prefixed models.

## Preferred Tool Flow

Prefer the NebulaCanvas MCP tool when available:

- Tool: `nebula_canvas_generate_image`
- Preset: `banana`
- Default model: `adobe-nano-banana-pro`
- Default size: `2048x2048`
- Default resolution: `2K`

If MCP is not available, run the CLI:

```bash
nebula-canvas image generate \
  --preset banana \
  --prompt "A premium product poster for a translucent perfume bottle, clean studio lighting, soft shadows, no text."
```

## Model Choices

Use one of:

- `adobe-nano-banana`: fast baseline Nano Banana model. It does not use the `resolution` field.
- `adobe-nano-banana-pro`: higher quality Nano Banana model, supports `1K`, `2K`, and `4K`.
- `adobe-nano-banana-2`: newer Nano Banana model, supports broader aspect ratios and `1K`, `2K`, and `4K`.

Use the async generation endpoint even when the synchronous image API might work, so Codex gets consistent task polling and saved output paths.

## Parameters

Use these parameters unless the user asks otherwise:

- `model`: `adobe-nano-banana-pro`.
- `size`: `2048x2048` for square 2K-style output, or a ratio-appropriate size.
- `resolution`: `2K` or `4K` for `adobe-nano-banana-pro` and `adobe-nano-banana-2`.
- `responseFormat`: `b64_json`.

Supported aspect ratios include `21:9`, `16:9`, `5:4`, `4:3`, `3:2`, `1:1`, `4:5`, `3:4`, `2:3`, and `9:16`. `adobe-nano-banana-2` also supports `8:1` and `4:1`.

For user-facing responses, include the generated local file path and task id. Do not reveal API keys.

