import { askOpenAI } from "./openaiClient.js";
import { safeParseJson } from "./jsonUtils.js";

export async function executeDevelopmentTask({ project, task, existingFiles }) {
  const previewFiles = (existingFiles || []).map(file => ({
    path: file.path,
    preview: typeof file.content === "string" ? file.content.slice(0, 2000) : ""
  }));

  const raw = await askOpenAI({
    role: "developer",
    projectId: project.id,
    taskId: task.id,
    json: true,
    system:
      "You are an expert full-stack developer. Return strict JSON only. Always produce complete, runnable file contents.",
    user: `
Project goal:
${project.goal}

Plan:
${JSON.stringify(project.plan)}

Task:
${task.title}
${task.description}

Existing files (path + preview):
${JSON.stringify(previewFiles)}

Return JSON of the form:
{
  "summary": "...",
  "files": [ { "path": "relative/path", "content": "complete file content" } ],
  "commandsToRun": ["npm install", "npm run build"],
  "needsSmokeTest": true,
  "notes": ["..."]
}

Rules:
- Return complete files only. No diffs, no partial files.
- Prefer Vite + React for MVP builds, with index.html, vite.config.js, src/main.jsx, src/App.jsx, package.json.
- Always include package.json when commands are needed.
- Use only safe npm commands (install, ci, run build, test, run lint, vite host).
- Never include secrets, API keys, .env files, or credentials.
- If the project is a static site only, set "needsSmokeTest": true and provide an index.html.
- Keep files small and modular.
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.files)) {
    throw new Error("Developer agent did not return a valid file list.");
  }
  // Filter clearly invalid entries.
  parsed.files = parsed.files.filter(f => f && typeof f.path === "string" && typeof f.content === "string");
  parsed.commandsToRun = Array.isArray(parsed.commandsToRun) ? parsed.commandsToRun : [];
  return parsed;
}
