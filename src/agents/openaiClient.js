import OpenAI from "openai";
import { getModelForRole } from "./modelRouter.js";
import { recordAiUsage } from "../services/budget.js";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY");
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function getUsage(response) {
  return {
    inputTokens: response.usage?.input_tokens || response.usage?.prompt_tokens || 0,
    outputTokens: response.usage?.output_tokens || response.usage?.completion_tokens || 0
  };
}

export async function askOpenAI({
  role = "developer",
  system,
  user,
  json = false,
  projectId = null,
  taskId = null
}) {
  const model = getModelForRole(role);

  const response = await openai.responses.create({
    model,
    input: [
      {
        role: "system",
        content: system
      },
      {
        role: "user",
        content: user
      }
    ],
    text: json
      ? {
          format: {
            type: "json_object"
          }
        }
      : undefined
  });

  const usage = getUsage(response);

  await recordAiUsage({
    projectId,
    taskId,
    role,
    model,
    ...usage
  }).catch(() => null);

  return response.output_text;
}
