# AutoVideoTranslate

AI 辅助的视频翻译、字幕与配音流水线。

## 当前架构

- **Cloudflare Worker**：HTTP API、OneDrive Upload Session、权限与任务入口
- **Durable Object `ProjectJob`**：一个项目一个状态机，负责 Container 生命周期、任务重试与运行状态
- **Cloudflare Container**：Debian + FFmpeg/ffprobe，负责媒体分析、字幕烧录、配音混音和最终编码
- **OneDrive / Microsoft Graph**：原视频、字幕、TTS 音频与成片的唯一媒体存储
- **D1**：项目、字幕片段、术语表和人工审核记录
- **Queues**：probe/render 及后续 Gemini/MiMo 异步任务
- **Gemini**：视频理解、识别、翻译与 QA
- **MiMo V2.5 TTS**：角色中文配音

## OneDrive 数据流

浏览器不会把大视频先上传到 Worker：

```text
Browser
  │
  │ POST /uploads/init
  ▼
Worker ───── Microsoft Graph
  │              │
  │              └─ createUploadSession
  │
  └──── uploadUrl ─────→ Browser
                           │
                           │ PUT byte ranges
                           ▼
                        OneDrive
```

OneDrive Upload Session 返回的是预认证上传 URL，浏览器直接把分片 PUT 到该 URL。最后一个分片成功后 OneDrive 返回 `driveItem`，前端再把 `itemId` 提交给 `/uploads/complete`。

转码时：

```text
OneDrive
   │ 临时预认证 downloadUrl
   ▼
FFmpeg Container
   │
   │ createUploadSession
   ▼
OneDrive output/final.mp4
```

因此视频本体不经过 Worker，也不再需要 R2。

## OneDrive 鉴权

支持两种模式。

### 1. Microsoft 365 / OneDrive for Business（推荐）

使用应用权限 client credentials：

```json
"ONEDRIVE_AUTH_MODE": "client_credentials",
"ONEDRIVE_TENANT_ID": "...",
"ONEDRIVE_CLIENT_ID": "...",
"ONEDRIVE_DRIVE_ID": "..."
```

然后：

```bash
npx wrangler secret put ONEDRIVE_CLIENT_SECRET
```

Azure / Entra 应用需要为 Microsoft Graph 配置对应的文件读写应用权限，并完成管理员同意。

### 2. 个人 OneDrive / delegated

```json
"ONEDRIVE_AUTH_MODE": "refresh_token",
"ONEDRIVE_TENANT_ID": "consumers",
"ONEDRIVE_CLIENT_ID": "...",
"ONEDRIVE_DRIVE_ID": "..."
```

Secrets：

```bash
npx wrangler secret put ONEDRIVE_REFRESH_TOKEN
# 如果你的应用类型需要 secret：
npx wrangler secret put ONEDRIVE_CLIENT_SECRET
```

refresh token 必须带有 OneDrive 文件读写授权。生产环境后续建议把 OAuth 授权流程做进后台，不长期手工维护 refresh token。

## 首次部署

1. 安装依赖

```bash
npm install
```

2. 创建 Cloudflare 资源

```bash
npx wrangler d1 create autovideotranslate
npx wrangler queues create autovideotranslate-pipeline
```

不再创建 R2 Bucket。

3. 修改 `wrangler.jsonc`

填写：

- D1 database ID
- `ONEDRIVE_TENANT_ID`
- `ONEDRIVE_CLIENT_ID`
- `ONEDRIVE_DRIVE_ID`
- `ONEDRIVE_ROOT_PATH`

默认根目录：

```text
AutoVideoTranslate/
```

程序会自动创建项目需要的子目录。

4. 设置 secrets

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MIMO_API_KEY
npx wrangler secret put ONEDRIVE_CLIENT_SECRET
```

如果使用 refresh token 模式：

```bash
npx wrangler secret put ONEDRIVE_REFRESH_TOKEN
```

5. 初始化 D1

```bash
npx wrangler d1 migrations apply autovideotranslate --remote
```

6. 部署

```bash
npm run deploy
```

## OneDrive 文件布局

```text
AutoVideoTranslate/
└── projects/
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

D1 中现有的 `source_key` / `output_key` 字段继续保留，但语义已经改成 **OneDrive driveItem ID**，不是 R2 object key。

## Pipeline

```text
上传到 OneDrive
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
  → 上传 OneDrive
  → 人工成片终审
```

## License

MPL-2.0
