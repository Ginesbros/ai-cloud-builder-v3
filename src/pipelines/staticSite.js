/**
 * static_site pipeline — Plain HTML/CSS/JS landing page.
 *
 * No build step. Files are opened directly in a browser.
 * needsSmokeTest = true: orchestrator runs a static file server + Playwright check.
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return strict JSON only, no prose, no markdown fences.
{
  "projectName": "kebab-case-name",
  "summary": "One sentence description",
  "techStack": ["HTML5", "CSS3", "Vanilla JS"],
  "successCriteria": ["..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "setup|frontend|design|test|deploy",
      "priority": 1
    }
  ]
}

Rules:
- 5-8 tasks total.
- No Vite, no React, no build tools — pure HTML/CSS/JS only.
- Files must work when opened directly in a browser (file:// or a static server).
- Tasks must include: setup index.html, hero section, content sections, contact form, visual polish, smoke test / deploy.
- ALWAYS include a "design" task for visual polish.
- ALWAYS include a "deploy" task.
- Never include secrets or credentials.
`;

/**
 * Plan tasks for a static site.
 */
export async function planTasks({ project, goal, clarifications, projectId }) {
  const effectiveGoal = clarifications
    ? `${goal}\n\nAdditional clarifications:\n${clarifications}`
    : goal;

  const raw = await askOpenAI({
    role: "planner",
    projectId: projectId || project?.id || null,
    json: true,
    system:
      "You are a senior frontend developer specialising in plain HTML/CSS/JS static sites. Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

${PLAN_SCHEMA_HINT}
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("staticSite planner did not return a valid plan JSON.");
  }

  // Clamp task count.
  parsed.tasks = parsed.tasks.slice(0, 8);
  return parsed;
}

/**
 * Execute a single static-site task.
 *
 * Instructs the LLM to produce plain HTML/CSS/JS — no bundlers, no frameworks.
 */
export async function executeTask({ project, task, existingFiles }) {
  const previewFiles = (existingFiles || []).map(f => ({
    path: f.path,
    preview: typeof f.content === "string" ? f.content.slice(0, 2000) : ""
  }));

  const raw = await askOpenAI({
    role: "developer",
    taskType: task.type || "frontend",
    projectId: project?.id || null,
    json: true,
    system: `You are an expert frontend developer building a plain HTML/CSS/JS static site.
IMPORTANT RULES:
- No Vite, no React, no npm, no build step — just index.html, styles.css, and optionally script.js.
- All files must work when opened directly in a browser or served by any static file server.
- Use semantic HTML5, modern CSS (flexbox/grid), and vanilla JS only.
- Return strict JSON only.`,
    user: `
Project goal:
${project?.goal || ""}

Plan:
${JSON.stringify(project?.plan || {})}

Task:
${task.title}
${task.description}

Existing files (path + preview):
${JSON.stringify(previewFiles)}

Return JSON of the form:
{
  "summary": "...",
  "files": [ { "path": "relative/path", "content": "complete file content" } ],
  "commandsToRun": [],
  "needsSmokeTest": true,
  "notes": ["..."]
}

Rules:
- Complete files only — no diffs, no partial files.
- Entry point must be index.html at the root.
- Include styles.css at the root.
- If JavaScript is needed, include script.js at the root (no modules — use a plain <script> tag).
- commandsToRun must always be an empty array (no build step).
- needsSmokeTest must always be true.
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.files)) {
    throw new Error("staticSite developer agent did not return a valid file list.");
  }

  parsed.files = parsed.files.filter(
    f => f && typeof f.path === "string" && typeof f.content === "string"
  );

  return {
    summary: parsed.summary || "",
    files: parsed.files,
    commandsToRun: [],
    needsSmokeTest: true,
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    deliverables: []
  };
}
