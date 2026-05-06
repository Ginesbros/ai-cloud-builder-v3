/**
 * Model router — central dispatch table.
 *
 * Design principle (after the snake-game silent-success bug):
 *   Each provider has its OWN model map. Cross-provider mixing is impossible.
 *   When a client (claudeClient, openaiClient, etc.) asks for a model, it
 *   only ever gets a model ID belonging to its own provider.
 *
 * Env vars are still respected, but they're validated against the provider
 * — an env var trying to set a Claude model on the OpenAI side is ignored
 * with a warning.
 */

// === Per-provider model maps ===
// Each map's keys are roles. Values are model IDs valid for that provider.

const ANTHROPIC_MODELS = {
  // Verified live on Anthropic's /v1/models endpoint as of May 2026.
  planner: process.env.PLANNER_MODEL_ANTHROPIC || "claude-opus-4-7",
  reviewer: process.env.REVIEWER_MODEL_ANTHROPIC || "claude-sonnet-4-6",
  haiku: process.env.HAIKU_MODEL_ANTHROPIC || "claude-haiku-4-5"
};

const OPENAI_MODELS = {
  // Default to mini everywhere so a single task can't blow past free-tier TPM.
  // Debugger escalates to full gpt-4.1 only on retry.
  planner: process.env.PLANNER_MODEL_OPENAI || "gpt-4.1",         // OpenAI fallback if Claude unavailable
  developer_default: process.env.DEV_DEFAULT_MODEL_OPENAI || "gpt-4.1-mini",
  developer_setup: process.env.DEV_SETUP_MODEL_OPENAI || "gpt-4.1-mini",
  developer_frontend: process.env.DEV_FRONTEND_MODEL_OPENAI || "gpt-4.1-mini",
  developer_backend: process.env.DEV_BACKEND_MODEL_OPENAI || "gpt-4.1-mini",
  developer_database: process.env.DEV_DATABASE_MODEL_OPENAI || "gpt-4.1-mini",
  developer_integration: process.env.DEV_INTEGRATION_MODEL_OPENAI || "gpt-4.1-mini",
  developer_test: process.env.DEV_TEST_MODEL_OPENAI || "gpt-4.1-mini",
  developer_deploy: process.env.DEV_DEPLOY_MODEL_OPENAI || "gpt-4.1-mini",
  debugger: process.env.OPENAI_DEBUGGER_MODEL_VALIDATED || "gpt-4.1-mini",
  classifier: "gpt-4.1-mini"
};

const GEMINI_MODELS = {
  reviewer: process.env.REVIEWER_MODEL_GEMINI || "gemini-2.5-pro",
  designer: process.env.NANO_BANANA_MODEL_GEMINI || "gemini-3.1-flash-image-preview",
  librarian: process.env.NOTEBOOKLM_MODEL_GEMINI || "gemini-2.5-pro"
};

const GROK_MODELS = {
  reviewer: process.env.REVIEWER_MODEL_GROK || "grok-4"
};

const PERPLEXITY_MODELS = {
  research: process.env.PERPLEXITY_MODEL || "sonar-pro"
};

// Validators — guarantee a model ID belongs to its provider.
function isOpenAiId(m) {
  if (typeof m !== "string") return false;
  const lower = m.toLowerCase();
  return lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") ||
         lower.startsWith("o4") || lower.startsWith("chatgpt-");
}
function isAnthropicId(m) {
  return typeof m === "string" && m.toLowerCase().startsWith("claude-");
}
function isGeminiId(m) {
  return typeof m === "string" && m.toLowerCase().startsWith("gemini-");
}
function isGrokId(m) {
  return typeof m === "string" && m.toLowerCase().startsWith("grok-");
}

const VALIDATORS = {
  openai: isOpenAiId,
  anthropic: isAnthropicId,
  gemini: isGeminiId,
  grok: isGrokId
};

const FALLBACKS = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-2.5-pro",
  grok: "grok-4"
};

// Per-provider role lookup with strict validation.
export function getModelForProvider(provider, role, taskType = null) {
  const p = (provider || "").toLowerCase();
  const r = (role || "").toLowerCase();
  let map;
  if (p === "anthropic") map = ANTHROPIC_MODELS;
  else if (p === "openai") map = OPENAI_MODELS;
  else if (p === "gemini") map = GEMINI_MODELS;
  else if (p === "grok") map = GROK_MODELS;
  else if (p === "perplexity") map = PERPLEXITY_MODELS;
  else map = OPENAI_MODELS;

  let model;
  if (p === "openai" && r === "developer") {
    const t = (taskType || "default").toLowerCase();
    model = map[`developer_${t}`] || map.developer_default;
  } else {
    model = map[r];
  }

  // Validate the chosen model truly belongs to its provider.
  const validator = VALIDATORS[p];
  if (validator && !validator(model)) {
    console.warn(`[modelRouter] role=${role} provider=${provider} got non-${p} model id "${model}". Falling back to ${FALLBACKS[p]}.`);
    model = FALLBACKS[p];
  }

  return model || FALLBACKS[p] || "gpt-4.1-mini";
}

// === Legacy compat layer ===
// Old code still calls getProviderForRole + getModelForRole. Keep them but
// route through the strict per-provider map.

export function getProviderForRole(role) {
  const r = (role || "").toLowerCase();
  if (r === "planner") return process.env.PLANNER_PROVIDER || "anthropic";
  if (r === "debugger") return "openai";
  if (r === "developer") return "openai";
  if (r === "reviewer") return "panel";
  if (r === "designer") return "gemini";
  if (r === "videographer") return "higgsfield";
  if (r === "specialist") return "manus";
  if (r === "librarian") return "gemini";
  if (r === "research") return "perplexity";
  if (r === "reviewer_claude") return "anthropic";
  if (r === "reviewer_gemini") return "gemini";
  if (r === "reviewer_grok") return "grok";
  if (r === "classifier") return "openai";
  return "openai";
}

export function getModelForRole(role, taskType = null) {
  const r = (role || "").toLowerCase();
  // Reviewer panel: callers expect a label, not a model id.
  if (r === "reviewer") return "panel";

  const provider = getProviderForRole(r);
  // Map composite roles to per-provider role keys.
  let providerRole = r;
  if (r === "reviewer_claude") providerRole = "reviewer";
  if (r === "reviewer_gemini") providerRole = "reviewer";
  if (r === "reviewer_grok") providerRole = "reviewer";
  return getModelForProvider(provider, providerRole, taskType);
}

export function getDeveloperModel(taskType) {
  return getModelForProvider("openai", "developer", taskType);
}

// === Agent dispatch (unchanged) ===
export function getAgentForTaskType(taskType) {
  const t = (taskType || "development").toLowerCase();
  if (t === "design" || t === "assets" || t === "image") return "designer";
  if (t === "video") return "videographer";
  if (t === "specialist" || t === "long_running") return "specialist";
  if (t === "docs" || t === "research_docs") return "librarian";
  return "developer";
}

export function describeRouting(task) {
  const taskType = task?.type || "development";
  const agent = getAgentForTaskType(taskType);
  let role;
  if (agent === "developer") role = "developer";
  else if (agent === "designer") role = "designer";
  else if (agent === "videographer") role = "videographer";
  else if (agent === "specialist") role = "specialist";
  else if (agent === "librarian") role = "librarian";
  else role = "developer";

  return {
    taskType,
    agent,
    role,
    provider: getProviderForRole(role),
    model: getModelForRole(role, taskType)
  };
}
