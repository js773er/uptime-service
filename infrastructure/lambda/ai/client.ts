import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

/**
 * Shared Anthropic client for the AI features.
 *
 * Both features are strictly additive: if the key is missing or a call fails,
 * the caller falls back to the plain HTTP verdict. Monitoring must never stop
 * working because an LLM was unavailable.
 */

let client: Anthropic | null = null;

export function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }
  client ??= new Anthropic({ apiKey });
  return client;
}

/** Overridable so the model can be changed without a code deploy. */
export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";

/**
 * Ask for a JSON object matching `jsonSchema`, then validate the reply with
 * `zodSchema` before trusting it. The API constrains the shape; Zod is the
 * boundary check — an LLM is an external service like any other.
 *
 * Returns null on any failure so callers can degrade instead of throwing.
 */
export async function askForJson<T>(input: {
  prompt: string;
  jsonSchema: Record<string, unknown>;
  zodSchema: z.ZodType<T>;
  maxTokens?: number;
}): Promise<T | null> {
  const anthropic = getClient();
  if (!anthropic) {
    return null;
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      // Thinking is on by default and counts against max_tokens, so leave
      // headroom even though the JSON payload itself is tiny.
      max_tokens: input.maxTokens ?? 4096,
      output_config: {
        // These are narrow classification calls, not open-ended reasoning.
        effort: "low",
        format: { type: "json_schema", schema: input.jsonSchema },
      },
      messages: [{ role: "user", content: input.prompt }],
    });

    if (response.stop_reason === "refusal") {
      console.warn("model declined the request");
      return null;
    }

    const text = response.content.find((block) => block.type === "text")?.text;
    if (!text) {
      return null;
    }

    const parsed = input.zodSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    console.error("model call failed:", err);
    return null;
  }
}
