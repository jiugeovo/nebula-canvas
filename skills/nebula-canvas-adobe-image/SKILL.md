---
name: nebula-canvas-adobe-image
description: Generate images through APINebula's Adobe image models with NebulaCanvas. Use when the user asks Codex to create images with adobe-gpt-image-2, Adobe 2K/4K image generation, APINebula adobe group image generation, or wants Codex to call NebulaCanvas's MCP/CLI async image workflow for Adobe GPT Image 2.
---

# NebulaCanvas Adobe Image

Use this skill to generate images with APINebula `adobe-gpt-image-2` through NebulaCanvas's async image task workflow.

## Configuration

Require these environment variables in the NebulaCanvas MCP server or shell:

```env
APINEBULA_API_KEY=your_api_key_here
APINEBULA_BASE_URL=https://apinebula.com
NEBULA_CANVAS_OUTPUT_DIR=./outputs
```

Use an APINebula token created from the `adobe` group.

## Preferred Tool Flow

Prefer the NebulaCanvas MCP tool when available:

- Tool: `nebula_canvas_generate_image`
- Preset: `adobe`
- Default model: `adobe-gpt-image-2`
- Default size: `3504x2336`
- Default resolution: `4K`
- Default aspect ratio: `3:2`

If MCP is not available, run the CLI:

```bash
nebula-canvas image generate \
  --preset adobe \
  --prompt "A cinematic rainy futuristic city street, neon reflections, realistic photography, 3:2 composition."
```

## Parameters

Use these parameters unless the user asks otherwise:

- `model`: `adobe-gpt-image-2`
- `size`: `3504x2336` for 3:2 4K-style output, or `1024x1024` for quick tests.
- `resolution`: `4K`, `2K`, or `1K`.
- `aspectRatio`: `3:2`, `1:1`, or `2:3`.
- `responseFormat`: `b64_json`.

The workflow submits `POST /v1/image-tasks/generations`, polls the returned task, downloads image URLs when available, and returns saved file paths.

## Prompting Guidance

Write the prompt with subject, setting, composition, lighting, style, and constraints. Mention "no text" or exact text requirements when text matters.

For user-facing responses, include the generated local file path and task id. Do not reveal API keys.

