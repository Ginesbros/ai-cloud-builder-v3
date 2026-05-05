/**
 * Videographer agent — generates a marketing/demo video via Higgsfield.
 *
 * Like the specialist, this is async by default: submit job → return.
 * Optionally polls if VIDEOGRAPHER_WAIT_FOR_COMPLETION=true.
 */

import { submitVideoJob, pollVideoJob } from "./higgsfieldClient.js";
import { askOpenAI } from "./openaiClient.js";
import { safeParseJson } from "./jsonUtils.js";

const POLL_INTERVAL_MS = Number(process.env.HIGGSFIELD_POLL_INTERVAL_MS || 20000);
const POLL_TIMEOUT_MS = Number(process.env.HIGGSFIELD_POLL_TIMEOUT_MS || 15 * 60 * 1000);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function planVideoPrompt({ project, task }) {
  const raw = await askOpenAI({
    role: "developer",
    taskType: "video",
    projectId: project.id,
    taskId: task.id,
    json: true,
    system: "You are a video director. Return strict JSON only.",
    user: `
Project goal: ${project.goal}
Video task: ${task.title}
Description: ${task.description}

Return JSON:
{
  "prompt": "...vivid 1-2 sentence shot description...",
  "durationSeconds": 6,
  "aspectRatio": "16:9"
}
- Keep prompt under 280 characters.
- durationSeconds: 4-10.
- aspectRatio: 16:9 unless task description requests otherwise.
`
  });
  return safeParseJson(raw, { prompt: task.description, durationSeconds: 6, aspectRatio: "16:9" });
}

export async function executeVideoTask({ project, task }) {
  const plan = await planVideoPrompt({ project, task });
  const submission = await submitVideoJob({
    prompt: plan.prompt,
    durationSeconds: plan.durationSeconds || 6,
    aspectRatio: plan.aspectRatio || "16:9",
    projectId: project.id,
    taskId: task.id
  });

  if (submission.error) {
    return {
      summary: `Videographer (Higgsfield) failed to submit: ${submission.error}`,
      files: [],
      commandsToRun: [],
      needsSmokeTest: false,
      notes: [submission.error],
      higgsfieldJobId: null
    };
  }

  if (process.env.VIDEOGRAPHER_WAIT_FOR_COMPLETION !== "true") {
    return {
      summary: `Video job submitted (jobId=${submission.jobId}). Will render asynchronously.`,
      files: [],
      commandsToRun: [],
      needsSmokeTest: false,
      notes: [`Higgsfield jobId: ${submission.jobId}`, `prompt: ${plan.prompt}`],
      higgsfieldJobId: submission.jobId
    };
  }

  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await wait(POLL_INTERVAL_MS);
    const tick = await pollVideoJob({ jobId: submission.jobId });
    if (tick.videoUrl) {
      return {
        summary: `Video rendered (jobId=${submission.jobId}).`,
        files: [],
        commandsToRun: [],
        needsSmokeTest: false,
        notes: [`videoUrl: ${tick.videoUrl}`],
        higgsfieldJobId: submission.jobId,
        videoUrl: tick.videoUrl
      };
    }
    if (["failed", "error", "canceled"].includes(tick.status)) {
      return {
        summary: `Video job ${tick.status} (jobId=${submission.jobId}).`,
        files: [],
        commandsToRun: [],
        needsSmokeTest: false,
        notes: [JSON.stringify(tick).slice(0, 1000)],
        higgsfieldJobId: submission.jobId
      };
    }
  }

  return {
    summary: `Video job still rendering (jobId=${submission.jobId}). Check back later.`,
    files: [],
    commandsToRun: [],
    needsSmokeTest: false,
    notes: ["Polling timed out, but Higgsfield may still finish."],
    higgsfieldJobId: submission.jobId
  };
}
