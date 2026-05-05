/**
 * backend_api pipeline — REST API scaffold.
 *
 * Defaults to Node.js + Express.
 * Switches to Python + FastAPI when the goal mentions Python/FastAPI.
 *
 * Smoke test: hits the /health endpoint.
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return strict JSON only, no prose, no markdown fences.
{
  "projectName": "kebab-case-name",
  "summary": "One sentence description",
  "techStack": ["Node.js", "Express", "..."],
  "successCriteria": ["GET /health returns 200", "..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "setup|backend|database|integration|test|deploy",
      "priority": 1
    }
  ]
}

Rules:
- 6-10 tasks total.
- Always start with a "setup" task (package.json / requirements.txt + project scaffold).
- Always include: route definitions, validation middleware, error handling, /health endpoint, tests, deploy task.
- If a database is mentioned, include a "database" task for schema + connection layer.
- Never include secrets, API keys, or credentials.
`;

function detectRuntime(goal) {
  const lower = (goal || "").toLowerCase();
  if (lower.includes("python") || lower.includes("fastapi") || lower.includes("flask") || lower.includes("django")) {
    return "python";
  }
  return "node";
}

/**
 * Plan tasks for a REST API project.
 */
export async function planTasks({ project, goal, clarifications, projectId }) {
  const effectiveGoal = clarifications
    ? `${goal}\n\nAdditional clarifications:\n${clarifications}`
    : goal;

  const runtime = detectRuntime(effectiveGoal);
  const runtimeNote =
    runtime === "python"
      ? "Use Python 3.11+ with FastAPI and uvicorn. Use pydantic for validation. Package file: requirements.txt."
      : "Use Node.js 20 LTS with Express 4. Use Zod or express-validator for validation. Package file: package.json.";

  const raw = await askOpenAI({
    role: "planner",
    projectId: projectId || project?.id || null,
    json: true,
    system:
      "You are a senior backend engineer. Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

Runtime preference: ${runtimeNote}

${PLAN_SCHEMA_HINT}
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("backendApi planner did not return a valid plan JSON.");
  }

  parsed.tasks = parsed.tasks.slice(0, 10);
  // Attach runtime metadata so executeTask can use it.
  parsed._runtime = runtime;
  return parsed;
}

/**
 * Execute a single backend API task.
 */
export async function executeTask({ project, task, existingFiles }) {
  const previewFiles = (existingFiles || []).map(f => ({
    path: f.path,
    preview: typeof f.content === "string" ? f.content.slice(0, 2000) : ""
  }));

  const runtime = project?.plan?._runtime || detectRuntime(project?.goal || "");
  const runtimeInstructions =
    runtime === "python"
      ? `Use Python 3.11+ with FastAPI. Entry point: main.py. Include requirements.txt.
Include a GET /health route that returns { "status": "ok" }.
Use uvicorn to run: uvicorn main:app --host 0.0.0.0 --port 8000`
      : `Use Node.js 20 with Express 4. Entry point: src/index.js or index.js. Include package.json with start/test scripts.
Include a GET /health route that returns { "status": "ok" }.
Use: npm install && npm start`;

  const raw = await askOpenAI({
    role: "developer",
    taskType: task.type || "backend",
    projectId: project?.id || null,
    json: true,
    system: `You are an expert backend engineer. Return strict JSON only. Always produce complete, runnable file contents.`,
    user: `
Project goal:
${project?.goal || ""}

Plan:
${JSON.stringify(project?.plan || {})}

Task:
${task.title}
${task.description}

Runtime instructions:
${runtimeInstructions}

Existing files (path + preview):
${JSON.stringify(previewFiles)}

Return JSON of the form:
{
  "summary": "...",
  "files": [ { "path": "relative/path", "content": "complete file content" } ],
  "commandsToRun": ["npm install", "npm test"],
  "needsSmokeTest": false,
  "notes": ["..."]
}

Rules:
- Return complete files only. No diffs, no partial files.
- Always include a /health GET route returning { "status": "ok" }.
- Always include package.json (Node) or requirements.txt (Python).
- Use only safe commands: npm install, npm ci, npm test, npm run build, npm start, pip install -r requirements.txt, pytest.
- Never include secrets, API keys, .env files, or credentials.
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.files)) {
    throw new Error("backendApi developer agent did not return a valid file list.");
  }

  parsed.files = parsed.files.filter(
    f => f && typeof f.path === "string" && typeof f.content === "string"
  );

  return {
    summary: parsed.summary || "",
    files: parsed.files,
    commandsToRun: Array.isArray(parsed.commandsToRun) ? parsed.commandsToRun : [],
    needsSmokeTest: false,
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    deliverables: []
  };
}
