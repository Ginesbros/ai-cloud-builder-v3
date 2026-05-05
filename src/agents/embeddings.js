/**
 * Embedding helper — turns text into a 1536-dim vector for component search.
 * Uses OpenAI's text-embedding-3-small (cheap and good for code/UI matching).
 */

import { openai } from "./openaiClient.js";
import { recordAiUsage } from "../services/budget.js";

const EMBED_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

/**
 * Embed a single string. Returns a number[] of length 1536.
 * Fails open: returns null if OpenAI is unreachable, so the caller can
 * gracefully fall back to no-match-found rather than crash.
 */
export async function embedText(text, { projectId = null, taskId = null } = {}) {
  if (!text || typeof text !== "string") return null;
  try {
    const response = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: text.slice(0, 8000) // safety cap
    });
    const vector = response.data?.[0]?.embedding;
    if (!Array.isArray(vector)) return null;

    await recordAiUsage({
      projectId,
      taskId,
      role: "embedding",
      model: EMBED_MODEL,
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: 0
    }).catch(() => null);

    return vector;
  } catch (err) {
    console.warn("embedText failed:", err?.message || err);
    return null;
  }
}
