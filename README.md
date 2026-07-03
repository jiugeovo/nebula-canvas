# NebulaCanvas

NebulaCanvas 是一个给 Codex 使用的 APINebula 异步生图工具包。它把“提交图片任务、轮询结果、下载图片、保存元数据”封装成 CLI / MCP 工具，再配套一个轻量 Codex Skill。

## 功能

- CLI：本地命令行调用 APINebula 异步生图接口。
- MCP：让 Codex 通过工具调用 NebulaCanvas。
- Skill：让 Codex 知道不同模型应该使用哪个预设和分组。
- `.env` 默认模型：可在配置文件里指定默认模型，命令行传入的 `--model` 优先级更高。

当前支持：

- `adobe-gpt-image-2`
- `adobe-nano-banana`
- `adobe-nano-banana-pro`
- `adobe-nano-banana-2`
- `gpt-image-2`

项目不会把真实 API Key 写入代码。请使用本地 `.env` 或 MCP 配置传入。

## 安装

需要 Node.js 20 或更高版本。

从 GitHub 克隆：

```powershell
git clone https://github.com/jiugeovo/nebula-canvas.git
cd nebula-canvas
npm install
```

如果是下载 zip，请先解压，然后进入解压后的 `nebula-canvas` 目录：

```powershell
cd path\to\nebula-canvas
npm install
```

如果 npm 全局缓存目录权限异常，可以使用本项目内缓存：

```powershell
npm install --cache .\.npm-cache
```

复制配置文件：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`：

```env
APINEBULA_API_KEY=你的_APINebula_令牌
APINEBULA_BASE_URL=https://apinebula.com

NEBULA_CANVAS_ADOBE_MODEL=adobe-gpt-image-2
NEBULA_CANVAS_BANANA_MODEL=adobe-nano-banana-pro
NEBULA_CANVAS_IMAGE2_MODEL=gpt-image-2

NEBULA_CANVAS_OUTPUT_DIR=./outputs
NEBULA_CANVAS_POLL_INTERVAL_MS=5000
NEBULA_CANVAS_TIMEOUT_MS=600000
```

模型选择优先级：

```text
命令行 --model > .env 默认模型 > NebulaCanvas 内置默认模型
```

## CLI 使用

查看预设：

```powershell
node bin\nebula-canvas.js models
```

调用 Adobe GPT Image 2：

```powershell
node bin\nebula-canvas.js image generate `
  --preset adobe `
  --prompt "一张电影感雨夜未来城市街景，霓虹反射，真实摄影质感" `
  --size 1024x1024 `
  --resolution 1K `
  --aspect-ratio 1:1
```

调用 Nano Banana。默认会读取 `.env` 中的 `NEBULA_CANVAS_BANANA_MODEL`：

```powershell
node bin\nebula-canvas.js image generate `
  --preset banana `
  --prompt "一张高级感产品海报，浅灰背景，柔和布光，干净构图，无水印" `
  --size 1024x1024
```

临时指定 Banana 模型：

```powershell
node bin\nebula-canvas.js image generate `
  --preset banana `
  --model adobe-nano-banana-2 `
  --prompt "一张高级感产品海报，浅灰背景，柔和布光，干净构图，无水印" `
  --size 1024x1024
```

调用 Image2：

```powershell
node bin\nebula-canvas.js image generate `
  --preset image2 `
  --prompt "一张简洁的商业产品图，浅灰背景，真实摄影质感，无水印" `
  --size 1024x1024
```

生成完成后，图片和任务元数据会保存到 `outputs/`。命令会输出：

- `taskId`
- 任务状态
- 图片 URL
- 下载后的本地文件路径
- 元数据 JSON 路径

## 分组说明

创建 APINebula 令牌时，请选择对应分组：

| 模型 | 令牌分组 |
| --- | --- |
| `adobe-gpt-image-2` | `adobe` |
| `adobe-nano-banana` | `adobe` |
| `adobe-nano-banana-pro` | `adobe` |
| `adobe-nano-banana-2` | `adobe` |
| `gpt-image-2` | `gpt-image-2-1k` |

如果令牌分组不匹配，后端可能返回“当前分组下模型无可用渠道”。

## 在 Codex 中使用 Skill

把 Skill 复制到 Codex 的 skills 目录：

```powershell
Copy-Item -Recurse .\skills\nebula-canvas "$env:USERPROFILE\.codex\skills\"
```

重启 Codex 后，可以这样说：

```text
用 $nebula-canvas 生成一张电影感未来城市图，使用 adobe 预设。
```

或：

```text
用 $nebula-canvas 生成一张高级感香水产品海报，使用 banana 预设。
```

Skill 负责告诉 Codex 如何选择模型和参数，真正请求接口的是 NebulaCanvas CLI / MCP。

## MCP 使用

启动 MCP server：

```powershell
npm run mcp
```

Codex MCP 配置示例：

```json
{
  "mcpServers": {
    "nebula-canvas": {
      "command": "node",
      "args": ["E:/path/to/nebula-canvas/bin/nebula-canvas-mcp.js"],
      "env": {
        "APINEBULA_API_KEY": "你的_APINebula_令牌",
        "APINEBULA_BASE_URL": "https://apinebula.com",
        "NEBULA_CANVAS_BANANA_MODEL": "adobe-nano-banana-pro",
        "NEBULA_CANVAS_OUTPUT_DIR": "E:/path/to/nebula-canvas/outputs"
      }
    }
  }
}
```

MCP 暴露两个工具：

- `nebula_canvas_generate_image`
- `nebula_canvas_get_task`

## 本地验证

```powershell
npm run check
node bin\nebula-canvas.js models
```

真实请求烟测：

```powershell
node bin\nebula-canvas.js image generate `
  --preset adobe `
  --prompt "一张简洁测试图，白色桌面上放着写有 NebulaCanvas 字样的小卡片，柔和自然光" `
  --size 1024x1024 `
  --resolution 1K `
  --aspect-ratio 1:1
```
