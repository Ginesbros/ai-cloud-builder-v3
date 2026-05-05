/**
 * script pipeline — One-off automation script.
 *
 * Language auto-detected from goal:
 *   - "python" / "py"  → Python 3
 *   - "bash" / "shell" / "sh" → Bash
 *   - default          → Node.js
 *
 * Smoke test: runs `node script.js --help` or `python script.py --help`.
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return strict JSON only, no prose, no markdown fences.
{
  "projectName": "kebab-case-name",
  "summary": "One sentence description",
  "techStack": ["Node.js"],
  "successCriteria": ["Script runs without errors", "..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "setup|backend|integration|test|docs",
      "priority": 1
    }
  ]
}

Rules:
- 4-7 tasks total.
- Always include: setup (entry-point file + package.json or requirements.txt), core logic, error handling / edge cases, README with run instructions.
- Include a "test" task if the script has testable units.
- Never include secrets, API keys, or credentials.
`;

function detectLanguage(goal) {
  const lower = (goal || "").toLowerCase();
  if (lower.includes("python") || lower.includes("py ") || lower.includes(".py")) {
    return "python";
  }
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("sh ") || lower.includes(".sh")) {
    return "bash";
  }
  return "node";
}

/**
 * Plan tasks for a script project.
 */
export async function planTasks({ project, goal, clarifications, projectId }) {
  const effectiveGoal = clarifications
    ? `${goal}\n\nAdditional clarifications:\n${clarifications}`
    : goal;

  const lang = detectLanguage(effectiveGoal);
  const langNote =
    lang === "python"
      ? "Write a Python 3 script. Entry point: script.py. Include requirements.txt if dependencies are needed."
      : lang === "bash"
      ? "Write a Bash script. Entry point: script.sh. Ensure the script is POSIX-compatible where possible."
      : "Write a Node.js script. Entry point: script.js. Include package.json with a start script.";

  const raw = await askOpenAI({
    role: "planner",
    projectId: projectId || project?.id || null,
    json: true,
    system: "You are a senior DevOps / scripting engineer. Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

Language: ${langNote}

${PLAN_SCHEMA_HINT}
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("script planner did not return a valid plan JSON.");
  }

  parsed.tasks = parsed.tasks.slice(0, 7);
  parsed._language = lang;
  return parsed;
}

/**
 * Execute a single script task.
 */
export async function executeTask({ project, task, existingFiles }) {
  const previewFiles = (existingFiles || []).map(f => ({
    path: f.path,
    preview: typeof f.content === "string" ? f.content.slice(0, 2000) : ""
  }));

  const lang = project?.plan?._language || detectLanguage(project?.goal || "");

  const langInstructions =
    lang === "python"
      ? `Entry point: script.py. Support a --help flag using argparse.
Allowed commands: ["pip install -r requirements.txt", "python script.py --help"]`
      : lang === "bash"
      ? `Entry point: script.sh. Add a --help / -h flag that prints usage.
Allowed commands: ["bash script.sh --help"]`
      : `Entry point: script.js. Support a --help flag (use process.argv or a CLI lib).
Allowed commands: ["npm install", "node script.js --help"]`;

  const smokeCmd =
    lang === "python"
      ? "python script.py --help"
      : lang === "bash"
      ? "bash script.sh --help"
      : "node script.js --help";

  const raw = await askOpenAI({
    role: "developer",
    taskType: task.type || "backend",
    projectId: project?.id || null,
    json: true,
    system: `You are an expert scripting engineer. Return strict JSON only. Always produce complete, runnable file contents.`,
    user: `
Project goal:
${project?.goal || ""}

Plan:
${JSON.stringify(project?.plan || {})}

Task:
${task.title}
${task.description}

Language instructions:
${langInstructions}

Smoke test command: ${smokeCmd}

Existing files (path + preview):
${JSON.stringify(previewFiles)}

Return JSON of the form:
{
  "summary": "...",
  "files": [ { "path": "relative/path", "content": "complete file content" } ],
  "commandsToRun": ["npm install"],
  "needsSmokeTest": true,
  "notes": ["Run: ${smokeCmd}", "..."]
}

Rules:
- Return complete files only. No diffs, no partial files.
- Always include a README.md with installation and usage instructions.
- Always include a --help flag in the main entry point.
- Use only safe, standard-library or common-package dependencies.
- Never include secrets, API keys, .env files, or credentials.
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.files)) {
    throw new Error("script developer agent did not return a valid file list.");
  }

  parsed.files = parsed.files.filter(
    f => f && typeof f.path === "string" && typeof f.content === "string"
  );

  return {
    summary: parsed.summary || "",
    files: parsed.files,
    commandsToRun: Array.isArray(parsed.commandsToRun) ? parsed.commandsToRun : [],
    needsSmokeTest: true,
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    deliverables: []
  };
}
