import { supabase } from "../lib/supabase.js";
import { logEvent } from "../lib/logger.js";

export function getBudgetConfig() {
  const mode = process.env.BUDGET_MODE || "starter_400";
  const monthlyBudget = Number(
    process.env.MONTHLY_BUDGET_USD || (mode === "scale_1000" ? 1000 : 400)
  );

  return {
    mode,
    monthlyBudget,
    softLimit: monthlyBudget * (Number(process.env.SOFT_BUDGET_PERCENT || 80) / 100),
    hardLimit: monthlyBudget * (Number(process.env.HARD_BUDGET_PERCENT || 100) / 100)
  };
}

export function estimateCost({ role, inputTokens = 0, outputTokens = 0 }) {
  const prefix = (role || "").toUpperCase();
  const inRate = Number(process.env[`COST_${prefix}_INPUT_PER_1M`] || 0);
  const outRate = Number(process.env[`COST_${prefix}_OUTPUT_PER_1M`] || 0);
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

export async function recordAiUsage({
  projectId,
  taskId = null,
  role,
  model,
  inputTokens = 0,
  outputTokens = 0
}) {
  const estimatedCost = estimateCost({ role, inputTokens, outputTokens });

  await supabase.from("ai_usage").insert({
    project_id: projectId,
    task_id: taskId,
    role,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: estimatedCost
  });

  if (projectId) {
    const { data } = await supabase
      .from("projects")
      .select("estimated_spend_usd")
      .eq("id", projectId)
      .single();

    const next = Number(data?.estimated_spend_usd || 0) + estimatedCost;
    await supabase
      .from("projects")
      .update({
        estimated_spend_usd: next,
        updated_at: new Date().toISOString()
      })
      .eq("id", projectId);
  }

  return estimatedCost;
}

export async function getMonthlyEstimatedSpend() {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("ai_usage")
    .select("estimated_cost_usd")
    .gte("created_at", start.toISOString());
  if (error) throw error;

  return (data || []).reduce(
    (sum, row) => sum + Number(row.estimated_cost_usd || 0),
    0
  );
}

export async function assertBudgetAvailable({ projectId }) {
  const cfg = getBudgetConfig();
  const spend = await getMonthlyEstimatedSpend();

  if (spend >= cfg.hardLimit) {
    await logEvent({
      projectId,
      level: "error",
      message: "Hard monthly budget limit reached.",
      data: { spend, budget: cfg.monthlyBudget }
    });
    await supabase.from("budget_events").insert({
      project_id: projectId,
      level: "hard",
      message: "Hard monthly budget limit reached.",
      estimated_monthly_spend_usd: spend,
      budget_usd: cfg.monthlyBudget
    });
    throw new Error(
      `Hard budget limit reached: estimated $${spend.toFixed(2)} / $${cfg.monthlyBudget}`
    );
  }

  if (spend >= cfg.softLimit) {
    await logEvent({
      projectId,
      level: "warn",
      message: "Soft monthly budget warning.",
      data: { spend, budget: cfg.monthlyBudget }
    });
    await supabase.from("budget_events").insert({
      project_id: projectId,
      level: "soft",
      message: "Soft monthly budget warning.",
      estimated_monthly_spend_usd: spend,
      budget_usd: cfg.monthlyBudget
    });
  }

  return { spend, ...cfg };
}
