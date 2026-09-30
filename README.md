# AutoVideoTranslate

AI 辅助视频翻译、字幕与配音流水线。

## 存储：OneDrive OAuth

媒体文件统一存 OneDrive，不使用 R2。后台直接提供“连接 OneDrive”按钮，采用 Microsoft OAuth 2.0 Authorization Code + PKCE：

```text
设置 → 连接 OneDrive
  → Microsoft 登录/授权
  → /api/auth/onedrive/callback
  → code + PKCE verifier 换 token
  → refresh token AES-GCM 加密写入 D1
  → /me/drive 自动取得 driveId
```

不再需要手工填写 refresh token 或 driveId。

### Microsoft Entra 应用

添加 Web 重定向 URI：

```text
https://你的域名/api/auth/onedrive/callback
```

Delegated permissions：

```text
Files.ReadWrite
User.Read
offline_access
```

支持个人 Microsoft Account + 工作/学校账号时，把应用账户类型配置为相应的多租户/个人账号选项，并保持：

```json
"ONEDRIVE_TENANT_ID": "common"
```

### Wrangler 配置

```json
"APP_ORIGIN": "https://你的域名",
"ONEDRIVE_TENANT_ID": "common",
"ONEDRIVE_CLIENT_ID": "你的应用 Client ID",
"ONEDRIVE_ROOT_PATH": "AutoVideoTranslate"
```

Secrets：

```bash
npx wrangler secret put ONEDRIVE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MIMO_API_KEY
```

`TOKEN_ENCRYPTION_KEY` 使用随机高熵字符串。refresh token 只以 AES-GCM 密文写入 D1。

## Cloudflare 资源

```bash
npm install
npx wrangler d1 create autovideotranslate
npx wrangler queues create autovideotranslate-pipeline
npx wrangler d1 migrations apply autovideotranslate --remote
npm run deploy
```

## OneDrive 文件流

```text
Browser
  │ POST /uploads/init
  ▼
Worker → Graph createUploadSession
  │
  └── uploadUrl → Browser → OneDrive

OneDrive → temporary downloadUrl → FFmpeg Container
FFmpeg Container → OneDrive upload session → final.mp4
```

## 文件布局

```text
AutoVideoTranslate/
└── projects/
    └── {projectId}/
        ├── source/
        ├── proxy/
        ├── audio/
        ├── tts/
        ├── subtitle/
        └── output/final.mp4
```

## Pipeline

```text
上传 → ffprobe → Gemini 转录/理解 → 翻译 → AI QA
→ 人工字幕终审 → MiMo TTS → TTS QA
→ 人工配音终审 → FFmpeg Render → OneDrive → 成片终审
```

## License

MPL-2.0
