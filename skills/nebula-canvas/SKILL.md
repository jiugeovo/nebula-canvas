---
name: nebula-canvas
description: Generate images through APINebula with NebulaCanvas. Use when the user asks Codex to create images with APINebula, adobe-gpt-image-2, Nano Banana, adobe-nano-banana, adobe-nano-banana-pro, adobe-nano-banana-2, gpt-image-2, or wants Codex to call NebulaCanvas's CLI/MCP async image workflow.
---

# NebulaCanvas

Use this skill to generate or edit images with APINebula through NebulaCanvas.

## Configuration

Require these environment variables in the NebulaCanvas MCP server or shell:

```env
APINEBULA_API_KEY=your_api_key_here
APINEBULA_BASE_URL=https://apinebula.com
NEBULA_CANVAS_ADOBE_MODEL=adobe-gpt-image-2
NEBULA_CANVAS_BANANA_MODEL=adobe-nano-banana-pro
NEBULA_CANVAS_IMAGE2_MODEL=gpt-image-2
NEBULA_CANVAS_OUTPUT_DIR=./outputs
```

The model selected on the command line takes priority over the `.env` model. The `.env` model takes priority over NebulaCanvas built-in defaults.

## Preset Routing

Choose a preset from the user's request:

| User intent | Preset | Default model env var | Token group |
| --- | --- | --- | --- |
| Adobe GPT Image 2, Adobe 2K/4K, cinematic/realistic image generation | `adobe` | `NEBULA_CANVAS_ADOBE_MODEL` | `adobe` |
| Nano Banana, Banana Pro, Banana 2, Gemini-style image generation | `banana` | `NEBULA_CANVAS_BANANA_MODEL` | `adobe` |
| gpt-image-2 1K image generation | `image2` | `NEBULA_CANVAS_IMAGE2_MODEL` | `image-2-1k` |

Use `banana` for any of these models:

- `adobe-nano-banana`
- `adobe-nano-banana-pro`
- `adobe-nano-banana-2`

## Preferred Tool Flow

Prefer the NebulaCanvas MCP tool when available:

- Tool: `nebula_canvas_generate_image`
- Required input: `prompt`
- Optional input: `preset`, `model`, `size`, `resolution`, `aspectRatio`, `quality`, `responseFormat`, `outputDir`

For local image editing:

- Tool: `nebula_canvas_edit_image`
- Required input: `prompt`, `imagePaths`
- Default model: `gpt-image-2`
- Token group: `image-2-1k`

For async image editing with public image URLs:

- Tool: `nebula_canvas_edit_image_async`
- Required input: `prompt`, `imageUrls`
- Default model: `gpt-image-2`
- Token group: `image-2-1k`

If MCP is not available, run the CLI:

```bash
nebula-canvas image generate --preset banana --prompt "A premium product poster, clean studio lighting, no text."
```

If the package is not globally linked, run:

```bash
node bin/nebula-canvas.js image generate --preset banana --prompt "A premium product poster, clean studio lighting, no text."
```

## Parameter Guidance

- For `adobe`, use `size=3504x2336`, `resolution=4K`, and `aspectRatio=3:2` for large 3:2 output, or `1024x1024`, `resolution=1K`, and `aspectRatio=1:1` for a quick test.
- For `banana`, use `adobe-nano-banana-pro` by default. Switch to `adobe-nano-banana` for faster/simple output or `adobe-nano-banana-2` when requested.
- For `image2`, use `gpt-image-2` and prefer `size=1024x1024`.
- For local edits, use `nebula_canvas_edit_image` with local file paths. Use `size=1024x1536` for vertical images or `1024x1024` for square images.
- For async edits, use `nebula_canvas_edit_image_async` only when the reference image is already available as a public URL.
- Always include a clear prompt with subject, setting, composition, lighting, style, and any text/no-text constraints.

For user-facing responses, include the task id when present, generated local file path, and image URL if returned. Do not reveal API keys.
