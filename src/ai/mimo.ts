import type { Env } from "../types";

export interface MimoTtsInput {
  text: string;
  voice: string;
  context?: string;
}

export async function synthesizeMimoTts(
  env: Env,
  input: MimoTtsInput,
): Promise<ArrayBuffer> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (input.context?.trim()) {
    messages.push({ role: "user", content: input.context.trim() });
  }
  messages.push({ role: "assistant", content: input.text });

  const response = await fetch(`${env.MIMO_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.MIMO_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.MIMO_TTS_MODEL,
      messages,
      audio: {
        format: "wav",
        voice: input.voice,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`MiMo TTS failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as any;
  const base64 = body?.choices?.[0]?.message?.audio?.data;
  if (!base64) throw new Error("MiMo TTS returned no audio data");

  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return bytes.buffer;
}
