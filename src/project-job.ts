import { DurableObject } from "cloudflare:workers";
import type { Env, ProjectRuntimeState } from "./types";

const STATE_KEY = "runtime";
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export class ProjectJob extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = (ctx as any).container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      });
    }
  }

  private async readState(): Promise<ProjectRuntimeState | null> {
    return (await this.ctx.storage.get<ProjectRuntimeState>(STATE_KEY)) ?? null;
  }

  private async writeState(patch: Partial<ProjectRuntimeState>): Promise<ProjectRuntimeState> {
    const current = (await this.readState()) ?? {
      projectId: "",
      stage: "CREATED",
      progress: 0,
      attempt: 0,
      updatedAt: Date.now(),
    };

    const next: ProjectRuntimeState = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    await this.ctx.storage.put(STATE_KEY, next);
    return next;
  }

  private mediaUrl(key: string): string {
    const url = new URL("/api/internal/media", this.env.APP_ORIGIN);
    url.searchParams.set("key", key);
    return url.toString();
  }

  private async ensureContainer(): Promise<any> {
    const container = (this.ctx as any).container;
    if (!container) throw new Error("No Container is configured for ProjectJob");

    if (!container.running) {
      container.start({ enableInternet: true });
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      this.ctx.waitUntil(
        container.monitor().catch(async (error: unknown) => {
          await this.writeState({
            stage: "FAILED",
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }

    const port = container.getTcpPort(8080);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await port.fetch("http://container/health");
        if (response.ok) return port;
      } catch {
        // Container start is asynchronous.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error("Media container did not become ready");
  }

  private async probe(sourceKey: string): Promise<Response> {
    const current = await this.readState();
    await this.writeState({
      stage: "ANALYZING",
      progress: 5,
      sourceKey,
      attempt: (current?.attempt ?? 0) + 1,
      error: undefined,
    });

    try {
      const port = await this.ensureContainer();
      const response = await port.fetch("http://container/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_url: this.mediaUrl(sourceKey),
          token: this.env.INTERNAL_MEDIA_TOKEN,
        }),
      });

      if (!response.ok) throw new Error(`Probe failed: ${await response.text()}`);

      const metadata = (await response.json()) as Record<string, unknown>;
      await this.env.DB.prepare(
        "UPDATE projects SET stage = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
      )
        .bind("UPLOADED", JSON.stringify(metadata), Date.now(), current?.projectId)
        .run();

      const state = await this.writeState({
        stage: "UPLOADED",
        progress: 100,
        metadata,
      });
      return json(state);
    } catch (error) {
      const state = await this.writeState({
        stage: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      return json(state, 500);
    }
  }

  private async render(input: {
    sourceKey: string;
    outputKey: string;
    subtitleKey?: string;
    dubAudioKey?: string;
  }): Promise<Response> {
    const current = await this.readState();
    if (!current?.projectId) return json({ error: "Project is not initialized" }, 409);

    await this.writeState({
      stage: "RENDERING",
      progress: 1,
      outputKey: input.outputKey,
      error: undefined,
    });

    try {
      const port = await this.ensureContainer();
      const response = await port.fetch("http://container/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_url: this.mediaUrl(input.sourceKey),
          output_url: this.mediaUrl(input.outputKey),
          subtitle_url: input.subtitleKey ? this.mediaUrl(input.subtitleKey) : undefined,
          dub_audio_url: input.dubAudioKey ? this.mediaUrl(input.dubAudioKey) : undefined,
          token: this.env.INTERNAL_MEDIA_TOKEN,
        }),
      });

      if (!response.ok) throw new Error(`Render failed: ${await response.text()}`);

      const result = await response.json();
      const state = await this.writeState({
        stage: "WAITING_FINAL_REVIEW",
        progress: 100,
        outputKey: input.outputKey,
        metadata: {
          ...(await this.readState())?.metadata,
          render: result,
        },
      });

      await this.env.DB.prepare(
        "UPDATE projects SET stage = ?, output_key = ?, updated_at = ? WHERE id = ?",
      )
        .bind("WAITING_FINAL_REVIEW", input.outputKey, Date.now(), state.projectId)
        .run();

      return json(state);
    } catch (error) {
      const state = await this.writeState({
        stage: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      return json(state, 500);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const body = (await request.json()) as { projectId: string };
      return json(
        await this.writeState({
          projectId: body.projectId,
          stage: "CREATED",
          progress: 0,
          attempt: 0,
          error: undefined,
        }),
        201,
      );
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const state = await this.readState();
      return state ? json(state) : json({ error: "Project state not initialized" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/probe") {
      const body = (await request.json()) as { sourceKey: string };
      return this.probe(body.sourceKey);
    }

    if (request.method === "POST" && url.pathname === "/render") {
      return this.render((await request.json()) as {
        sourceKey: string;
        outputKey: string;
        subtitleKey?: string;
        dubAudioKey?: string;
      });
    }

    return json({ error: "Not found" }, 404);
  }
}
