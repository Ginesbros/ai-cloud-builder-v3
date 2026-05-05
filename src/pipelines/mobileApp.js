/**
 * mobile_app pipeline — React Native scaffold via Expo.
 *
 * needsSmokeTest = false (no headless runner for native apps).
 * Output includes instructions for `npx expo start`.
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return strict JSON only, no prose, no markdown fences.
{
  "projectName": "kebab-case-name",
  "summary": "One sentence description",
  "techStack": ["React Native", "Expo", "TypeScript"],
  "successCriteria": ["App runs with npx expo start", "..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "setup|frontend|integration|test|docs",
      "priority": 1
    }
  ]
}

Rules:
- 6-9 tasks total.
- Always start with an "setup" task that scaffolds the Expo project (app.json, package.json, babel.config.js).
- Always include: screen components, navigation (React Navigation), API hooks / context, styling (StyleSheet or NativeWind), build/run README.
- Include a "docs" task explaining how to run with 'npx expo start' and how to build for iOS/Android.
- No "deploy" task — mobile deployment is manual and platform-specific.
- Never include secrets, API keys, or credentials.
`;

/**
 * Plan tasks for a mobile app project.
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
      "You are a senior React Native / Expo developer. Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

${PLAN_SCHEMA_HINT}
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("mobileApp planner did not return a valid plan JSON.");
  }

  parsed.tasks = parsed.tasks.slice(0, 9);
  return parsed;
}

/**
 * Execute a single mobile app task.
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
    system: `You are an expert React Native / Expo developer. Return strict JSON only. Always produce complete, runnable file contents.`,
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
  "needsSmokeTest": false,
  "notes": ["To run: npx expo start", "Scan QR code with Expo Go app", "..."]
}

Rules:
- Return complete files only. No diffs, no partial files.
- Use Expo SDK (latest stable). Use React Navigation for routing.
- Use TypeScript with .tsx extensions for components and screens.
- Include app.json, package.json, babel.config.js, tsconfig.json at root.
- Screens go in src/screens/, components in src/components/, hooks in src/hooks/.
- commandsToRun should only be dependency installs: ["npx expo install <packages>"] if needed, otherwise [].
- needsSmokeTest must always be false.
- Never include secrets, API keys, .env files, or credentials.
- Always include a note about running the app: "Run with: npx expo start"
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.files)) {
    throw new Error("mobileApp developer agent did not return a valid file list.");
  }

  parsed.files = parsed.files.filter(
    f => f && typeof f.path === "string" && typeof f.content === "string"
  );

  const notes = Array.isArray(parsed.notes) ? parsed.notes : [];
  if (!notes.some(n => n.includes("expo start"))) {
    notes.unshift("Run the app locally: npx expo start — then scan the QR code with the Expo Go app on your device.");
  }

  return {
    summary: parsed.summary || "",
    files: parsed.files,
    commandsToRun: [],
    needsSmokeTest: false,
    notes,
    deliverables: []
  };
}
