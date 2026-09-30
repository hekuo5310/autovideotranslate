# AutoVideoTranslate

AI 辅助视频翻译、字幕与配音流水线。

## 架构

- **Cloudflare Worker**：API、R2 Multipart Upload、内部媒体网关
- **Durable Object `ProjectJob`**：每个项目一个状态机，管理 Container 生命周期和任务状态
- **Cloudflare Container**：Debian + FFmpeg/ffprobe
- **R2**：原视频、字幕、TTS 音频、中间文件和最终成片
- **D1**：项目、字幕片段、术语和审核记录
- **Queues**：媒体分析、渲染以及后续 AI/TTS 异步任务
- **Gemini**：视频理解、识别、翻译和 QA
- **MiMo V2.5 TTS**：中文配音

## 数据流

```text
Browser
  │ multipart chunks
  ▼
Worker
  │ R2 binding
  ▼
R2
  │
  │ authenticated internal media stream
  ▼
Project DO → FFmpeg Container
                 │
                 ▼
               Worker
                 │
                 ▼
                 R2
```

Container 不持有 R2/S3 密钥。它只通过 Worker 的内部媒体接口读写，接口由 `INTERNAL_MEDIA_TOKEN` 保护。

## 首次部署

```bash
npm install
npx wrangler d1 create autovideotranslate
npx wrangler r2 bucket create autovideotranslate-media
npx wrangler queues create autovideotranslate-pipeline
```

把 D1 返回的 database ID 写入 `wrangler.jsonc`。

设置：

```json
"APP_ORIGIN": "https://你的 Worker 或自定义域名"
```

Secrets：

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MIMO_API_KEY
npx wrangler secret put INTERNAL_MEDIA_TOKEN
```

`INTERNAL_MEDIA_TOKEN` 建议使用随机高熵字符串。

初始化数据库并部署：

```bash
npx wrangler d1 migrations apply autovideotranslate --remote
npm run deploy
```

## R2 文件布局

```text
projects/
└── {projectId}/
    ├── source/
    │   └── original.mp4
    ├── proxy/
    ├── audio/
    ├── tts/
    ├── subtitle/
    └── output/
        └── final.mp4
```

D1 的 `source_key` / `output_key` 保存 R2 object key。

## Pipeline

```text
上传 R2
  → ffprobe
  → Gemini 视频理解/转录
  → Gemini 上下文与术语
  → Gemini 初译
  → AI QA
  → 人工字幕终审
  → MiMo TTS
  → TTS QA
  → 人工配音终审
  → FFmpeg Container 渲染
  → R2
  → 成片终审
```

## License

MPL-2.0
