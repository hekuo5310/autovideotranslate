# AutoVideoTranslate

AI 辅助的视频翻译、字幕与配音流水线。

## 当前架构

- **Cloudflare Worker**：HTTP API、上传控制、内部媒体网关
- **Durable Object `ProjectJob`**：一个项目一个状态机，负责 Container 生命周期、任务重试与运行状态
- **Cloudflare Container**：Debian + FFmpeg/ffprobe，负责媒体分析、字幕烧录、配音混音和最终编码
- **R2**：原视频、字幕、TTS 音频与成片
- **D1**：项目、字幕片段、术语表和人工审核记录
- **Queues**：probe/render 及后续 Gemini/MiMo 异步任务
- **Gemini 3.8 Flash**：计划用于视频理解、识别、翻译与 QA
- **MiMo V2.5 TTS**：用于角色中文配音

## 第一阶段已实现

- 项目创建与 D1 持久化
- R2 Multipart Upload API
- 上传完成后自动排队
- 一个项目对应一个 Durable Object
- DO 按需启动 FFmpeg Container
- ffprobe 媒体元信息分析
- FFmpeg 最终渲染
- R2 内部媒体流接口
- Gemini JSON 适配器
- MiMo TTS 官方 OpenAI-compatible API 适配器
- 最小 Web UI
- GitHub Actions TypeScript typecheck

## 本地/首次部署

1. 安装依赖

```bash
npm install
```

2. 创建资源

```bash
npx wrangler d1 create autovideotranslate
npx wrangler r2 bucket create autovideotranslate-media
npx wrangler queues create autovideotranslate-pipeline
```

把 D1 返回的 ID 写入 `wrangler.jsonc`。

3. 设置 secrets

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MIMO_API_KEY
npx wrangler secret put INTERNAL_MEDIA_TOKEN
```

`INTERNAL_MEDIA_TOKEN` 使用随机长字符串。

4. 修改 `APP_ORIGIN`

把 `wrangler.jsonc` 中的：

```text
https://REPLACE_WITH_YOUR_DOMAIN
```

替换为生产 Worker/自定义域名。Container 会通过该地址流式访问 R2 内部媒体接口。

5. 初始化 D1

```bash
npx wrangler d1 migrations apply autovideotranslate --remote
```

6. 部署

```bash
npm run deploy
```

## 目录

```text
src/
  index.ts          Worker API / Queue consumer
  project-job.ts    Durable Object + Container orchestration
  ai/
    gemini.ts
    mimo.ts

container/
  Dockerfile
  server.py

migrations/
  0001_init.sql

public/
  index.html
```

## Pipeline 目标

```text
上传
  → ffprobe
  → Gemini 视频理解/转录
  → Gemini 上下文与术语
  → Gemini 初译
  → AI QA
  → 人工字幕终审
  → MiMo TTS
  → TTS 时长 QA
  → 人工配音终审
  → FFmpeg Container 渲染
  → 人工成片终审
```

## 下一步

当前 commit 先建立稳定的媒体与任务底座。下一步应继续实现：

1. Gemini Files API / Cloud Storage 视频上传与时间轴结构化转录
2. `segments` 字幕编辑 API
3. Gemini 翻译 + QA + glossary/translation memory
4. MiMo 按 segment 批量 TTS、时长检测、自动重试
5. ASS 生成器
6. 人工字幕/配音审核工作台
7. WebSocket 实时转码进度

## License

MPL-2.0
