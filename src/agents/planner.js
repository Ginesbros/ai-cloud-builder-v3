import { askOpenAI } from "./openaiClient.js";
import { askPerplexity } from "./perplexityClient.js";
import { safeParseJson } from "./jsonUtils.js";

export async function createPlan({ goal, projectId = null }) {
  const research = await askPerplexity(
    `Research implementation approach, risks, packages, and smoke tests for: ${goal}`,
    { projectId }
  );

  const raw = await askOpenAI({
    role: "planner",
    projectId,
    json: true,
    system: "You are a senior software architect. Return strict JSON only.",
    user: `
Goal:
${goal}

Research:
${research}

Return JSON of the form:
{
  "projectName": "kebab-case-name",
  "summary": "...",
  "techStack": ["..."],
  "successCriteria": ["..."],
  "tasks": [
    { "title": "...", "description": "...", "type": "setup|frontend|backend|test|review|deploy", "priority": 1 }
  ]
}

Rules:
- Keep tasks small and executable, 5-12 tasks total.
- Each task should have a clear, verifiable outcome.
- Always include a smoke testing task and a deployment handoff task.
- Prefer Vite + React for MVP web apps.
- Never include secrets, API keys, or sensitive data in tasks.
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("Planner did not return a valid plan JSON.");
  }
  return parsed;
}
