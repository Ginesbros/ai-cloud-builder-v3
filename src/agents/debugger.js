import { askOpenAI } from "./openaiClient.js";

export async function debugFailure({
  project,
  task,
  error,
  files,
  loopNumber = 1
}) {
  const raw = await askOpenAI({
    role: "debugger",
    projectId: project.id,
    taskId: task.id,
    json: true,
    system: "You are a debugging agent. Return strict JSON only.",
    user: `
Debug loop:
${loopNumber}

Project goal:
${project.goal}

Task:
${task.title}
${task.description}

Failure:
${error}

Files:
${JSON.stringify(
  files.map(file => ({
    path: file.path,
    content: file.content
  }))
)}

Return JSON:
{
  "summary": "...",
  "files": [
    {
      "path": "relative/path",
      "content": "complete corrected content"
    }
  ],
  "commandsToRun": ["npm install", "npm run build"],
  "notes": ["..."]
}
`
  });

  return JSON.parse(raw);
}
