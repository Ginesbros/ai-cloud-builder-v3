import OpenAI from "openai";
import { getModelForRole } from "./modelRouter.js";
import { recordAiUsage } from "../services/budget.js";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY");
}

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getUsage(response) {
  return {
    inputTokens:
      response.usage?.input_tokens ||
      response.usage?.prompt_tokens ||
      0,
    outputTokens:
      response.usage?.output_tokens ||
      response.usage?.completion_tokens ||
      0
  };
}

function extractText(response) {
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }
  const parts = response.output?.flatMap(item => item.content || []) || [];
  return parts
    .map(p => (typeof p === "string" ? p : p?.text || ""))
    .filter(Boolean)
    .join("");
}

// Defensive: only OpenAI-shaped model IDs are valid here. If the model router
// returns a Claude/Gemini/Grok ID by accident (e.g. PLANNER_MODEL points at
// Claude but the pipeline calls askOpenAI), we transparently fall back to a
// sensible OpenAI model so the build doesn't crash silently.
function coerceOpenAiModel(model, role) {
  if (!model || typeof model !== "string") return process.env.OPENAI_DEFAULT_MODEL || "gpt-4.1-mini";
  const m = model.toLowerCase();
  const isOpenAi = m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("chatgpt-");
  if (isOpenAi) return model;
  // Pick a fallback based on role.
  if (role === "planner") return process.env.OPENAI_PLANNER_FALLBACK || "gpt-4.1";
  if (role === "debugger") return process.env.OPENAI_DEBUGGER_MODEL || "gpt-4.1-mini";
  return process.env.OPENAI_DEFAULT_MODEL || "gpt-4.1-mini";
}

export async function askOpenAI({
  role = "developer",
  taskType = null,
  system,
  user,
  json = false,
  projectId = null,
  taskId = null,
  modelOverride = null
}) {
  const rawModel = modelOverride || getModelForRole(role, taskType);
  const model = coerceOpenAiModel(rawModel, role);

  const response = await openai.responses.create({
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    text: json ? { format: { type: "json_object" } } : undefined
  });

  const usage = getUsage(response);
  await recordAiUsage({
    projectId,
    taskId,
    role,
    model,
    ...usage
  }).catch(() => null);

  return extractText(response);
}
