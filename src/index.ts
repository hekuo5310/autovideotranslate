import type { Env, PipelineMessage } from "./types";
import {
  assertProjectItem,
  createUploadSession,
  projectPath,
} from "./storage/onedrive";

export { ProjectJob } from "./project-job";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function objectName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-180) || "source.bin";
}

function projectStub(env: Env, projectId: string): DurableObjectStub {
  return env.PROJECT_JOBS.get(env.PROJECT_JOBS.idFromName(projectId));
}

async function handleProjectApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/api/projects") {
    const body = (await request.json().catch(() => ({}))) as { title?: string };
    const id = crypto.randomUUID();
    const now = Date.now();

    await env.DB.prepare(
      "INSERT INTO projects (id, title, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, body.title?.trim() || "Untitled project", "CREATED", now, now)
      .run();

    await projectStub(env, id).fetch("https://project/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: id }),
    });

    return json({ id, stage: "CREATED" }, 201);
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (request.method === "GET" && match) {
    const projectId = decodeURIComponent(match[1]);
    const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?")
      .bind(projectId)
      .first();

    if (!row) return json({ error: "Project not found" }, 404);

    const runtimeResponse = await projectStub(env, projectId).fetch("https://project/state");
    const runtime = runtimeResponse.ok ? await runtimeResponse.json() : null;
    return json({ project: row, runtime });
  }

  const initUpload = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/init$/);
  if (request.method === "POST" && initUpload) {
    const projectId = decodeURIComponent(initUpload[1]);
    const body = (await request.json()) as {
      filename: string;
      contentType?: string;
    };

    const path = projectPath(env, projectId, `source/${objectName(body.filename)}`);
    const session = await createUploadSession(env, path, "replace");

    await env.DB.prepare(
      "UPDATE projects SET stage = ?, source_key = NULL, updated_at = ? WHERE id = ?",
    )
      .bind("UPLOADING", Date.now(), projectId)
      .run();

    return json(
      {
        provider: "onedrive",
        uploadUrl: session.uploadUrl,
        expirationDateTime: session.expirationDateTime,
        path,
      },
      201,
    );
  }

  const completeUpload = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/complete$/);
  if (request.method === "POST" && completeUpload) {
    const projectId = decodeURIComponent(completeUpload[1]);
    const body = (await request.json()) as { itemId: string };

    const item = await assertProjectItem(env, projectId, body.itemId);

    await env.DB.prepare(
      "UPDATE projects SET stage = ?, source_key = ?, updated_at = ? WHERE id = ?",
    )
      .bind("UPLOADED", item.id, Date.now(), projectId)
      .run();

    await env.PIPELINE_QUEUE.send({
      type: "probe",
      projectId,
      sourceKey: item.id,
    });

    return json({
      ok: true,
      provider: "onedrive",
      item: {
        id: item.id,
        name: item.name,
        size: item.size,
        webUrl: item.webUrl,
      },
    });
  }

  const render = url.pathname.match(/^\/api\/projects\/([^/]+)\/render$/);
  if (request.method === "POST" && render) {
    const projectId = decodeURIComponent(render[1]);
    const body = (await request.json().catch(() => ({}))) as {
      subtitleKey?: string;
      dubAudioKey?: string;
    };

    const project = await env.DB.prepare("SELECT source_key FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ source_key: string | null }>();

    if (!project?.source_key) {
      return json({ error: "Project has no source video" }, 409);
    }

    const outputPath = projectPath(env, projectId, "output/final.mp4");

    await env.DB.prepare("UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?")
      .bind("RENDER_QUEUED", Date.now(), projectId)
      .run();

    await env.PIPELINE_QUEUE.send({
      type: "render",
      projectId,
      sourceKey: project.source_key,
      outputKey: outputPath,
      subtitleKey: body.subtitleKey,
      dubAudioKey: body.dubAudioKey,
    });

    return json({
      ok: true,
      stage: "RENDER_QUEUED",
      outputPath,
    }, 202);
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "autovideotranslate", storage: "onedrive" });
    }

    const projectResponse = await handleProjectApi(request, env, url);
    if (projectResponse) return projectResponse;

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const job = message.body;
        const stub = projectStub(env, job.projectId);

        if (job.type === "probe") {
          const response = await stub.fetch("https://project/probe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sourceKey: job.sourceKey }),
          });
          if (!response.ok) throw new Error(await response.text());
        }

        if (job.type === "render") {
          const response = await stub.fetch("https://project/render", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(job),
          });
          if (!response.ok) throw new Error(await response.text());
        }

        message.ack();
      } catch (error) {
        console.error("pipeline job failed", error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, PipelineMessage>;
