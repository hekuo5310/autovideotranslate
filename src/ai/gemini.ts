import type { Env } from "../types";

async function geminiJson(env: Env, url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Gemini request failed (${response.status}): ${await response.text()}`);
  return response.json();
}

export async function generateStructuredText(
  env: Env,
  prompt: string,
  responseSchema?: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`,
  );
  url.searchParams.set("key", env.GEMINI_API_KEY);

  const generationConfig: Record<string, unknown> = { responseMimeType: "application/json" };
  if (responseSchema) generationConfig.responseSchema = responseSchema;

  const body = await geminiJson(env, url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });

  const text = body?.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("").trim();
  if (!text) throw new Error("Gemini returned no text");
  return JSON.parse(text);
}

async function uploadGeminiFile(
  env: Env,
  body: ReadableStream,
  size: number,
  mimeType: string,
  displayName: string,
): Promise<{ name: string; uri: string; mimeType: string }> {
  const start = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(size),
      "x-goog-upload-header-content-type": mimeType,
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!start.ok) throw new Error(`Gemini file upload start failed (${start.status}): ${await start.text()}`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return a resumable upload URL");

  const uploaded = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-length": String(size),
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
      "content-type": mimeType,
    },
    body,
  });
  if (!uploaded.ok) throw new Error(`Gemini file upload failed (${uploaded.status}): ${await uploaded.text()}`);
  const result = await uploaded.json() as any;
  const file = result.file;
  if (!file?.name || !file?.uri) throw new Error("Gemini upload response did not contain file name/uri");
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType };
}

async function waitForGeminiFile(env: Env, file: { name: string; uri: string; mimeType: string }) {
  for (let i = 0; i < 180; i++) {
    const data = await geminiJson(env, `https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`);
    const state = String(data.state || "");
    if (state === "ACTIVE") return { ...file, uri: data.uri || file.uri, mimeType: data.mimeType || file.mimeType };
    if (state === "FAILED") throw new Error(`Gemini video processing failed: ${data.error?.message || "unknown error"}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error("Gemini video processing timed out after 15 minutes");
}

export interface VideoTranslationSegment {
  start_ms: number;
  end_ms: number;
  speaker_id?: string;
  source_text: string;
  translation: string;
  confidence?: number;
  flags?: string[];
}

export async function transcribeAndTranslateVideo(
  env: Env,
  body: ReadableStream,
  size: number,
  mimeType: string,
  displayName: string,
): Promise<{ fileName: string; fileUri: string; segments: VideoTranslationSegment[] }> {
  const uploaded = await uploadGeminiFile(env, body, size, mimeType, displayName);
  const file = await waitForGeminiFile(env, uploaded);
  const schema = {
    type: "OBJECT",
    properties: {
      source_language: { type: "STRING" },
      segments: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            start_ms: { type: "INTEGER" },
            end_ms: { type: "INTEGER" },
            speaker_id: { type: "STRING" },
            source_text: { type: "STRING" },
            translation: { type: "STRING" },
            confidence: { type: "NUMBER" },
            flags: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["start_ms", "end_ms", "source_text", "translation"],
        },
      },
    },
    required: ["source_language", "segments"],
  };

  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`);
  url.searchParams.set("key", env.GEMINI_API_KEY);
  const prompt = `完整观看并听取这个视频。逐句转录所有有意义的人声，并翻译成自然、适合中文配音和中文字幕的简体中文。\n要求：\n1. 按说话自然断句，每段通常 1~12 秒；不要漏掉重要台词。\n2. start_ms/end_ms 必须是相对于视频开头的毫秒时间戳，且 end_ms > start_ms。\n3. source_text 保留原语言；translation 只写简体中文译文。\n4. 尽量识别说话人并用 speaker_id（如 speaker_1）；无法判断可留空。\n5. confidence 为 0~1；听不清、重叠语音、专名存疑等写入 flags。\n6. 不要输出旁白式总结，不要把纯画面描述当作台词。`;

  const result = await geminiJson(env, url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { file_data: { mime_type: file.mimeType, file_uri: file.uri } },
        { text: prompt },
      ] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
    }),
  });
  const text = result?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no transcription");
  const parsed = JSON.parse(text) as { segments?: VideoTranslationSegment[] };
  const segments = (parsed.segments || [])
    .filter(s => Number.isFinite(s.start_ms) && Number.isFinite(s.end_ms) && s.end_ms > s.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms);
  if (!segments.length) throw new Error("Gemini returned zero subtitle segments");
  return { fileName: file.name, fileUri: file.uri, segments };
}
