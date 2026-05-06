import { supabase } from "../lib/supabase.js";
import { logEvent } from "../lib/logger.js";
import { classifyGoal } from "../agents/classifier.js";
import { getPipeline } from "../pipelines/index.js";
import { debugFailure } from "../agents/debugger.js";
import { reviewProject } from "../agents/reviewer.js";
import { describeRouting } from "../agents/modelRouter.js";
import { matchComponent, recordReuse } from "../agents/componentMatcher.js";
import { maybeExtractComponent } from "../agents/componentExtractor.js";
import { createRepoIfNeeded, upsertFilesToGitHub } from "./github.js";
import { runSandboxCommand } from "../sandbox/sandboxManager.js";
import { runSmokeForProject } from "../sandbox/smokeRunner.js";
import { saveDeliverable } from "../lib/storage.js";
import { estimateProjectCost, recordActualCost } from "./costEstimator.js";
import {
  assertBudgetAvailable,
  getBudgetConfig,
  getMonthlyEstimatedSpend
} from "./budget.js";

const safeName = value =>
  (value || `ai-project-${Date.now()}`)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Step 1: createProject — seeds the project, classifies the goal, and either:
 *   - asks clarifying questions (sets awaiting_clarification=true), OR
 *   - runs the pipeline planner and creates tasks immediately.
 */
export async function createProject({ goal, name, autonomyMode = "dev", attachedDocs = [] }) {
  const cfg = getBudgetConfig();

  const { data: projectSeed, error: seedError } = await supabase
    .from("projects")
    .insert({
      name: safeName(name || "planning-project"),
      goal,
      status: "planning",
      autonomy_mode: autonomyMode,
      monthly_budget_usd: cfg.monthlyBudget,
      memory: { createdBy: "ai-cloud-builder-v3", budgetMode: cfg.mode, attachedDocs: attachedDocs.map(d => d.filename || d.url) },
      current_stage: "classifying"
    })
    .select()
    .single();

  if (seedError) throw seedError;
  await assertBudgetAvailable({ projectId: projectSeed.id });

  // Classify the goal first.
  const classification = await classifyGoal({ goal, projectId: projectSeed.id });
  await logEvent({
    projectId: projectSeed.id,
    message: `Classified goal as kind=${classification.kind} (confidence=${classification.confidence.toFixed(2)})`,
    data: classification
  });

  // If we need clarification, save state and return — the user must answer first.
  if (classification.needsClarification && classification.clarifyingQuestions.length > 0) {
    const { data: project, error } = await supabase
      .from("projects")
      .update({
        kind: classification.kind,
        awaiting_clarification: true,
        clarifications: classification.clarifyingQuestions.map(q => ({ ...q, answer: null })),
        current_stage: "awaiting_clarification",
        status: "awaiting_clarification",
        updated_at: new Date().toISOString()
      })
      .eq("id", projectSeed.id)
      .select()
      .single();
    if (error) throw error;
    return {
      ok: true,
      project,
      tasksCreated: 0,
      classification,
      awaitingClarification: true,
      questions: classification.clarifyingQuestions
    };
  }

  // No clarification needed — run pipeline planner now.
  return await planProject({
    project: projectSeed,
    goal,
    name,
    classification,
    clarifications: [],
    attachedDocs
  });
}

/**
 * Step 2: planProject — runs the pipeline's planTasks() and creates task rows.
 * Called either right after createProject (no clarification) or after the user
 * answers clarifying questions.
 */
async function planProject({ project, goal, name, classification, clarifications, attachedDocs = [] }) {
  const pipeline = getPipeline(classification.kind);

  const plan = await pipeline.planTasks({
    project,
    goal,
    clarifications,
    attachedDocs,
    projectId: project.id
  });

  // Guard: refuse to enter awaiting_approval with an empty plan. This would
  // let runNextTask immediately mark the project complete with zero output
  // (silent-success bug).
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    await supabase.from("projects").update({
      status: "failed",
      current_stage: "plan_empty",
      updated_at: new Date().toISOString()
    }).eq("id", project.id);
    await logEvent({
      projectId: project.id,
      level: "error",
      message: "Planner returned an empty task list. Project marked failed. Use Refine plan or recreate.",
      data: { plan }
    });
    throw new Error("Planner returned no tasks. Marked project as failed; refine or recreate.");
  }

  const projectName = safeName(name || classification.suggestedName || plan.projectName || "ai-project");

  // Plan-first workflow: project enters awaiting_approval after planning.
  // No paid developer/designer/reviewer work runs until the user clicks Approve.
  const { data: updated, error } = await supabase
    .from("projects")
    .update({
      name: projectName,
      kind: classification.kind,
      awaiting_clarification: false,
      awaiting_approval: true,
      status: "awaiting_approval",
      plan,
      current_stage: "awaiting_approval",
      updated_at: new Date().toISOString()
    })
    .eq("id", project.id)
    .select()
    .single();
  if (error) throw error;

  const tasks = (plan.tasks || []).map((task, index) => ({
    project_id: updated.id,
    title: task.title || `Task ${index + 1}`,
    description: task.description || "No description provided.",
    type: task.type || "development",
    priority: task.priority ?? index + 1
  }));

  if (tasks.length > 0) {
    const { error: taskError } = await supabase.from("tasks").insert(tasks);
    if (taskError) throw taskError;
  }

  await logEvent({
    projectId: updated.id,
    message: `Planned: ${tasks.length} tasks for kind=${classification.kind}`,
    data: { plan, kind: classification.kind }
  });

  // Generate cost estimate (best-effort, never blocks build).
  let estimate = null;
  try {
    estimate = await estimateProjectCost(updated.id);
  } catch (err) {
    await logEvent({
      projectId: updated.id,
      level: "warn",
      message: "Cost estimate generation failed.",
      data: { error: err.message }
    });
  }

  return { ok: true, project: updated, tasksCreated: tasks.length, classification, estimate };
}

/**
 * Step 3 (optional): user answers clarifying questions, we plan + create tasks.
 */
export async function submitClarifications({ projectId, answers }) {
  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error) throw error;

  if (!project.awaiting_clarification) {
    throw new Error("Project is not awaiting clarification.");
  }

  // Merge answers into stored clarifications.
  const merged = (project.clarifications || []).map((q, i) => ({
    ...q,
    answer: answers[i] ?? q.suggestedAnswer ?? null
  }));

  await supabase
    .from("projects")
    .update({ clarifications: merged, awaiting_clarification: false, updated_at: new Date().toISOString() })
    .eq("id", projectId);

  // Build a richer goal that includes clarifications.
  const enrichedGoal = `${project.goal}\n\nClarifications:\n${merged
    .map((q, i) => `- Q: ${q.question}\n  A: ${q.answer}`)
    .join("\n")}`;

  return await planProject({
    project,
    goal: enrichedGoal,
    name: project.name,
    classification: { kind: project.kind, suggestedName: project.name },
    clarifications: merged
  });
}

/**
 * Replan a stuck project — re-runs planTasks() for any project that's still in
 * planning state with no tasks (e.g. because a previous planner call failed).
 * Reuses the original goal + classification stored on the project row.
 */
export async function replanProject(projectId) {
  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error) throw error;

  const { data: existingTasks } = await supabase
    .from("tasks")
    .select("id")
    .eq("project_id", projectId);

  if ((existingTasks || []).length > 0) {
    return { ok: false, reason: "Project already has tasks. Use run-next instead." };
  }

  const classification = {
    kind: project.kind || "web_app",
    suggestedName: project.name,
    confidence: 1
  };

  const enrichedGoal = (project.clarifications && project.clarifications.length)
    ? `${project.goal}\n\nClarifications:\n${project.clarifications.map(q => `- Q: ${q.question}\n  A: ${q.answer || q.suggestedAnswer || "(no answer)"}`).join("\n")}`
    : project.goal;

  return await planProject({
    project,
    goal: enrichedGoal,
    name: project.name,
    classification,
    clarifications: project.clarifications || []
  });
}

export async function getProject(projectId) {
  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error) throw error;

  const { data: tasks } = await supabase
    .from("tasks").select("*").eq("project_id", projectId).order("priority");
  const { data: files } = await supabase
    .from("project_files").select("path,sha,updated_at").eq("project_id", projectId);
  const { data: logs } = await supabase
    .from("logs").select("*").eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(50);
  const { data: sandboxRuns } = await supabase
    .from("sandbox_runs").select("*").eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(10);
  const { data: assets } = await supabase
    .from("project_assets")
    .select("id,type,filename,mime_type,external_url,generator,metadata,created_at")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(50);
  const { data: deliverables } = await supabase
    .from("deliverables")
    .select("id,kind,filename,storage_path,external_url,size_bytes,mime_type,generator,metadata,created_at")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(50);
  const { data: aiUsage } = await supabase
    .from("ai_usage")
    .select("role,model,input_tokens,output_tokens,estimated_cost_usd,created_at")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(100);
  const monthlySpend = await getMonthlyEstimatedSpend().catch(() => null);

  return {
    project,
    tasks: tasks || [],
    files: files || [],
    logs: logs || [],
    sandboxRuns: sandboxRuns || [],
    assets: assets || [],
    deliverables: deliverables || [],
    aiUsage: aiUsage || [],
    budget: { monthlySpend, config: getBudgetConfig() }
  };
}

export async function listProjects({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from("projects")
    .select("id,name,goal,kind,status,autonomy_mode,repo_url,vercel_url,estimated_spend_usd,awaiting_clarification,created_at,updated_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function getFiles(projectId) {
  const { data } = await supabase.from("project_files").select("*").eq("project_id", projectId);
  return data || [];
}

async function upsertFiles(projectId, files) {
  for (const file of files || []) {
    if (!file.path || typeof file.content !== "string") continue;
    if (file.path.includes("..") || file.path.startsWith("/")) continue;
    await supabase.from("project_files").upsert(
      { project_id: projectId, path: file.path, content: file.content, updated_at: new Date().toISOString() },
      { onConflict: "project_id,path" }
    );
  }
}

async function uploadDeliverables(projectId, taskId, deliverables) {
  const saved = [];
  for (const d of deliverables || []) {
    if (!d.filename || d.data == null || !d.kind) continue;
    try {
      const r = await saveDeliverable({
        projectId,
        taskId,
        kind: d.kind,
        filename: d.filename,
        data: d.data,
        mimeType: d.mimeType,
        generator: d.generator,
        metadata: d.metadata || {}
      });
      saved.push(r);
    } catch (err) {
      await logEvent({
        projectId,
        taskId,
        level: "warn",
        message: `Deliverable upload failed: ${d.filename}`,
        data: { error: err.message }
      });
    }
  }
  return saved;
}

async function verify({ project, task, result }) {
  for (const command of result.commandsToRun || []) {
    await runSandboxCommand({ projectId: project.id, taskId: task.id, command });
  }
  if (result.needsSmokeTest === true) {
    await runSmokeForProject({ projectId: project.id, taskId: task.id });
  }
}

export async function runSpecificTask(projectId, task) {
  const { data: project, error: projectError } = await supabase
    .from("projects").select("*").eq("id", projectId).single();
  if (projectError) throw projectError;

  await assertBudgetAvailable({ projectId });

  const pipeline = getPipeline(project.kind || "freeform");
  const routing = describeRouting(task);

  // Component memory lookup: see if we've built something similar before.
  let match = { decision: "fresh", reason: "Skipped (non-code pipeline).", candidates: [] };
  const isCodeTask = !(["design", "video", "docs", "specialist", "image", "assets"].includes(task.type));
  if (isCodeTask) {
    try {
      match = await matchComponent({ project, task });
    } catch (err) {
      match = { decision: "fresh", reason: `matcher error: ${err.message}`, candidates: [] };
    }
  }

  await logEvent({
    projectId, taskId: task.id,
    message: `Running task: ${task.title}`,
    data: {
      routing,
      kind: project.kind,
      libraryDecision: match.decision,
      libraryReason: match.reason,
      libraryMatch: match.chosen ? { name: match.chosen.name, similarity: match.chosen.similarity } : null
    }
  });

  try {
    let result = await pipeline.executeTask({
      project,
      task,
      existingFiles: await getFiles(projectId),
      libraryMatch: match // pipelines may consume this; webApp/staticSite/etc. accept it
    });
    result.routing = routing;
    result.libraryDecision = match.decision;
    if (match.chosen) {
      result.libraryMatch = {
        componentId: match.chosen.id,
        name: match.chosen.name,
        similarity: match.chosen.similarity
      };
      // Record the reuse event regardless of whether the developer accepted it.
      await recordReuse({
        componentId: match.chosen.id,
        projectId,
        taskId: task.id,
        similarity: match.chosen.similarity,
        decision: match.decision
      });
    }

    await upsertFiles(projectId, result.files || []);
    const savedDeliverables = await uploadDeliverables(projectId, task.id, result.deliverables || []);
    if (savedDeliverables.length) {
      result.savedDeliverables = savedDeliverables.map(d => ({ id: d.id, signedUrl: d.signedUrl, sizeBytes: d.sizeBytes }));
    }

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
          projectId, taskId: task.id,
          level: "error",
          message: "Verification failed. Running debugger.",
          data: { loop: loop + 1, error: error.message }
        });

        const fix = await debugFailure({
          project, task,
          error: error.message,
          files: await getFiles(projectId),
          loopNumber: loop + 1
        });
        await upsertFiles(projectId, fix.files || []);

        const fallbackCommands = ["npm install", "npm run build"];
        const cmds = fix.commandsToRun?.length ? fix.commandsToRun : fallbackCommands;
        for (const command of cmds) {
          try {
            await runSandboxCommand({ projectId, taskId: task.id, command });
          } catch (cmdErr) {
            await logEvent({
              projectId, taskId: task.id,
              level: "warn",
              message: `Debug command failed: ${command}`,
              data: { error: cmdErr.message }
            });
          }
        }
        result.debugFix = fix;
      }
    }

    if (!verified) throw lastError || new Error("Verification failed.");

    // Code-pipeline projects get reviewed + GitHub-pushed.
    const isCodePipeline = ["web_app", "static_site", "backend_api", "mobile_app", "script", "automation"].includes(project.kind);
    if (isCodePipeline) {
      const review = await reviewProject({
        project, task,
        files: await getFiles(projectId)
      });
      result.review = review;

      const repo = await createRepoIfNeeded(project);
      await upsertFilesToGitHub({ projectId, repoName: repo.repoName });
      await supabase.from("projects").update({
        repo_name: repo.repoName, repo_url: repo.repoUrl,
        status: "building", last_worker_heartbeat: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("id", projectId);
    }

    await supabase.from("tasks").update({
      status: "complete", result,
      assigned_worker_id: null, locked_until: null,
      updated_at: new Date().toISOString()
    }).eq("id", task.id);

    // Component extraction: save the produced files to the global library if save-worthy.
    // Skip when we just reused an existing component (no point saving a copy of itself).
    if ((result.files || []).length > 0 && match.decision !== "reuse") {
      maybeExtractComponent({ project, task, files: result.files }).catch(err => {
        console.warn("Component extraction failed:", err?.message || err);
      });
    }

    await logEvent({
      projectId, taskId: task.id,
      message: "Task complete.",
      data: { summary: result.summary, filesWritten: (result.files || []).length, deliverables: (result.deliverables || []).length, libraryDecision: match.decision }
    });

    return { task, result };
  } catch (error) {
    const maxRetries = Number(process.env.MAX_TASK_RETRIES || 3);
    const nextStatus = task.attempts >= maxRetries ? "failed" : "pending";

    await supabase.from("tasks").update({
      status: nextStatus, error: error.message,
      assigned_worker_id: null, locked_until: null,
      updated_at: new Date().toISOString()
    }).eq("id", task.id);
    await logEvent({
      projectId, taskId: task.id,
      level: "error",
      message: "Task failed.",
      data: { error: error.message, nextStatus }
    });
    throw error;
  }
}

export async function runNextTask(projectId) {
  const { data: project } = await supabase.from("projects").select("awaiting_clarification, awaiting_approval, status").eq("id", projectId).single();
  if (project?.awaiting_clarification) {
    return { done: false, message: "Project is awaiting clarification answers." };
  }
  if (project?.awaiting_approval || project?.status === "awaiting_approval") {
    return { done: false, message: "Project plan needs your approval before building. Click Approve & Build on the project page." };
  }

  const { data: task, error } = await supabase
    .from("tasks").select("*").eq("project_id", projectId)
    .eq("status", "pending").order("priority", { ascending: true })
    .limit(1).maybeSingle();
  if (error) throw error;

  if (!task) {
    // Guard: don't mark complete if there were never any tasks. That means
    // the planner produced an empty plan and we somehow got here.
    const { count: totalCount } = await supabase
      .from("tasks").select("*", { count: "exact", head: true }).eq("project_id", projectId);
    if (!totalCount || totalCount === 0) {
      await supabase.from("projects").update({
        status: "failed",
        current_stage: "plan_empty",
        updated_at: new Date().toISOString()
      }).eq("id", projectId);
      await logEvent({
        projectId,
        level: "error",
        message: "Cannot complete project with zero tasks. Marked failed. Use Refine plan to retry."
      });
      return { done: true, message: "Project has no tasks. Marked failed." };
    }

    await supabase.from("projects").update({
      status: "complete", current_stage: "complete",
      updated_at: new Date().toISOString()
    }).eq("id", projectId);
    // Record estimate vs actual for calibration.
    await recordActualCost(projectId).catch(() => null);
    await logEvent({ projectId, message: "Project complete." });

    // Auto-trigger preview deploy so the user can play with the result.
    // Only attempts if VERCEL_TOKEN is configured; failure here doesn't block completion.
    try {
      const { deployPreview } = await import("./vercel.js");
      const previewResult = await deployPreview(projectId);
      if (previewResult?.previewUrl) {
        await logEvent({ projectId, message: `Preview ready: ${previewResult.previewUrl}` });
      }
    } catch (err) {
      await logEvent({ projectId, level: "warn", message: "Auto preview deploy failed.", data: { error: err.message } });
    }

    return { done: true, message: "No pending tasks." };
  }

  await supabase.from("tasks").update({ status: "running", attempts: task.attempts + 1 }).eq("id", task.id);
  return runSpecificTask(projectId, { ...task, attempts: task.attempts + 1 });
}

/**
 * Approve a planned project so building can begin. Idempotent.
 */
export async function approveProjectPlan(projectId) {
  const { data: project, error } = await supabase
    .from("projects").select("id, status, awaiting_approval").eq("id", projectId).single();
  if (error) throw error;
  if (project.status === "complete" || project.status === "building") {
    return { ok: true, alreadyRunning: true };
  }
  // Guard: don't approve a plan that has zero tasks attached.
  const { count: taskCount } = await supabase
    .from("tasks").select("*", { count: "exact", head: true }).eq("project_id", projectId);
  if (!taskCount || taskCount === 0) {
    throw new Error("This project has no tasks to build. The plan came back empty — use Refine plan with notes, or delete and recreate the project.");
  }
  await supabase.from("projects").update({
    awaiting_approval: false,
    approved_at: new Date().toISOString(),
    status: "planned",
    current_stage: "planned",
    updated_at: new Date().toISOString()
  }).eq("id", projectId);
  await logEvent({ projectId, message: "Plan approved by user. Build can start." });
  return { ok: true };
}

/**
 * Refine the plan: discard existing tasks, store user notes, and replan with cheap planner.
 * Only the planner runs (no developer/designer credits) so iteration is cheap.
 */
export async function refineProjectPlan(projectId, notes) {
  const { data: project, error } = await supabase
    .from("projects").select("*").eq("id", projectId).single();
  if (error) throw error;

  // Wipe pending tasks from the previous draft.
  await supabase.from("tasks").delete().eq("project_id", projectId);

  await supabase.from("projects").update({
    refine_notes: notes || null,
    plan_revision: (project.plan_revision || 1) + 1,
    updated_at: new Date().toISOString()
  }).eq("id", projectId);

  await logEvent({
    projectId,
    message: `Plan refinement requested (revision ${(project.plan_revision || 1) + 1}).`,
    data: { notes }
  });

  const refinedGoal = `${project.goal}\n\nRefinement notes from user (revision ${(project.plan_revision || 1) + 1}):\n${notes || "(no notes)"}`;

  const classification = {
    kind: project.kind || "web_app",
    suggestedName: project.name,
    confidence: 1
  };

  return await planProject({
    project,
    goal: refinedGoal,
    name: project.name,
    classification,
    clarifications: project.clarifications || []
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
  return { projectId, steps: results.length, results };
}
