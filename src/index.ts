import type { Env, PipelineMessage } from "./types";
import { generateProjectTts, getPipelineArtifacts, processProject } from "./pipeline";
export { ProjectJob } from "./project-job";

function json(data: unknown, status = 200): Response { return Response.json(data, { status }); }
function objectName(filename: string): string { return filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-180) || "source.bin"; }
function projectStub(env: Env, projectId: string): DurableObjectStub { return env.PROJECT_JOBS.get(env.PROJECT_JOBS.idFromName(projectId)); }

async function getProject(env: Env, projectId: string): Promise<any | null> {
  return env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
}

async function handleProjectMedia(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/media$/);
  if (request.method !== "GET" || !match) return null;
  const projectId = decodeURIComponent(match[1]);
  const target = url.searchParams.get("target");
  if (target !== "source" && target !== "output") return json({ error: "target must be source or output" }, 400);
  const project = await env.DB.prepare("SELECT source_key, output_key FROM projects WHERE id = ?").bind(projectId).first<{ source_key: string | null; output_key: string | null }>();
  if (!project) return json({ error: "Project not found" }, 404);
  const key = target === "source" ? project.source_key : project.output_key;
  if (!key) return json({ error: `${target} media is not available` }, 404);
  if (!key.startsWith(`projects/${projectId}/`)) return json({ error: "Invalid media key" }, 400);
  const object = await env.MEDIA.get(key, { range: request.headers });
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers(); object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag); headers.set("accept-ranges", "bytes"); headers.set("cache-control", "private, max-age=60");
  if (object.range) {
    const range = object.range; const offset = "offset" in range ? range.offset : 0; const length = "length" in range ? range.length : object.size;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`); headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

async function dispatchRender(env: Env, projectId: string, body: { subtitleKey?: string; dubAudioKey?: string; dubManifestKey?: string }): Promise<Response> {
  const project = await getProject(env, projectId) as any;
  if (!project?.source_key) return json({ error: "Project has no source video" }, 409);
  const artifacts = getPipelineArtifacts(project.metadata_json);
  const subtitleKey = body.subtitleKey || artifacts.subtitleKey;
  const dubManifestKey = body.dubManifestKey || artifacts.dubManifestKey;
  const dubAudioKey = body.dubAudioKey;
  const outputKey = `projects/${projectId}/output/final.mp4`;

  if (!subtitleKey && !dubManifestKey && !dubAudioKey) {
    await env.DB.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?").bind("RENDERING", Date.now(), projectId).run();
    try {
      const source = await env.MEDIA.get(project.source_key);
      if (!source) return json({ error: "Source media is missing from R2" }, 404);
      const output = await env.MEDIA.put(outputKey, source.body, { httpMetadata: source.httpMetadata, customMetadata: { projectId, renderMode: "r2-stream-copy" } });
      await env.DB.prepare("UPDATE projects SET stage = ?, output_key = ?, updated_at = ? WHERE id = ?").bind("WAITING_FINAL_REVIEW", outputKey, Date.now(), projectId).run();
      return json({ ok: true, stage: "WAITING_FINAL_REVIEW", outputKey, bytes: output.size, mode: "r2-stream-copy" }, 201);
    } catch (error) {
      await env.DB.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?").bind("FAILED", Date.now(), projectId).run();
      throw error;
    }
  }

  for (const key of [subtitleKey, dubManifestKey, dubAudioKey].filter(Boolean) as string[]) {
    if (!key.startsWith(`projects/${projectId}/`)) return json({ error: "Render artifact is outside this project" }, 400);
  }
  await env.DB.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?").bind("RENDER_QUEUED", Date.now(), projectId).run();
  const response = await projectStub(env, projectId).fetch("https://project/render/start", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceKey: project.source_key, outputKey, subtitleKey, dubAudioKey, dubManifestKey }),
  });
  if (!response.ok) {
    const error = await response.text();
    await env.DB.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?").bind("FAILED", Date.now(), projectId).run();
    return json({ error: `Render dispatch failed: ${error}` }, 500);
  }
  return json({ ok: true, stage: "RENDERING", outputKey }, 202);
}

async function handleProjectApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/projects") {
    const result = await env.DB.prepare("SELECT id, title, stage, source_key, output_key, metadata_json, created_at, updated_at FROM projects ORDER BY updated_at DESC LIMIT 100").all();
    return json({ projects: result.results });
  }
  if (request.method === "POST" && url.pathname === "/api/projects") {
    const body = await request.json().catch(() => ({})) as { title?: string };
    const id = crypto.randomUUID(), now = Date.now();
    await env.DB.prepare("INSERT INTO projects (id, title, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, body.title?.trim() || "Untitled project", "CREATED", now, now).run();
    await projectStub(env, id).fetch("https://project/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: id }) });
    return json({ id, stage: "CREATED" }, 201);
  }

  const media = await handleProjectMedia(request, env, url); if (media) return media;

  const segmentsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/segments$/);
  if (request.method === "GET" && segmentsMatch) {
    const projectId = decodeURIComponent(segmentsMatch[1]);
    const result = await env.DB.prepare("SELECT * FROM segments WHERE project_id = ? ORDER BY seq").bind(projectId).all();
    return json({ segments: result.results });
  }
  const segmentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/segments\/([^/]+)$/);
  if (request.method === "PATCH" && segmentMatch) {
    const projectId = decodeURIComponent(segmentMatch[1]), segmentId = decodeURIComponent(segmentMatch[2]);
    const body = await request.json() as { finalTranslation?: string; speakerId?: string; status?: string };
    const existing = await env.DB.prepare("SELECT id FROM segments WHERE id = ? AND project_id = ?").bind(segmentId, projectId).first();
    if (!existing) return json({ error: "Segment not found" }, 404);
    await env.DB.prepare(`UPDATE segments SET final_translation = COALESCE(?, final_translation), speaker_id = COALESCE(?, speaker_id), status = COALESCE(?, status), updated_at = ? WHERE id = ? AND project_id = ?`)
      .bind(body.finalTranslation ?? null, body.speakerId ?? null, body.status ?? null, Date.now(), segmentId, projectId).run();
    return json({ ok: true });
  }

  const retryProcess = url.pathname.match(/^\/api\/projects\/([^/]+)\/process$/);
  if (request.method === "POST" && retryProcess) {
    const projectId = decodeURIComponent(retryProcess[1]); const project = await getProject(env, projectId) as any;
    if (!project?.source_key) return json({ error: "Project has no source video" }, 409);
    await env.DB.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?").bind("TRANSCRIBING", Date.now(), projectId).run();
    await env.PIPELINE_QUEUE.send({ type: "process", projectId, sourceKey: project.source_key });
    return json({ ok: true, stage: "TRANSCRIBING" }, 202);
  }

  const approveTranslation = url.pathname.match(/^\/api\/projects\/([^/]+)\/translation\/approve$/);
  if (request.method === "POST" && approveTranslation) {
    const projectId = decodeURIComponent(approveTranslation[1]);
    const body = await request.json().catch(() => ({})) as { voice?: string };
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM segments WHERE project_id = ?").bind(projectId).first<{n:number}>();
    if (!count?.n) return json({ error: "No subtitle segments to approve" }, 409);
    await env.DB.prepare("UPDATE segments SET final_translation = COALESCE(NULLIF(final_translation,''), ai_translation), status = 'approved', updated_at = ? WHERE project_id = ?")
      .bind(Date.now(), projectId).run();
    await env.DB.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?").bind("TTS_GENERATING", Date.now(), projectId).run();
    await env.PIPELINE_QUEUE.send({ type: "tts", projectId, voice: body.voice || "冰糖" });
    return json({ ok: true, stage: "TTS_GENERATING" }, 202);
  }

  const approveDub = url.pathname.match(/^\/api\/projects\/([^/]+)\/dub\/approve$/);
  if (request.method === "POST" && approveDub) return dispatchRender(env, decodeURIComponent(approveDub[1]), {});

  const complete = url.pathname.match(/^\/api\/projects\/([^/]+)\/complete$/);
  if (request.method === "POST" && complete) {
    const projectId = decodeURIComponent(complete[1]);
    await env.DB.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?").bind("COMPLETED", Date.now(), projectId).run();
    return json({ ok: true, stage: "COMPLETED" });
  }

  const initUpload = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/init$/);
  if (request.method === "POST" && initUpload) {
    const projectId = decodeURIComponent(initUpload[1]); const body = await request.json() as { filename: string; contentType?: string };
    if (!await getProject(env, projectId)) return json({ error: "Project not found" }, 404);
    const key = `projects/${projectId}/source/${objectName(body.filename)}`;
    const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: body.contentType || "application/octet-stream" }, customMetadata: { projectId } });
    await env.DB.prepare("UPDATE projects SET stage = ?, source_key = ?, output_key = NULL, updated_at = ? WHERE id = ?").bind("UPLOADING", key, Date.now(), projectId).run();
    return json({ provider: "r2", key, uploadId: upload.uploadId }, 201);
  }
  const uploadPart = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/part$/);
  if (request.method === "PUT" && uploadPart) {
    const projectId = decodeURIComponent(uploadPart[1]), key = url.searchParams.get("key"), uploadId = url.searchParams.get("uploadId"), partNumber = Number(url.searchParams.get("partNumber"));
    if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || !request.body) return json({ error: "Invalid multipart upload parameters" }, 400);
    if (!key.startsWith(`projects/${projectId}/`)) return json({ error: "Upload key is outside this project" }, 400);
    const part = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }
  const abortUpload = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/abort$/);
  if (request.method === "POST" && abortUpload) {
    const projectId = decodeURIComponent(abortUpload[1]); const body = await request.json() as { key: string; uploadId: string };
    if (!body.key?.startsWith(`projects/${projectId}/`) || !body.uploadId) return json({ error: "Invalid multipart upload parameters" }, 400);
    await env.MEDIA.resumeMultipartUpload(body.key, body.uploadId).abort();
    await env.DB.prepare("UPDATE projects SET stage = ?, source_key = NULL, updated_at = ? WHERE id = ?").bind("CREATED", Date.now(), projectId).run();
    return json({ ok: true });
  }
  const completeUpload = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/complete$/);
  if (request.method === "POST" && completeUpload) {
    const projectId = decodeURIComponent(completeUpload[1]); const body = await request.json() as { key: string; uploadId: string; parts: Array<{partNumber:number;etag:string}> };
    if (!body.key?.startsWith(`projects/${projectId}/`)) return json({ error: "Upload key is outside this project" }, 400);
    await env.MEDIA.resumeMultipartUpload(body.key, body.uploadId).complete(body.parts);
    await env.DB.prepare("DELETE FROM segments WHERE project_id = ?").bind(projectId).run();
    await env.DB.prepare("UPDATE projects SET stage = ?, source_key = ?, output_key = NULL, updated_at = ? WHERE id = ?").bind("UPLOADED", body.key, Date.now(), projectId).run();
    await env.PIPELINE_QUEUE.send({ type: "probe", projectId, sourceKey: body.key });
    return json({ ok: true, provider: "r2", key: body.key });
  }

  const render = url.pathname.match(/^\/api\/projects\/([^/]+)\/render$/);
  if (request.method === "POST" && render) {
    const body = await request.json().catch(() => ({})) as { subtitleKey?: string; dubAudioKey?: string; dubManifestKey?: string };
    return dispatchRender(env, decodeURIComponent(render[1]), body);
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (request.method === "GET" && projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]); const row = await getProject(env, projectId);
    if (!row) return json({ error: "Project not found" }, 404);
    const runtimeResponse = await projectStub(env, projectId).fetch("https://project/state");
    const runtime = runtimeResponse.ok ? await runtimeResponse.json() : null;
    return json({ project: row, runtime });
  }
  return null;
}

async function handleInternalMedia(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = request.headers.get("authorization");
  if (!env.INTERNAL_MEDIA_TOKEN || auth !== `Bearer ${env.INTERNAL_MEDIA_TOKEN}`) return json({ error: "Unauthorized" }, 401);
  const key = url.searchParams.get("key"); if (!key || !key.startsWith("projects/")) return json({ error: "Invalid key" }, 400);
  if (request.method === "GET") {
    const object = await env.MEDIA.get(key, { range: request.headers }); if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); headers.set("accept-ranges", "bytes");
    if (object.range) { const r = object.range, offset = "offset" in r ? r.offset : 0, length = "length" in r ? r.length : object.size; headers.set("content-range", `bytes ${offset}-${offset+length-1}/${object.size}`); headers.set("content-length", String(length)); return new Response(object.body, { status:206, headers }); }
    headers.set("content-length", String(object.size)); return new Response(object.body, { headers });
  }
  if (request.method === "PUT") {
    if (!request.body) return json({ error: "Missing body" }, 400);
    const object = await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" } });
    return json({ key, etag: object.httpEtag, size: object.size }, 201);
  }
  return new Response("Method not allowed", { status: 405 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, service: "autovideotranslate", storage: "r2", pipeline: "gemini+mimo+ffmpeg" });
    if (url.pathname === "/api/internal/media") return handleInternalMedia(request, env, url);
    const projectResponse = await handleProjectApi(request, env, url); if (projectResponse) return projectResponse;
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.type === "probe") {
          const response = await projectStub(env, job.projectId).fetch("https://project/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceKey: job.sourceKey }) });
          if (!response.ok) throw new Error(await response.text());
          await env.PIPELINE_QUEUE.send({ type: "process", projectId: job.projectId, sourceKey: job.sourceKey });
        } else if (job.type === "process") {
          await processProject(env, job.projectId, job.sourceKey);
        } else if (job.type === "tts") {
          await generateProjectTts(env, job.projectId, job.voice || "冰糖");
        } else if (job.type === "render") {
          const response = await projectStub(env, job.projectId).fetch("https://project/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
          if (!response.ok) throw new Error(await response.text());
        }
        message.ack();
      } catch (error) {
        console.error("pipeline job failed", job.type, job.projectId, error);
        await env.DB.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?").bind("FAILED", Date.now(), job.projectId).run().catch(() => {});
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env, PipelineMessage>;
