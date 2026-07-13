# NebulaCanvas

NebulaCanvas 是一个给 Codex 使用的 APINebula 异步生图工具包。它把“提交图片任务、轮询结果、下载图片、保存元数据”封装成 CLI / MCP 工具，再配套一个轻量 Codex Skill。

## 功能

- CLI：本地命令行调用 APINebula 异步生图接口。
- Web：本地启动可视化界面，在浏览器里填写参数、提交任务和查看结果。
- REST API：Codex 或其他本地脚本可以直接连接本地服务调用。
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

## Web 可视化界面

启动本地服务：

```powershell
npm run web
```

默认地址：

```text
http://127.0.0.1:8787
```

打开后可以在网页里选择模式：

- 生图：提交单张或批量异步生图任务。批量模式支持 2–12 张、1–4 个并发任务。
- 同步改图：上传本地参考图，调用 `POST /v1/images/edits`，默认使用 `response_format=url` 以降低本地内存占用。
- 异步改图：填写公网参考图 URL，调用 `POST /v1/image-tasks/edits`。

### 网页连接设置

点击页面右上角的服务状态，可以直接设置：

- `API Base URL`：APINebula 或兼容服务的根地址，例如 `https://apinebula.com`。
- `API Key`：用于当前网页标签页提交的临时令牌。

网页设置优先于服务端 `.env`，会自动用于单张生成、批量生成、同步改图和异步改图。Base URL 作为浏览器偏好保存在本地；API Key 只保存在当前标签页的 `sessionStorage`，关闭标签页后自动清除，不会写入 `.env`、任务 JSON 或批次 `manifest.json`。点击“恢复服务端配置”可以重新使用 `.env`。

批量任务会作为一条记录显示在任务队列中，页面会展示整体进度、成功/失败数量和每张图片的状态。结果默认保存到：

```text
outputs/batches/<时间戳>-<批次ID>/
├─ 001.png
├─ 001.json
├─ 002.png
├─ 002.json
└─ manifest.json
```

`manifest.json` 会在批次处理过程中持续更新，包含子任务 ID、状态、错误和本地输出路径。

下载后的图片和任务元数据仍然保存在 `NEBULA_CANVAS_OUTPUT_DIR` 指定的目录中。页面里的“临时 API Key”只用于本次本地任务，不会写入 `.env`，也不会在任务 JSON 中回显。

本地服务会自动压缩任务历史中的大字段：同步改图默认返回图片 URL，上传参考图和下载结果图都会尽量使用流式处理；如果手动指定返回 `b64_json`，保存图片后也会把内存中的任务记录替换为 `[omitted]`。任务历史默认只保留最近 20 条，避免长时间运行后占用过多内存。

如果需要指定端口：

```powershell
node bin\nebula-canvas-web.js --port 8790
```

## REST API

本地 Web 服务同时提供 REST API，方便 Codex 或其他工具直接调用。

查看服务状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
```

提交生成任务：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/jobs `
  -Method POST `
  -ContentType "application/json" `
  -Body '{
    "preset": "banana",
    "prompt": "一张高级感产品海报，浅灰背景，柔和布光，干净构图，无水印",
    "size": "1024x1024"
  }'
```

查询任务：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/jobs/<job_id>
```

查看所有任务：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/jobs
```

提交批量生成任务：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/batches `
  -Method POST `
  -ContentType "application/json" `
  -Body '{
    "preset": "image2",
    "prompt": "一张简洁的商业产品图，浅灰背景，真实摄影质感，无水印",
    "size": "1024x1024",
    "count": 6,
    "concurrency": 2
  }'
```

批量限制为 `count: 2–12`、`concurrency: 1–4`，且并发数不能超过生成数量。

同步改图需要上传本地图片，适合在浏览器画布里操作；异步改图使用公网图片 URL，也可以直接调用 REST API：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/edit-jobs `
  -Method POST `
  -ContentType "application/json" `
  -Body '{
    "model": "gpt-image-2",
    "prompt": "保留主体构图，将画面调整为清晨暖光电影风，不要文字和水印",
    "imageUrls": ["https://example.com/input.png"],
    "size": "1024x1536",
    "quality": "high"
  }'
```

## 分组说明

创建 APINebula 令牌时，请选择对应分组：

| 模型 | 令牌分组 |
| --- | --- |
| `adobe-gpt-image-2` | `adobe` |
| `adobe-nano-banana` | `adobe` |
| `adobe-nano-banana-pro` | `adobe` |
| `adobe-nano-banana-2` | `adobe` |
| `gpt-image-2` | `image-2-1k` |

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

也可以让 Codex 通过 MCP 改图：

```text
用 $nebula-canvas 把这张本地图片改成红金古风灯笼氛围，使用 gpt-image-2。
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

MCP 暴露四个工具：

- `nebula_canvas_generate_image`
- `nebula_canvas_get_task`
- `nebula_canvas_edit_image`（同步改图默认返回 URL）
- `nebula_canvas_edit_image_async`

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
