/**
 * web_app pipeline — Vite + React application.
 *
 * planTasks  → delegates to src/agents/planner.js (createPlan)
 * executeTask → delegates to src/agents/developer.js (executeDevelopmentTask)
 */

import { createPlan } from "../agents/planner.js";
import { executeDevelopmentTask } from "../agents/developer.js";

/**
 * Build a plan for a web application project.
 *
 * @param {object} opts
 * @param {object} opts.project        - Full project record (goal, id, etc.)
 * @param {string} opts.goal           - User's goal string
 * @param {string} [opts.clarifications] - Additional clarifications
 * @param {string} [opts.projectId]    - Project UUID for budget tracking
 * @returns {Promise<object>}          - { projectName, summary, techStack, successCriteria, tasks }
 */
export async function planTasks({ project, goal, clarifications, projectId }) {
  const effectiveGoal = clarifications
    ? `${goal}\n\nAdditional clarifications:\n${clarifications}`
    : goal;

  const plan = await createPlan({
    goal: effectiveGoal,
    projectId: projectId || project?.id || null,
    attachedDocs: project?.attachedDocs || []
  });

  return plan;
}

/**
 * Execute a single task within a web application project.
 *
 * @param {object} opts
 * @param {object} opts.project       - Full project record
 * @param {object} opts.task          - Task descriptor { title, description, type, priority }
 * @param {Array}  opts.existingFiles - Files already written in previous tasks
 * @returns {Promise<object>}         - { summary, files, commandsToRun, needsSmokeTest, notes, deliverables }
 */
export async function executeTask({ project, task, existingFiles }) {
  const result = await executeDevelopmentTask({ project, task, existingFiles });

  return {
    summary: result.summary || "",
    files: Array.isArray(result.files) ? result.files : [],
    commandsToRun: Array.isArray(result.commandsToRun) ? result.commandsToRun : [],
    needsSmokeTest: result.needsSmokeTest !== false,
    notes: Array.isArray(result.notes) ? result.notes : [],
    deliverables: []
  };
}
