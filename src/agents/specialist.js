/**
 * Specialist agent — hands the task off to Manus for long-running work.
 *
 * Strategy:
 *  - Submit the job to Manus.
 *  - Persist the job id on the task result.
 *  - Return immediately so the orchestrator can mark the task as "complete"
 *    from a code-execution standpoint. Manus's actual output lands in the
 *    manus_jobs table and can be polled by a separate cron / dashboard.
 *
 * If you want strict "wait for manus" behavior, set
 *   SPECIALIST_WAIT_FOR_COMPLETION=true
 * — the agent will then poll until done (or hit a timeout).
 */

import { submitManusJob, pollManusJob } from "./manusClient.js";

const POLL_INTERVAL_MS = Number(process.env.MANUS_POLL_INTERVAL_MS || 30000);
const POLL_TIMEOUT_MS = Number(process.env.MANUS_POLL_TIMEOUT_MS || 30 * 60 * 1000);

const wait = ms => new Promise(r => setTimeout(r, ms));

export async function executeSpecialistTask({ project, task }) {
  const prompt = `${task.title}\n\n${task.description}\n\nProject goal: ${project.goal}`;
  const submission = await submitManusJob({
    prompt,
    projectId: project.id,
    taskId: task.id
  });

  if (submission.error) {
    return {
      summary: `Specialist (Manus) failed to submit: ${submission.error}`,
      files: [],
      commandsToRun: [],
      needsSmokeTest: false,
      notes: [submission.error],
      manusJobId: null
    };
  }

  if (process.env.SPECIALIST_WAIT_FOR_COMPLETION !== "true") {
    return {
      summary: `Specialist task submitted to Manus (jobId=${submission.jobId}). Will run asynchronously.`,
      files: [],
      commandsToRun: [],
      needsSmokeTest: false,
      notes: [`Manus jobId: ${submission.jobId}`, `status: ${submission.status}`],
      manusJobId: submission.jobId
    };
  }

  // Synchronous polling mode.
  const start = Date.now();
  let lastStatus = submission.status;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await wait(POLL_INTERVAL_MS);
    const tick = await pollManusJob({ jobId: submission.jobId });
    lastStatus = tick.status;
    if (["completed", "succeeded", "failed", "canceled", "error"].includes(lastStatus)) {
      return {
        summary: `Manus job ${lastStatus} (jobId=${submission.jobId}).`,
        files: [],
        commandsToRun: [],
        needsSmokeTest: false,
        notes: [JSON.stringify(tick).slice(0, 1000)],
        manusJobId: submission.jobId,
        manusOutput: tick.output
      };
    }
  }

  return {
    summary: `Manus job timed out at status=${lastStatus} (jobId=${submission.jobId}). Will continue in background.`,
    files: [],
    commandsToRun: [],
    needsSmokeTest: false,
    notes: ["Polling timed out, but Manus job may still complete."],
    manusJobId: submission.jobId
  };
}
