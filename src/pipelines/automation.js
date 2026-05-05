/**
 * automation pipeline — Cron / webhook scaffold.
 *
 * Defaults to Node.js + node-cron.
 * Also supports Vercel cron config (vercel.json) when goal mentions Vercel.
 *
 * Outputs:
 *  - files: handler code, cron/webhook config, README
 *  - deliverables: []  (code-only pipeline)
 *  - commandsToRun: npm install, npm start (or vercel deploy)
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return strict JSON only, no prose, no markdown fences.
{
  "projectName": "kebab-case-name",
  "summary": "One sentence description",
  "techStack": ["Node.js", "node-cron"],
  "successCriteria": ["Cron job triggers on schedule", "Webhook handles POST requests", "Deploy instructions provided", "..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "setup|backend|integration|test|docs|deploy",
      "priority": 1
    }
  ]
}

Rules:
- 5-8 tasks total.
- Always include: setup (package.json + entry point), define schedule/trigger, write handler logic, config file (.env.example), deploy instructions README.
- Include a "test" task to verify the handler locally.
- Include a "deploy" task with clear instructions (Vercel, Railway, or a VPS).
- Use node-cron for scheduled jobs OR a Vercel cron config (vercel.json) if user mentions Vercel.
- Use an express webhook endpoint for webhook triggers.
- Never include secrets or credentials.
`;

function detectPlatform(goal) {
  const lower = (goal || "").toLowerCase();
  if (lower.includes("vercel")) return "vercel";
  if (lower.includes("railway") || lower.includes("heroku") || lower.includes("render")) return "paas";
  return "node-cron";
}

function detectTrigger(goal) {
  const lower = (goal || "").toLowerCase();
  if (lower.includes("webhook") || lower.includes("event") || lower.includes("trigger")) return "webhook";
  return "cron";
}

/**
 * Plan tasks for an automation project.
 */
export async function planTasks({ project, goal, clarifications, projectId }) {
  const effectiveGoal = clarifications
    ? `${goal}\n\nAdditional clarifications:\n${clarifications}`
    : goal;

  const platform = detectPlatform(effectiveGoal);
  const trigger = detectTrigger(effectiveGoal);

  const platformNote =
    platform === "vercel"
      ? "Use Vercel cron config in vercel.json and Next.js API route or a plain Node serverless function."
      : "Use Node.js 20 with node-cron for scheduled jobs and Express for webhook endpoints.";

  const triggerNote =
    trigger === "webhook"
      ? "The main automation trigger is a webhook (HTTP POST). Validate a shared secret from headers."
      : "The main automation trigger is a cron schedule. Default schedule: every day at 9am UTC (0 9 * * *).";

  const raw = await askOpenAI({
    role: "planner",
    projectId: projectId || project?.id || null,
    json: true,
    system:
      "You are a senior DevOps / automation engineer. Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

Platform: ${platformNote}
Trigger: ${triggerNote}

${PLAN_SCHEMA_HINT}
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("automation planner did not return a valid plan JSON.");
  }

  parsed.tasks = parsed.tasks.slice(0, 8);
  parsed._platform = platform;
  parsed._trigger = trigger;
  return parsed;
}

/**
 * Execute a single automation task.
 */
export async function executeTask({ project, task, existingFiles }) {
  const previewFiles = (existingFiles || []).map(f => ({
    path: f.path,
    preview: typeof f.content === "string" ? f.content.slice(0, 2000) : ""
  }));

  const platform = project?.plan?._platform || detectPlatform(project?.goal || "");
  const trigger = project?.plan?._trigger || detectTrigger(project?.goal || "");

  const platformInstructions =
    platform === "vercel"
      ? `Use Vercel cron in vercel.json: { "crons": [{ "path": "/api/cron", "schedule": "0 9 * * *" }] }
Entry point: api/cron.js (or api/cron/route.js for Next.js App Router).
Deploy with: vercel --prod`
      : `Use Node.js 20 with node-cron (npm install node-cron express).
Entry point: src/index.js. Cron schedule default: "0 9 * * *".
Run locally: npm install && npm start
Deploy to Railway / Render: push to Git and set environment variables.`;

  const triggerInstructions =
    trigger === "webhook"
      ? `Webhook handler: Express POST /webhook.
Validate X-Webhook-Secret header against process.env.WEBHOOK_SECRET.
Process payload and call the business logic handler.`
      : `Cron handler: function that runs on schedule via node-cron.
Log start/end times. Handle errors gracefully with try/catch. Email or Slack alert on failure (optional).`;

  const raw = await askOpenAI({
    role: "developer",
    taskType: task.type || "backend",
    projectId: project?.id || null,
    json: true,
    system: `You are an expert Node.js automation engineer. Return strict JSON only. Always produce complete, runnable file contents.`,
    user: `
Project goal:
${project?.goal || ""}

Plan:
${JSON.stringify(project?.plan || {})}

Task:
${task.title}
${task.description}

Platform instructions:
${platformInstructions}

Trigger instructions:
${triggerInstructions}

Existing files (path + preview):
${JSON.stringify(previewFiles)}

Return JSON of the form:
{
  "summary": "...",
  "files": [ { "path": "relative/path", "content": "complete file content" } ],
  "commandsToRun": ["npm install", "npm start"],
  "needsSmokeTest": false,
  "notes": ["..."]
}

Rules:
- Return complete files only. No diffs.
- Always include package.json with start/test scripts (unless Vercel-only).
- Always include .env.example (never actual secrets).
- Always include README.md with setup, configuration, and deploy instructions.
- Use only safe npm commands: install, ci, start, test, run build.
- Never include actual secrets, API keys, or credentials.
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.files)) {
    throw new Error("automation developer agent did not return a valid file list.");
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
