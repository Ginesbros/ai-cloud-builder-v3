import { askOpenAI } from "./openaiClient.js";
import { safeParseJson } from "./jsonUtils.js";

/**
 * Build the "library guidance" prompt block based on a libraryMatch object.
 * This is what makes reuse cheap and fast — the developer LLM is given a
 * working past component to copy/adapt instead of generating from scratch.
 */
function libraryBlock(libraryMatch) {
  if (!libraryMatch || libraryMatch.decision === "fresh" || !libraryMatch.chosen) return "";

  const c = libraryMatch.chosen;
  const filesPreview = (c.files || []).map(f => ({
    path: f.path,
    content: f.content
  }));

  if (libraryMatch.decision === "reuse") {
    return `
**REUSE MODE** — A near-identical proven component exists in the library
(similarity ${Number(c.similarity).toFixed(2)}). Use it as-is, ONLY adjust:
- Business-specific names, services, copy, colors, contact details
- Anything explicitly contradicted by the current task description

Component: "${c.name}"
Description: ${c.description}
Tags: ${(c.tags || []).join(", ")}

Source files (use these directly, light edits only):
${JSON.stringify(filesPreview, null, 2)}
`;
  }

  // adapt mode
  return `
**ADAPT MODE** — A related component exists in the library (similarity
${Number(c.similarity).toFixed(2)}). Use it as STRUCTURE / STARTING TEMPLATE
but adapt freely to the current task.

Component: "${c.name}"
Description: ${c.description}
Tags: ${(c.tags || []).join(", ")}

Source files (template — adapt as needed):
${JSON.stringify(filesPreview, null, 2)}
`;
}

export async function executeDevelopmentTask({ project, task, existingFiles, libraryMatch = null }) {
  const previewFiles = (existingFiles || []).map(file => ({
    path: file.path,
    preview: typeof file.content === "string" ? file.content.slice(0, 2000) : ""
  }));

  const guidance = libraryBlock(libraryMatch);

  const raw = await askOpenAI({
    role: "developer",
    taskType: task.type || "development",
    projectId: project.id,
    taskId: task.id,
    json: true,
    system:
      "You are an expert full-stack developer. Return strict JSON only. Always produce complete, runnable file contents. When library guidance is provided, follow REUSE/ADAPT rules.",
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

${guidance}

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
- Prefer Vite + React for MVP builds.
- Always include package.json when commands are needed.
- Use only safe npm commands (install, ci, run build, test, run lint, vite host).
- Never include secrets, API keys, .env files, or credentials.
- If REUSE mode is set above, copy the source files with minimal edits.
- If ADAPT mode is set above, use them as structural inspiration.
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.files)) {
    throw new Error("Developer agent did not return a valid file list.");
  }
  parsed.files = parsed.files.filter(f => f && typeof f.path === "string" && typeof f.content === "string");
  parsed.commandsToRun = Array.isArray(parsed.commandsToRun) ? parsed.commandsToRun : [];
  return parsed;
}
