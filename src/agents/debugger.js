import { askOpenAI } from "./openaiClient.js";
import { safeParseJson } from "./jsonUtils.js";

export async function debugFailure({ project, task, error, files, loopNumber = 1 }) {
  const fullFiles = (files || []).map(file => ({
    path: file.path,
    content: typeof file.content === "string" ? file.content : ""
  }));

  const raw = await askOpenAI({
    role: "debugger",
    projectId: project.id,
    taskId: task.id,
    json: true,
    system: "You are a debugging agent. Return strict JSON only. Always return complete corrected files.",
    user: `
Debug loop: ${loopNumber}
Project goal: ${project.goal}
Task: ${task.title}
${task.description}

Failure:
${error}

Current files:
${JSON.stringify(fullFiles)}

Return JSON of the form:
{
  "summary": "...",
  "rootCause": "...",
  "files": [ { "path": "relative/path", "content": "complete corrected content" } ],
  "commandsToRun": ["npm install", "npm run build"],
  "notes": ["..."]
}

Rules:
- Provide complete corrected file contents (no diffs).
- Prefer minimal targeted fixes that match the failure.
- Use only safe npm commands.
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed) throw new Error("Debugger agent did not return valid JSON.");
  parsed.files = Array.isArray(parsed.files)
    ? parsed.files.filter(f => f && typeof f.path === "string" && typeof f.content === "string")
    : [];
  parsed.commandsToRun = Array.isArray(parsed.commandsToRun) ? parsed.commandsToRun : [];
  return parsed;
}
