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

const safeName = value => (value || `ai-project-${Date.now()}`)
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "");

export async function createProject({
  goal,
  name,
  autonomyMode = "dev"
}) {
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

  const projectName = safeName(name || plan.projectName);

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

  const tasks = plan.tasks.map((task, index) => ({
    project_id: project.id,
    title: task.title,
    description: task.description,
    type: task.type || "development",
    priority: task.priority ?? index + 1
  }));

  const { error: taskError } = await supabase
    .from("tasks")
    .insert(tasks);

  if (taskError) throw taskError;

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

  const { data: files } = await supabase
    .from("project_files")
    .select("path,sha,updated_at")
    .eq("project_id", projectId);

  const { data: logs } = await supabase
    .from("logs")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(25);

  const { data: sandboxRuns } = await supabase
    .from("sandbox_runs")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(10);

  const monthlySpend = await getMonthlyEstimatedSpend().catch(() => null);

  return {
    project,
    tasks,
    files,
    logs,
    sandboxRuns,
    budget: {
      monthlySpend,
      config: getBudgetConfig()
    }
  };
}

async function getFiles(projectId) {
  const { data } = await supabase
    .from("project_files")
    .select("*")
    .eq("project_id", projectId);

  return data || [];
}

async function upsertFiles(projectId, files) {
  for (const file of files || []) {
    await supabase.from("project_files").upsert({
      project_id: projectId,
      path: file.path,
      content: file.content,
      updated_at: new Date().toISOString()
    }, {
      onConflict: "project_id,path"
    });
  }
}

async function verify({ project, task, result }) {
  for (const command of result.commandsToRun || []) {
    await runSandboxCommand({
      projectId: project.id,
      taskId: task.id,
      command
    });
  }

  if (result.needsSmokeTest !== false) {
    await runSmokeForProject({
      projectId: project.id,
      taskId: task.id
    });
  }
}

export async function runSpecificTask(projectId, task) {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();

  if (projectError) throw projectError;

  await assertBudgetAvailable({ projectId });

  await supabase.from("projects").update({
    status: "building",
    current_stage: task.type,
    updated_at: new Date().toISOString()
  }).eq("id", projectId);

  await logEvent({
    projectId,
    taskId: task.id,
    message: `Running task: ${task.title}`
  });

  try {
    let result = await executeDevelopmentTask({
      project,
      task,
      existingFiles: await getFiles(projectId)
    });

    await upsertFiles(projectId, result.files);

    let verified = false;
    let lastError = null;
    const maxDebug = Number(process.env.MAX_DEBUG_LOOPS || 2);

    for (let loop = 0; loop <= maxDebug; loop++) {
      try {
        await verify({ project, task, result });
        verified = true;
        break;
      } catch (error) {
        lastError = error;

        if (loop >= maxDebug) break;

        await logEvent({
          projectId,
          taskId: task.id,
          level: "error",
          message: "Verification failed. Running debugger.",
          data: {
            loop: loop + 1,
            error: error.message
          }
        });

        const fix = await debugFailure({
          project,
          task,
          error: error.message,
          files: await getFiles(projectId),
          loopNumber: loop + 1
        });

        await upsertFiles(projectId, fix.files);

        for (const command of fix.commandsToRun || ["npm install", "npm run build"]) {
          await runSandboxCommand({
            projectId,
            taskId: task.id,
            command
          });
        }

        result.debugFix = fix;
      }
    }

    if (!verified) {
      throw lastError || new Error("Verification failed.");
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
      result,
      assigned_worker_id: null,
      locked_until: null,
      updated_at: new Date().toISOString()
    }).eq("id", task.id);

    await supabase.from("projects").update({
      repo_name: repo.repoName,
      repo_url: repo.repoUrl,
      status: "building",
      updated_at: new Date().toISOString()
    }).eq("id", projectId);

    await logEvent({
      projectId,
      taskId: task.id,
      message: "Task complete and verified.",
      data: result
    });

    return {
      task,
      result,
      repo
    };
  } catch (error) {
    const maxRetries = Number(process.env.MAX_TASK_RETRIES || 3);
    const nextStatus = task.attempts >= maxRetries ? "failed" : "pending";

    await supabase.from("tasks").update({
      status: nextStatus,
      error: error.message,
      assigned_worker_id: null,
      locked_until: null,
      updated_at: new Date().toISOString()
    }).eq("id", task.id);

    await logEvent({
      projectId,
      taskId: task.id,
      level: "error",
      message: "Task failed.",
      data: {
        error: error.message,
        nextStatus
      }
    });

    throw error;
  }
}

export async function runNextTask(projectId) {
  const { data: task, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "pending")
    .order("priority")
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  if (!task) {
    await supabase.from("projects").update({
      status: "complete",
      current_stage: "complete",
      updated_at: new Date().toISOString()
    }).eq("id", projectId);

    await logEvent({
      projectId,
      message: "Project complete."
    });

    return {
      done: true,
      message: "No pending tasks."
    };
  }

  await supabase.from("tasks").update({
    status: "running",
    attempts: task.attempts + 1
  }).eq("id", task.id);

  return runSpecificTask(projectId, {
    ...task,
    attempts: task.attempts + 1
  });
}

export async function runAutonomousProject(projectId) {
  const maxTasks = Number(process.env.MAX_PROJECT_TASKS || 20);
  const results = [];

  for (let i = 0; i < maxTasks; i++) {
    const result = await runNextTask(projectId);
    results.push(result);

    if (result.done) break;
  }

  return {
    projectId,
    steps: results.length,
    results
  };
}
}
