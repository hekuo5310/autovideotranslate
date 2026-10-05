export type ProjectStage =
  | "CREATED" | "UPLOADING" | "UPLOADED" | "ANALYZING"
  | "TRANSCRIBING" | "TRANSLATING" | "AI_QA"
  | "WAITING_TRANSLATION_REVIEW" | "TTS_GENERATING" | "TTS_QA"
  | "WAITING_DUB_REVIEW" | "RENDER_QUEUED" | "RENDERING"
  | "WAITING_FINAL_REVIEW" | "COMPLETED" | "FAILED";

export interface ProjectRuntimeState {
  projectId: string;
  stage: ProjectStage;
  progress: number;
  attempt: number;
  sourceKey?: string;
  outputKey?: string;
  error?: string;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export type PipelineMessage =
  | { type: "probe"; projectId: string; sourceKey: string }
  | { type: "process"; projectId: string; sourceKey: string }
  | { type: "tts"; projectId: string; voice?: string }
  | {
      type: "render";
      projectId: string;
      sourceKey: string;
      outputKey: string;
      subtitleKey?: string;
      dubAudioKey?: string;
      dubManifestKey?: string;
    };

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  PIPELINE_QUEUE: Queue<PipelineMessage>;
  PROJECT_JOBS: DurableObjectNamespace;
  ASSETS: Fetcher;

  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;

  MIMO_API_KEY: string;
  MIMO_BASE_URL: string;
  MIMO_TTS_MODEL: string;

  INTERNAL_MEDIA_TOKEN: string;
  APP_ORIGIN: string;
}
