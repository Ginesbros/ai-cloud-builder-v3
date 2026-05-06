import axios from "axios";
import { recordAiUsage } from "../services/budget.js";
import { getModelForProvider } from "./modelRouter.js";

const API = "https://api.anthropic.com/v1/messages";

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function pickModel(role) {
  // Always resolve through the Anthropic-only model map.
  if (role === "planner") return getModelForProvider("anthropic", "planner");
  if (role === "reviewer_claude") return getModelForProvider("anthropic", "reviewer");
  return getModelForProvider("anthropic", "reviewer");
}

/**
 * Generic Claude call.
 *  - `system`/`user` strings.
 *  - `json` mode appends a JSON-only instruction (Anthropic doesn't have a
 *    response_format flag, but Claude obeys clear JSON-only instructions well).
 */
export async function askClaude({
  role = "reviewer",
  system,
  user,
  json = false,
  projectId = null,
  taskId = null,
  maxTokens = 4096
}) {
  if (!isConfigured()) {
    return json
      ? JSON.stringify({ summary: "Claude not configured.", notes: [] })
      : "Claude not configured.";
  }

  const model = pickModel(role);
  const finalSystem = json
    ? `${system}\n\nReturn STRICT JSON only. No prose, no markdown fences.`
    : system;

  try {
    const response = await axios.post(
      API,
      {
        model,
        max_tokens: maxTokens,
        system: finalSystem,
        messages: [{ role: "user", content: user }]
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        timeout: 120000
      }
    );

    const text = response.data.content?.[0]?.text || "";

    // Record usage. Anthropic returns input_tokens / output_tokens.
    const usage = response.data.usage || {};
    await recordAiUsage({
      projectId,
      taskId,
      role,
      model,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0
    }).catch(() => null);

    return text;
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || "unknown error";
    return `Claude call failed: ${msg}`;
  }
}
