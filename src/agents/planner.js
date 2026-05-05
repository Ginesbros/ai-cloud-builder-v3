import { askOpenAI } from "./openaiClient.js";
import { askClaude } from "./claudeClient.js";
import { askPerplexity } from "./perplexityClient.js";
import { digestDocs } from "./notebookLmClient.js";
import { getProviderForRole } from "./modelRouter.js";
import { safeParseJson } from "./jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return JSON of the form:
{
  "projectName": "kebab-case-name",
  "summary": "...",
  "techStack": ["..."],
  "successCriteria": ["..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "setup|frontend|backend|database|integration|test|design|video|docs|specialist|review|deploy",
      "priority": 1
    }
  ]
}

Rules for tasks:
- 6-14 tasks total. Keep each one small and verifiable.
- ALWAYS include at least one "design" task if the project is user-facing
  (it generates logos/hero imagery via Nano Banana).
- ALWAYS include a "test" task and a "deploy" task.
- Use "specialist" only when a task realistically takes more than 30 minutes
  of autonomous work (Manus handles those).
- Use "video" only when the user explicitly asks for a demo/marketing video.
- Use "docs" only when the user attaches reference PDFs.
- Never include secrets, API keys, or credentials.
`;

export async function createPlan({ goal, projectId = null, attachedDocs = [] }) {
  // Researcher: live web context.
  const research = await askPerplexity(
    `Research implementation approach, recommended packages, breaking-change risks, and smoke-test ideas for: ${goal}`,
    { projectId }
  );

  // Librarian: optional doc digest.
  const docContext =
    attachedDocs && attachedDocs.length
      ? await digestDocs({ docs: attachedDocs, projectId })
      : "";

  const provider = getProviderForRole("planner");
  const system =
    "You are a senior software architect. You break a goal into a concrete plan and small executable tasks. Return strict JSON only.";
  const user = `
Goal:
${goal}

Live research:
${research}

${docContext ? `Reference docs digest:\n${docContext}\n` : ""}

${PLAN_SCHEMA_HINT}
`;

  let raw;
  if (provider === "anthropic") {
    raw = await askClaude({
      role: "planner",
      projectId,
      json: true,
      system,
      user,
      maxTokens: 8192
    });
  } else {
    raw = await askOpenAI({
      role: "planner",
      projectId,
      json: true,
      system,
      user
    });
  }

  let parsed = safeParseJson(raw, null);

  // If the primary provider returned malformed JSON, fall back to OpenAI once.
  if (!parsed || !Array.isArray(parsed.tasks)) {
    if (provider !== "openai") {
      const fallback = await askOpenAI({
        role: "planner",
        projectId,
        json: true,
        system,
        user
      });
      parsed = safeParseJson(fallback, null);
    }
  }

  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("Planner did not return a valid plan JSON.");
  }
  return parsed;
}
