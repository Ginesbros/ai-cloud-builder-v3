import { askOpenAI } from "./openaiClient.js";

export async function executeDevelopmentTask({ project, task, existingFiles }) {
  const raw = await askOpenAI({
    role: "developer",
    projectId: project.id,
    taskId: task.id,
    json: true,
    system: "You are an expert full-stack developer. Return strict JSON only.",
    user: `
Project goal:
${project.goal}

Plan:
${JSON.stringify(project.plan)}

Task:
${task.title}
${task.description}

Existing files:
${JSON.stringify(
  existingFiles.map(file => ({
    path: file.path,
    preview: file.content.slice(0, 2000)
  }))
)}

Return JSON:
{
  "summary": "...",
  "files": [
    {
      "path": "relative/path",
      "content": "complete file content"
    }
  ],
  "commandsToRun": ["npm install", "npm run build"],
  "needsSmokeTest": true,
  "notes": ["..."]
}

Rules:
- Return complete files only.
- Prefer Vite/static app for MVP builds.
- Include package.json when commands are needed.
- Never include secrets.
- Use only safe npm commands.
`
  });

  return JSON.parse(raw);
}
