import { supabase } from "../lib/supabase.js";
import { logEvent } from "../lib/logger.js";
import { createPlan } from "../agents/planner.js";
import { executeDevelopmentTask } from "../agents/developer.js";
import { debugFailure } from "../agents/debugger.js";
import { reviewProject } from "../agents/reviewer.js";
import { createRepoIfNeeded, upsertFilesToGitHub } from "./github.js";
import { runSandboxCommand } from "../sandbox/sandboxManager.js";
import { runSmokeForProject } from "../sandbox/smokeRunner.js";
import {
  assertBudgetAvailable,
  getBudgetConfig,
  getMonthlyEstimatedSpend
} from "./budget.js";

const safeName = (value) =>
  (value || `ai-project-${Date.now()}`)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

// =========================
// CREATE PROJECT
// =========================
export async function createProject({ goal, name, autonomyMode = "dev" }) {
  const cfg = getBudgetConfig();

  const { data: projectSeed, error: seedError } = await supabase
    .from("projects")
    .insert({
      name: safeName(name || "planning-project"),
      goal,
      status: "planning",
      autonomy_mode: autonomyMode,
      monthly_budget_usd: cfg.monthlyBudget,
      memory: {
        createdBy: "ai-cloud-builder-v3",
        budgetMode: cfg.mode
      },
      current_stage: "planning"
    })
    .select()
    .single();

  if (seedError) throw seedError;

  await assertBudgetAvailable({ projectId: projectSeed.id });

  const plan = await createPlan({
    goal,
    projectId: projectSeed.id
  });

  const projectName = safeName(name || plan.projectName || "ai-project");

  const { data: project, error } = await supabase
    .from("projects")
    .update({
      name: projectName,
      status: "planned",
      plan,
      current_stage: "planned",
      updated_at: new Date().toISOString()
    })
    .eq("id", projectSeed.id)
    .select()
    .single();

  if (error) throw error;

  const tasks = (plan.tasks || []).map((task, index) => ({
    project_id: project.id,
    title: task.title || `Task ${index + 1}`,
    description: task.description || "No description provided.",
    type: task.type || "development",
    priority: task.priority ?? index + 1
  }));

  if (tasks.length > 0) {
    const { error: taskError } = await supabase
      .from("tasks")
      .insert(tasks);

    if (taskError) throw taskError;
  }

  await logEvent({
    projectId: project.id,
    message: "Project created.",
    data: { plan }
  });

  return {
    project,
    tasksCreated: tasks.length
  };
}

// =========================
// GET PROJECT
// =========================
export async function getProject(projectId) {
  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();

  if (error) throw error;

  const { data: tasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("project_id", projectId)
    .order("priority");

  return {
    project,
    tasks: tasks || []
  };
}

// =========================
// HELPERS
// =========================
async function getFiles(projectId) {
  const { data } = await supabase
    .from("project_files")
    .select("*")
    .eq("project_id", projectId);

  return data || [];
}

async function upsertFiles(projectId, files) {
  for (const file of files || []) {
    if (!file.path || typeof file.content !== "string") continue;

    await supabase.from("project_files").upsert(
      {
        project_id: projectId,
        path: file.path,
        content: file.content,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "project_id,path"
      }
    );
  }
}

// =========================
// RUN TASK
// =========================
export async function runSpecificTask(projectId, task) {
  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();

  await assertBudgetAvailable({ projectId });

  await logEvent({
    projectId,
    taskId: task.id,
    message: `Running task: ${task.title}`
  });

  let result = await executeDevelopmentTask({
    project,
    task,
    existingFiles: await getFiles(projectId)
  });

  await upsertFiles(projectId, result.files || []);

  try {
    for (const command of result.commandsToRun || []) {
      await runSandboxCommand({
        projectId,
        taskId: task.id,
        command
      });
    }

    await runSmokeForProject({
      projectId,
      taskId: task.id
    });
  } catch (error) {
    const fix = await debugFailure({
      project,
      task,
      error: error.message,
      files: await getFiles(projectId)
    });

    await upsertFiles(projectId, fix.files || []);
    result.debugFix = fix;
  }

  const review = await reviewProject({
    project,
    task,
    files: await getFiles(projectId)
  });

  result.review = review;

  const repo = await createRepoIfNeeded(project);

  await upsertFilesToGitHub({
    projectId,
    repoName: repo.repoName
  });

  await supabase.from("tasks").update({
    status: "complete",
    result
  }).eq("id", task.id);

  return { result };
}

// =========================
// RUN NEXT
// =========================
export async function runNextTask(projectId) {
  const { data: task } = await supabase
    .from("tasks")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();

  if (!task) {
    return { done: true };
  }

  return runSpecificTask(projectId, task);
}

// =========================
// AUTONOMOUS LOOP
// =========================
export async function runAutonomousProject(projectId) {
  const results = [];

  for (let i = 0; i < 20; i++) {
    const result = await runNextTask(projectId);
    results.push(result);

    if (result.done) break;
  }

  return results;
}
