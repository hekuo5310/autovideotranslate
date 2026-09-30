import type { Env } from "../types";

export async function generateStructuredText(
  env: Env,
  prompt: string,
  responseSchema?: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`,
  );
  url.searchParams.set("key", env.GEMINI_API_KEY);

  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
  };
  if (responseSchema) generationConfig.responseSchema = responseSchema;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as any;
  const text = body?.candidates?.[0]?.content?.parts
    ?.map((part: any) => part.text ?? "")
    .join("")
    .trim();

  if (!text) throw new Error("Gemini returned no text");
  return JSON.parse(text);
}
