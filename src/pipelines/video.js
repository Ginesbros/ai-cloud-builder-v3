/**
 * video pipeline — Multi-scene video production.
 *
 * Strategy (v1):
 *  1. LLM writes a storyboard (scenes with prompts + durations).
 *  2. Each scene is submitted to Higgsfield via submitVideoJob().
 *  3. Each scene job ID is returned as a deliverable (kind='video') with
 *     metadata containing jobId for the orchestrator's poller to fetch.
 *  4. A placeholder "compose" task is included; ffmpeg composition is
 *     deferred to v2 when sandbox allow-list includes ffmpeg.
 *
 * files = []           (no code written to the repo)
 * deliverables = one per scene (video job stubs) + storyboard report
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { askClaude } from "../agents/claudeClient.js";
import { submitVideoJob } from "../agents/higgsfieldClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return strict JSON only, no prose, no markdown fences.
{
  "projectName": "kebab-case-name",
  "summary": "One sentence description",
  "techStack": ["Higgsfield AI (text-to-video)", "ffmpeg (compose)"],
  "successCriteria": ["Storyboard created", "2-4 scene videos generated", "Scenes ready to compose", "..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "video|docs",
      "priority": 1
    }
  ]
}

Rules:
- 4-6 tasks total.
- Tasks: storyboard creation, scene 1, scene 2, scene 3 (optional), scene 4 (optional), compose (placeholder).
- All scene tasks should have type "video".
- The storyboard task should have type "docs".
- The compose task is always a placeholder — label it clearly.
- Never include secrets or credentials.
`;

/**
 * Plan tasks for a video production project.
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
      "You are a senior video director and AI video producer. Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

${PLAN_SCHEMA_HINT}
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("video planner did not return a valid plan JSON.");
  }

  parsed.tasks = parsed.tasks.slice(0, 6);
  return parsed;
}

/**
 * Execute a single video task.
 *
 * Storyboard task → Claude writes scene descriptions, returned as a 'report' deliverable.
 * Scene tasks → submitVideoJob(), returned as 'video' deliverables with job metadata.
 * Compose task → placeholder note, no actual ffmpeg call.
 */
export async function executeTask({ project, task, existingFiles }) {
  const taskTitleLower = (task.title || "").toLowerCase();
  const isStoryboard = taskTitleLower.includes("storyboard") || task.type === "docs";
  const isCompose =
    taskTitleLower.includes("compos") ||
    taskTitleLower.includes("ffmpeg") ||
    taskTitleLower.includes("merge");
  const isScene = task.type === "video" && !isStoryboard && !isCompose;

  const deliverables = [];
  const notes = [];

  // ---- Storyboard task ----
  if (isStoryboard) {
    const storyboard = await askClaude({
      role: "reviewer",
      projectId: project?.id || null,
      json: false,
      system: "You are a professional video director. Write detailed, cinematic scene descriptions.",
      user: `
Project goal: ${project?.goal || ""}
Task: ${task.title}
${task.description}

Write a detailed video storyboard with 2-4 scenes covering:
1. Scene number and title
2. Visual description (what the camera shows)
3. Narration / on-screen text
4. Duration (4-8 seconds per scene)
5. Mood / style notes

Format as Markdown.
`
    });

    deliverables.push({
      kind: "report",
      filename: "storyboard.md",
      data: storyboard || "# Storyboard\n\n(Content generation failed)",
      mimeType: "text/markdown",
      generator: "video",
      metadata: { taskTitle: task.title }
    });

    notes.push("Storyboard saved as a Markdown report deliverable.");

    return {
      summary: "Video storyboard created.",
      files: [],
      commandsToRun: [],
      needsSmokeTest: false,
      notes,
      deliverables
    };
  }

  // ---- Compose placeholder task ----
  if (isCompose) {
    notes.push(
      "ffmpeg composition is a v2 feature — not yet available in the sandbox.",
      "To compose scenes manually: ffmpeg -i scene1.mp4 -i scene2.mp4 -filter_complex concat=n=2:v=1:a=0 output.mp4",
      "Download each scene video from the deliverables and compose locally."
    );
    return {
      summary: "Compose step is a placeholder. Download scenes and run ffmpeg locally.",
      files: [],
      commandsToRun: [],
      needsSmokeTest: false,
      notes,
      deliverables: []
    };
  }

  // ---- Scene generation task ----
  // Build a scene-specific video prompt.
  const promptRaw = await askOpenAI({
    role: "developer",
    taskType: "video",
    projectId: project?.id || null,
    json: true,
    system: "You are a video prompt engineer. Return strict JSON only.",
    user: `
Project goal: ${project?.goal || ""}
Task: ${task.title} — ${task.description}

Write a detailed text-to-video prompt for Higgsfield AI.
The prompt should describe: subject, action, camera movement, lighting, style, mood.
Keep it under 200 words.

Return JSON:
{
  "prompt": "...",
  "durationSeconds": 6,
  "aspectRatio": "16:9"
}
`
  });

  const sceneData = safeParseJson(promptRaw, {});
  const prompt =
    sceneData.prompt ||
    `${task.title} — ${task.description} — cinematic style, 4K, professional lighting`;
  const durationSeconds = Number(sceneData.durationSeconds) || 6;
  const aspectRatio = sceneData.aspectRatio || "16:9";

  const jobResult = await submitVideoJob({
    prompt,
    durationSeconds,
    aspectRatio,
    projectId: project?.id || null,
    taskId: task?.id || null
  });

  if (jobResult.error) {
    notes.push(`Higgsfield video job failed: ${jobResult.error}`);
    // Return a placeholder deliverable so the pipeline doesn't crash.
    deliverables.push({
      kind: "video",
      filename: `scene-${Date.now()}.mp4`,
      data: `Video job failed: ${jobResult.error}`,
      mimeType: "text/plain",
      generator: "higgsfield",
      metadata: { error: jobResult.error, prompt, taskTitle: task.title }
    });
  } else {
    notes.push(`Higgsfield video job submitted. jobId: ${jobResult.jobId}. Status: ${jobResult.status}.`);
    notes.push("The orchestrator poller will fetch the MP4 URL when the job completes.");
    deliverables.push({
      kind: "video",
      filename: `scene-${jobResult.jobId || Date.now()}.mp4`,
      data: JSON.stringify({ jobId: jobResult.jobId, status: jobResult.status, prompt }),
      mimeType: "application/json",
      generator: "higgsfield",
      metadata: {
        jobId: jobResult.jobId,
        status: jobResult.status,
        prompt,
        durationSeconds,
        aspectRatio,
        taskTitle: task.title
      }
    });
  }

  return {
    summary: jobResult.error
      ? `Scene generation failed: ${jobResult.error}`
      : `Scene video job submitted (jobId: ${jobResult.jobId}).`,
    files: [],
    commandsToRun: [],
    needsSmokeTest: false,
    notes,
    deliverables
  };
}
