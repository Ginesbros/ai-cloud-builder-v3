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
  const model = modelOverride || getModelForRole(role, taskType);

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
