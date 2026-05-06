/**
 * Cost estimator — predicts what a build will cost before running it.
 *
 * Strategy:
 *   1. Embed the goal + pipeline kind + task count.
 *   2. Find up to 5 completed past projects with cosine similarity > 0.6
 *      and the SAME pipeline kind.
 *   3. If >=2 comparables found → historical estimate (similarity-weighted avg).
 *   4. If <2 comparables → fallback to LLM estimate (Claude reads the plan,
 *      predicts cost based on its rate-card knowledge of the models we use).
 *   5. Return { low, expected, high, method, comparables?, confidence }.
 *
 * Calibration loop:
 *   After a build completes, we compare the estimate vs the actual and
 *   log both to cost_estimate.accuracy_log. Over time, historical estimates
 *   become dramatically more accurate as the comparables pool grows.
 */

import { supabase } from "../lib/supabase.js";
import { embedText } from "../agents/embeddings.js";
import { askClaude } from "../agents/claudeClient.js";
import { askOpenAI } from "../agents/openaiClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";
import { logEvent } from "../lib/logger.js";

const MIN_COMPARABLES = 2;
const SIMILARITY_THRESHOLD = 0.6;

function goalEmbeddingText(project) {
  const plan = project.plan || {};
  const taskTitles = (plan.tasks || []).map(t => `${t.type}: ${t.title}`).join("; ");
  return [
    `Kind: ${project.kind || "web_app"}`,
    `Goal: ${(project.goal || "").slice(0, 600)}`,
    `Tasks (${(plan.tasks || []).length}): ${taskTitles}`
  ].join("\n");
}

async function findComparables(project) {
  const embedding = await embedText(goalEmbeddingText(project), {
    projectId: project.id
  });
  if (!embedding) return { embedding: null, comparables: [] };

  const { data, error } = await supabase.rpc("match_projects", {
    query_embedding: embedding,
    match_threshold: SIMILARITY_THRESHOLD,
    match_count: 5,
    filter_kind: project.kind || null
  });

  if (error) {
    await logEvent({
      projectId: project.id,
      level: "warn",
      message: "Comparables search failed.",
      data: { error: error.message }
    });
    return { embedding, comparables: [] };
  }

  // Filter out projects with no recorded actual cost (can't use for estimate).
  const usable = (data || []).filter(c => Number(c.actual_cost_usd || c.estimated_spend_usd) > 0);
  return { embedding, comparables: usable };
}

function historicalEstimate(comparables) {
  // Similarity-weighted average of actual_cost_usd (fallback to estimated_spend_usd).
  const weighted = comparables.map(c => ({
    cost: Number(c.actual_cost_usd || c.estimated_spend_usd || 0),
    similarity: Number(c.similarity || 0.6),
    name: c.name,
    id: c.id
  }));

  const totalWeight = weighted.reduce((s, c) => s + c.similarity, 0) || 1;
  const expected =
    weighted.reduce((s, c) => s + c.cost * c.similarity, 0) / totalWeight;

  // Range: min cost / max cost across comparables (simple but honest).
  const costs = weighted.map(c => c.cost).sort((a, b) => a - b);
  const low = costs[0];
  const high = costs[costs.length - 1];

  // Confidence grows with sample size and tightness of cost spread.
  const spread = high - low;
  const spreadRatio = expected > 0 ? spread / expected : 1;
  const confidence = Math.min(
    0.95,
    Math.max(0.3, 0.3 + (comparables.length - 1) * 0.15 - spreadRatio * 0.2)
  );

  return {
    method: "historical",
    low,
    expected,
    high,
    confidence,
    comparables: weighted.map(c => ({
      id: c.id,
      name: c.name,
      cost: c.cost,
      similarity: c.similarity
    }))
  };
}

async function llmEstimate(project) {
  const plan = project.plan || {};
  const tasks = plan.tasks || [];

  const system =
    "You are a cost estimator for an autonomous software-building platform. Return strict JSON only.";
  const user = `
Estimate the total AI API cost to execute this build end-to-end.

Pipeline kind: ${project.kind || "web_app"}
Goal: ${project.goal}
Task count: ${tasks.length}
Tasks: ${JSON.stringify(tasks.map(t => ({ type: t.type, title: t.title })))}

Model cost reference (per 1M tokens):
- Claude Opus (planner): $15 input / $75 output, typical 2-6k tokens per plan
- GPT-4.1 (backend/db/debug): $2 input / $8 output, typical 3-8k tokens per call
- GPT-4.1-mini (frontend/setup/test/deploy): $0.40 input / $1.60 output, typical 3-8k tokens per call
- Claude Sonnet + Gemini 2.5 Pro + Grok 4 (reviewer panel): ~$0.01 each, runs once per successful task
- Perplexity Sonar: flat $0.01 per research call, runs once in planner
- Nano Banana (image gen): $0.04 per image, runs 1-5 times for design tasks
- Higgsfield (video): $0.60 per 6-second video

Typical build costs:
- static_site, 5 tasks: $0.40-$1.50
- web_app with reviewer panel, 8 tasks, 2 design tasks: $2-$6
- backend_api, 8 tasks: $3-$8
- research_report, 5 tasks: $1-$3
- design_kit, 5 image generations: $0.50-$1.50
- video, 4 scenes: $2-$6

Account for: debug retries (~15% of tasks fail once and retry), reviewer panel calls, embedding calls for component memory.

Return JSON:
{
  "low": 0.00,
  "expected": 0.00,
  "high": 0.00,
  "reasoning": "1-2 sentence breakdown"
}
Costs in USD. low = optimistic, expected = most likely, high = if 2 debug loops trigger on multiple tasks.
`;

  let raw = await askClaude({
    role: "reviewer",
    system,
    user,
    json: true,
    projectId: project.id,
    maxTokens: 1024
  });
  let parsed = safeParseJson(raw, null);
  if (!parsed) {
    raw = await askOpenAI({
      role: "reviewer",
      system,
      user,
      json: true,
      projectId: project.id
    });
    parsed = safeParseJson(raw, null);
  }

  if (!parsed || typeof parsed.expected !== "number") {
    // Hard fallback: crude per-task estimate.
    const n = tasks.length || 5;
    return {
      method: "fallback",
      low: 0.40 * n * 0.6,
      expected: 0.40 * n,
      high: 0.40 * n * 1.8,
      confidence: 0.2,
      reasoning: "Fallback: no LLM response; used $0.40 × task count."
    };
  }

  return {
    method: "llm",
    low: Number(parsed.low) || 0,
    expected: Number(parsed.expected) || 0,
    high: Number(parsed.high) || 0,
    confidence: 0.45,
    reasoning: parsed.reasoning
  };
}

/**
 * Main entry point: estimate a project's total build cost.
 */
export async function estimateProjectCost(projectId) {
  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project) throw new Error("Project not found for estimate.");

  // Gather comparables.
  const { embedding, comparables } = await findComparables(project);

  // Persist the project embedding so it helps future comparables lookups
  // as soon as THIS build completes.
  if (embedding) {
    await supabase
      .from("projects")
      .update({ embedding, updated_at: new Date().toISOString() })
      .eq("id", projectId)
      .then(() => null, () => null);
  }

  let estimate;
  if (comparables.length >= MIN_COMPARABLES) {
    estimate = historicalEstimate(comparables);
  } else {
    estimate = await llmEstimate(project);
    // If we have 1 comparable, still include it as context.
    if (comparables.length === 1) {
      estimate.comparables = [{
        id: comparables[0].id,
        name: comparables[0].name,
        cost: Number(comparables[0].actual_cost_usd || comparables[0].estimated_spend_usd || 0),
        similarity: Number(comparables[0].similarity || 0.6)
      }];
    }
  }

  // Round cleanly.
  estimate.low = Math.round(estimate.low * 100) / 100;
  estimate.expected = Math.round(estimate.expected * 100) / 100;
  estimate.high = Math.round(estimate.high * 100) / 100;
  estimate.generatedAt = new Date().toISOString();

  await supabase
    .from("projects")
    .update({
      cost_estimate: estimate,
      updated_at: new Date().toISOString()
    })
    .eq("id", projectId);

  await logEvent({
    projectId,
    message: `Cost estimate: $${estimate.expected.toFixed(2)} (${estimate.method}, ${comparables.length} comparables)`,
    data: estimate
  });

  return estimate;
}

/**
 * Called when a project completes — records estimate vs actual for calibration.
 */
export async function recordActualCost(projectId) {
  const { data: project } = await supabase
    .from("projects")
    .select("cost_estimate,estimated_spend_usd")
    .eq("id", projectId)
    .single();
  if (!project) return null;

  const actual = Number(project.estimated_spend_usd || 0);
  const estimate = project.cost_estimate || null;

  const accuracyEntry = {
    projectId,
    actual,
    estimated: estimate?.expected || null,
    method: estimate?.method || null,
    errorPct: estimate?.expected
      ? Math.round(((actual - estimate.expected) / estimate.expected) * 100)
      : null,
    completedAt: new Date().toISOString()
  };

  // Persist actual on project row so comparables search can use it.
  await supabase
    .from("projects")
    .update({
      actual_cost_usd: actual,
      cost_estimate: estimate ? { ...estimate, accuracy: accuracyEntry } : null,
      updated_at: new Date().toISOString()
    })
    .eq("id", projectId);

  return accuracyEntry;
}
