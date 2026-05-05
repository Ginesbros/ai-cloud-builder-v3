/**
 * freeform pipeline — Delegates complex, long-running tasks to Manus.
 *
 * planTasks returns a single task of type='specialist'.
 * executeTask submits the job to Manus and returns the jobId as a note
 * and a placeholder deliverable. The orchestrator's Manus poller handles
 * the actual result fetching.
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { submitManusJob } from "../agents/manusClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

/**
 * Plan a freeform project — always returns a single specialist task
 * that Manus will handle end-to-end.
 */
export async function planTasks({ project, goal, clarifications, projectId }) {
  const effectiveGoal = clarifications
    ? `${goal}\n\nAdditional clarifications:\n${clarifications}`
    : goal;

  // Ask OpenAI to produce a structured brief for Manus.
  const raw = await askOpenAI({
    role: "planner",
    projectId: projectId || project?.id || null,
    json: true,
    system:
      "You are a senior project manager. You receive an open-ended goal and summarise it into a structured project brief for an autonomous AI agent (Manus). Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

Return JSON of the form:
{
  "projectName": "kebab-case-name",
  "summary": "Two-sentence description of what needs to be done",
  "techStack": ["...list inferred technologies or 'Autonomous AI Agent'..."],
  "successCriteria": ["...", "..."],
  "tasks": [
    {
      "title": "Delegate full project to Manus autonomous agent",
      "description": "Full description of the goal, context, and expected deliverables for Manus to execute.",
      "type": "specialist",
      "priority": 1
    }
  ]
}

Rules:
- Return exactly ONE task of type "specialist".
- The task description must be detailed enough for Manus to work autonomously.
- Never include secrets, API keys, or credentials.
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    // Fallback: construct a minimal plan.
    return {
      projectName: "freeform-project",
      summary: effectiveGoal.slice(0, 200),
      techStack: ["Autonomous AI Agent (Manus)"],
      successCriteria: ["Manus completes the task autonomously"],
      tasks: [
        {
          title: "Delegate full project to Manus autonomous agent",
          description: effectiveGoal,
          type: "specialist",
          priority: 1
        }
      ]
    };
  }

  // Ensure exactly one specialist task.
  parsed.tasks = [
    {
      title: parsed.tasks[0]?.title || "Delegate full project to Manus autonomous agent",
      description: parsed.tasks[0]?.description || effectiveGoal,
      type: "specialist",
      priority: 1
    }
  ];

  return parsed;
}

/**
 * Execute the freeform specialist task by submitting to Manus.
 *
 * Returns:
 *  - summary: confirmation message
 *  - files: []
 *  - commandsToRun: []
 *  - needsSmokeTest: false
 *  - notes: [jobId, status, polling instructions]
 *  - deliverables: [placeholder stub]
 */
export async function executeTask({ project, task, existingFiles }) {
  // Build a comprehensive prompt for Manus.
  const prompt = [
    `Project goal: ${project?.goal || task.description}`,
    task.description !== project?.goal
      ? `Task details: ${task.description}`
      : "",
    project?.plan?.summary
      ? `Project summary: ${project.plan.summary}`
      : "",
    project?.plan?.successCriteria?.length
      ? `Success criteria:\n${project.plan.successCriteria.map(c => `- ${c}`).join("\n")}`
      : "",
    "Please complete this task autonomously and return all deliverables."
  ]
    .filter(Boolean)
    .join("\n\n");

  const jobResult = await submitManusJob({
    prompt,
    projectId: project?.id || null,
    taskId: task?.id || null
  });

  const notes = [];
  if (jobResult.error) {
    notes.push(`Manus submission failed: ${jobResult.error}`);
    notes.push("The task was not submitted. Check MANUS_API_KEY and retry.");
  } else {
    notes.push(`Manus job submitted successfully.`);
    notes.push(`Job ID: ${jobResult.jobId}`);
    notes.push(`Initial status: ${jobResult.status}`);
    notes.push(
      "The orchestrator poller will check job status periodically and attach results when complete."
    );
  }

  const deliverables = [
    {
      kind: "other",
      filename: "manus-job.json",
      data: JSON.stringify(
        {
          jobId: jobResult.jobId || null,
          status: jobResult.status || "error",
          error: jobResult.error || null,
          prompt
        },
        null,
        2
      ),
      mimeType: "application/json",
      generator: "manus",
      metadata: {
        jobId: jobResult.jobId || null,
        status: jobResult.status || "error",
        taskTitle: task.title
      }
    }
  ];

  return {
    summary: jobResult.error
      ? `Manus submission failed: ${jobResult.error}`
      : `Manus job submitted (jobId: ${jobResult.jobId}). Awaiting autonomous completion.`,
    files: [],
    commandsToRun: [],
    needsSmokeTest: false,
    notes,
    deliverables
  };
}
