import type { Env } from "./types";
import { generateStructuredText, transcribeAndTranslateVideo } from "./ai/gemini";
import { synthesizeMimoTts } from "./ai/mimo";

type SegmentRow = {
  id: string;
  project_id: string;
  seq: number;
  start_ms: number;
  end_ms: number;
  speaker_id: string | null;
  source_text: string | null;
  ai_translation: string | null;
  final_translation: string | null;
  confidence: number | null;
  flags_json: string | null;
  status: string;
};

type ProjectMeta = Record<string, any> & {
  pipeline?: {
    geminiFileName?: string;
    geminiFileUri?: string;
    subtitleKey?: string;
    dubManifestKey?: string;
    voice?: string;
    error?: string;
  };
};

function parseMeta(raw: string | null | undefined): ProjectMeta {
  if (!raw) return {};
  try { return JSON.parse(raw) as ProjectMeta; } catch { return {}; }
}

async function setProjectStage(env: Env, projectId: string, stage: string, error?: string) {
  const row = await env.DB.prepare("SELECT metadata_json FROM projects WHERE id = ?").bind(projectId).first<{metadata_json: string | null}>();
  const meta = parseMeta(row?.metadata_json);
  meta.pipeline = { ...(meta.pipeline || {}), error };
  await env.DB.prepare("UPDATE projects SET stage = ?, metadata_json = ?, updated_at = ? WHERE id = ?")
    .bind(stage, JSON.stringify(meta), Date.now(), projectId).run();
}

export async function processProject(env: Env, projectId: string, sourceKey: string): Promise<void> {
  await setProjectStage(env, projectId, "TRANSCRIBING");
  try {
    const source = await env.MEDIA.get(sourceKey);
    if (!source) throw new Error("Source video is missing from R2");
    const contentType = source.httpMetadata?.contentType || "video/mp4";

    const result = await transcribeAndTranslateVideo(env, source.body, source.size, contentType, `project-${projectId}.mp4`);
    await setProjectStage(env, projectId, "TRANSLATING");

    await env.DB.prepare("DELETE FROM segments WHERE project_id = ?").bind(projectId).run();
    const now = Date.now();
    for (let i = 0; i < result.segments.length; i++) {
      const s = result.segments[i];
      const id = crypto.randomUUID();
      const flags = Array.isArray(s.flags) ? s.flags : [];
      await env.DB.prepare(`INSERT INTO segments
        (id, project_id, seq, start_ms, end_ms, speaker_id, source_text, ai_translation, final_translation, confidence, flags_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          id, projectId, i + 1, Math.max(0, Math.round(s.start_ms)), Math.max(1, Math.round(s.end_ms)),
          s.speaker_id || null, s.source_text || "", s.translation || "", s.translation || "",
          typeof s.confidence === "number" ? s.confidence : null,
          JSON.stringify({ flags }), "pending", now, now,
        ).run();
    }

    await setProjectStage(env, projectId, "AI_QA");
    const qa = await runTranslationQa(env, result.segments);
    const project = await env.DB.prepare("SELECT metadata_json FROM projects WHERE id = ?").bind(projectId).first<{metadata_json: string | null}>();
    const meta = parseMeta(project?.metadata_json);
    meta.pipeline = {
      ...(meta.pipeline || {}),
      geminiFileName: result.fileName,
      geminiFileUri: result.fileUri,
      error: undefined,
    };
    (meta as any).translationQa = qa;
    await env.DB.prepare("UPDATE projects SET stage = ?, metadata_json = ?, updated_at = ? WHERE id = ?")
      .bind("WAITING_TRANSLATION_REVIEW", JSON.stringify(meta), Date.now(), projectId).run();
  } catch (error) {
    await setProjectStage(env, projectId, "FAILED", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function runTranslationQa(env: Env, segments: Array<any>): Promise<any> {
  const sample = segments.slice(0, 300).map((s, i) => ({
    seq: i + 1, source: s.source_text, translation: s.translation,
  }));
  return generateStructuredText(env,
    `你是视频字幕翻译质检员。检查下面字幕的中文翻译是否遗漏、错译、专有名词不一致或过度直译。只返回 JSON。\n${JSON.stringify(sample)}`,
    {
      type: "OBJECT",
      properties: {
        summary: { type: "STRING" },
        issues: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              seq: { type: "INTEGER" },
              severity: { type: "STRING" },
              reason: { type: "STRING" },
              suggestion: { type: "STRING" },
            },
            required: ["seq", "severity", "reason"],
          },
        },
      },
      required: ["summary", "issues"],
    });
}

function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(c).padStart(2,"0")}`;
}

function assEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\r?\n/g, "\\N");
}

function buildAss(segments: SegmentRow[]): string {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Noto Sans CJK SC,48,&H00FFFFFF,&H000000FF,&H00111111,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,90,90,55,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  return header + segments.map(s => `Dialogue: 0,${assTime(s.start_ms)},${assTime(s.end_ms)},Default,,0,0,0,,${assEscape(s.final_translation || s.ai_translation || "")}`).join("\n") + "\n";
}

function wavDurationMs(buffer: ArrayBuffer): number | null {
  try {
    const v = new DataView(buffer);
    if (v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) return null;
    let offset = 12, byteRate = 0, dataSize = 0;
    while (offset + 8 <= v.byteLength) {
      const id = v.getUint32(offset, false);
      const size = v.getUint32(offset + 4, true);
      if (id === 0x666d7420 && size >= 16) byteRate = v.getUint32(offset + 8 + 8, true);
      if (id === 0x64617461) { dataSize = size; break; }
      offset += 8 + size + (size % 2);
    }
    return byteRate && dataSize ? Math.round(dataSize / byteRate * 1000) : null;
  } catch { return null; }
}

async function maybeFitTranslation(env: Env, text: string, targetMs: number, actualMs: number): Promise<string> {
  const ratio = actualMs / Math.max(1, targetMs);
  if (ratio >= 0.88 && ratio <= 1.12) return text;
  if (ratio < 0.75 || ratio > 1.25) return text;
  const direction = ratio > 1 ? "压缩" : "适当扩写";
  const out = await generateStructuredText(env,
    `请${direction}下面中文配音台词，使自然朗读时长更接近 ${targetMs}ms。保持原意、口语自然，不添加解释。原台词：${text}`,
    { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] }) as any;
  return String(out?.text || text);
}

export async function generateProjectTts(env: Env, projectId: string, voice = "冰糖"): Promise<void> {
  await setProjectStage(env, projectId, "TTS_GENERATING");
  try {
    const rows = await env.DB.prepare("SELECT * FROM segments WHERE project_id = ? ORDER BY seq").bind(projectId).all<SegmentRow>();
    const segments = rows.results || [];
    if (!segments.length) throw new Error("No translated segments available");

    const manifest: Array<{ url: string; start_ms: number; end_ms: number; target_ms: number }> = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      let text = (s.final_translation || s.ai_translation || "").trim();
      if (!text) continue;
      const targetMs = Math.max(300, s.end_ms - s.start_ms);
      let audio = await synthesizeMimoTts(env, { text, voice });
      let duration = wavDurationMs(audio);
      if (duration && (duration / targetMs > 1.12 || duration / targetMs < 0.88) && duration / targetMs <= 1.25 && duration / targetMs >= 0.75) {
        const fitted = await maybeFitTranslation(env, text, targetMs, duration);
        if (fitted !== text) {
          text = fitted;
          audio = await synthesizeMimoTts(env, { text, voice });
          duration = wavDurationMs(audio);
          await env.DB.prepare("UPDATE segments SET final_translation = ?, updated_at = ? WHERE id = ?")
            .bind(text, Date.now(), s.id).run();
        }
      }
      const ttsKey = `projects/${projectId}/tts/${String(s.seq).padStart(5,"0")}.wav`;
      await env.MEDIA.put(ttsKey, audio, { httpMetadata: { contentType: "audio/wav" } });
      const flags = (() => { try { return JSON.parse(s.flags_json || "{}"); } catch { return {}; } })();
      flags.ttsKey = ttsKey;
      flags.ttsDurationMs = duration;
      flags.needsTimingReview = !!duration && (duration / targetMs > 1.25 || duration / targetMs < 0.75);
      await env.DB.prepare("UPDATE segments SET flags_json = ?, status = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(flags), flags.needsTimingReview ? "timing_review" : "dub_ready", Date.now(), s.id).run();
      const u = new URL("/api/internal/media", env.APP_ORIGIN);
      u.searchParams.set("key", ttsKey);
      manifest.push({ url: u.toString(), start_ms: s.start_ms, end_ms: s.end_ms, target_ms: targetMs });
    }

    await setProjectStage(env, projectId, "TTS_QA");
    const refreshed = await env.DB.prepare("SELECT * FROM segments WHERE project_id = ? ORDER BY seq").bind(projectId).all<SegmentRow>();
    const finalSegments = refreshed.results || [];
    const subtitleKey = `projects/${projectId}/subtitle/zh-CN.ass`;
    await env.MEDIA.put(subtitleKey, buildAss(finalSegments), { httpMetadata: { contentType: "text/x-ssa; charset=utf-8" } });
    const dubManifestKey = `projects/${projectId}/tts/manifest.json`;
    await env.MEDIA.put(dubManifestKey, JSON.stringify({ voice, segments: manifest }), { httpMetadata: { contentType: "application/json" } });

    const project = await env.DB.prepare("SELECT metadata_json FROM projects WHERE id = ?").bind(projectId).first<{metadata_json: string | null}>();
    const meta = parseMeta(project?.metadata_json);
    meta.pipeline = { ...(meta.pipeline || {}), subtitleKey, dubManifestKey, voice, error: undefined };
    await env.DB.prepare("UPDATE projects SET stage = ?, metadata_json = ?, updated_at = ? WHERE id = ?")
      .bind("WAITING_DUB_REVIEW", JSON.stringify(meta), Date.now(), projectId).run();
  } catch (error) {
    await setProjectStage(env, projectId, "FAILED", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function getPipelineArtifacts(metadataJson: string | null | undefined): { subtitleKey?: string; dubManifestKey?: string; voice?: string } {
  const meta = parseMeta(metadataJson);
  return meta.pipeline || {};
}
