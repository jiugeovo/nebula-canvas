---
name: nebula-canvas-image2
description: Generate images through APINebula gpt-image-2 with NebulaCanvas. Use when the user asks Codex to create images with gpt-image-2, gpt-image-2-1k, Image2 1K, or wants Codex to call NebulaCanvas's MCP/CLI async image workflow for Image2 generation.
---

# NebulaCanvas Image2

Use this skill to generate images with APINebula `gpt-image-2` through NebulaCanvas's async image task workflow.

## Configuration

Require these environment variables in the NebulaCanvas MCP server or shell:

```env
APINEBULA_API_KEY=your_api_key_here
APINEBULA_BASE_URL=https://apinebula.com
NEBULA_CANVAS_OUTPUT_DIR=./outputs
```

Use an APINebula token created from the `gpt-image-2-1k` group.

## Preferred Tool Flow

Prefer the NebulaCanvas MCP tool when available:

- Tool: `nebula_canvas_generate_image`
- Preset: `image2`
- Default model: `gpt-image-2`
- Default size: `1024x1024`

If MCP is not available, run the CLI:

```bash
nebula-canvas image generate \
  --preset image2 \
  --prompt "An original anime character design sheet, detailed outfit, clean background, no text."
```

## Model Choices

Use `gpt-image-2` with the `gpt-image-2-1k` group.

## Parameters

- `model`: `gpt-image-2`.
- `size`: prefer `1024x1024` because the `gpt-image-2-1k` group is not for 2K/4K output.
- `responseFormat`: `b64_json`.

The workflow submits `POST /v1/image-tasks/generations`, polls the returned task, downloads image URLs when available, and returns saved file paths.

For user-facing responses, include the generated local file path and task id. Do not reveal API keys.

