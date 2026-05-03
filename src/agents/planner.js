import { askOpenAI } from "./openaiClient.js";
import { askPerplexity } from "./perplexityClient.js";

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

Return JSON:
{
  "projectName": "kebab-case-name",
  "summary": "...",
  "techStack": ["..."],
  "successCriteria": ["..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "setup|frontend|backend|test|review|deploy",
      "priority": 1
    }
  ]
}

Keep tasks small and executable.
Include smoke testing and deployment handoff tasks.
`
  });

  return JSON.parse(raw);
}
