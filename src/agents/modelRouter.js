/**
 * Model router — central dispatch table.
 *
 * Two related decisions live here:
 *   1. getProviderForRole(role)  → which provider/client to call (openai|anthropic|...)
 *   2. getModelForRole(role, taskType?) → which model id to pass to that provider
 *
 * Everything is overridable via env so you can tune without touching code.
 * See docs/ROLE_MATRIX.md for the full design.
 */

// --- Provider routing per high-level role ---
export function getProviderForRole(role) {
  const r = (role || "").toLowerCase();
  if (r === "planner") return process.env.PLANNER_PROVIDER || "anthropic";
  if (r === "debugger") return process.env.DEBUGGER_PROVIDER || "openai";
  if (r === "developer") return process.env.DEVELOPER_PROVIDER || "openai";
  if (r === "reviewer") return "panel"; // claude + gemini + grok in parallel
  if (r === "designer") return "nano_banana";
  if (r === "videographer") return "higgsfield";
  if (r === "specialist") return "manus";
  if (r === "librarian") return "notebooklm";
  if (r === "research") return "perplexity";
  return "openai";
}

// --- Developer model picked by task type ---
const DEV_TYPE_MODEL_OVERRIDES = {
  setup: process.env.DEV_SETUP_MODEL,
  frontend: process.env.DEV_FRONTEND_MODEL,
  backend: process.env.DEV_BACKEND_MODEL,
  database: process.env.DEV_DATABASE_MODEL,
  integration: process.env.DEV_INTEGRATION_MODEL,
  test: process.env.DEV_TEST_MODEL,
  deploy: process.env.DEV_DEPLOY_MODEL
};

const DEV_TYPE_DEFAULTS = {
  setup: "gpt-4.1-mini",
  frontend: "gpt-4.1-mini",
  backend: "gpt-4.1",
  database: "gpt-4.1",
  integration: "gpt-4.1",
  test: "gpt-4.1-mini",
  deploy: "gpt-4.1-mini"
};

export function getDeveloperModel(taskType) {
  const t = (taskType || "development").toLowerCase();
  return (
    DEV_TYPE_MODEL_OVERRIDES[t] ||
    DEV_TYPE_DEFAULTS[t] ||
    process.env.DEV_DEFAULT_MODEL ||
    process.env.OPENAI_DEVELOPER_MODEL ||
    "gpt-4.1-mini"
  );
}

// --- Top-level model id for a (role, taskType) tuple ---
export function getModelForRole(role, taskType = null) {
  const r = (role || "").toLowerCase();

  if (r === "planner") {
    return process.env.PLANNER_MODEL || "claude-opus-4-7";
  }
  if (r === "developer") {
    return getDeveloperModel(taskType);
  }
  if (r === "debugger") {
    return process.env.OPENAI_DEBUGGER_MODEL || "gpt-4.1";
  }
  if (r === "reviewer") {
    // Reviewer is a panel — return a label, individual clients pick their own model.
    return "panel";
  }
  if (r === "designer") {
    return process.env.NANO_BANANA_MODEL || "gemini-3.1-flash-image-preview";
  }
  if (r === "videographer") {
    return process.env.HIGGSFIELD_MODEL || "higgsfield-v1";
  }
  if (r === "specialist") {
    return process.env.MANUS_MODEL || "manus-v1";
  }
  if (r === "librarian") {
    return process.env.NOTEBOOKLM_MODEL || "notebooklm";
  }
  if (r === "research") {
    return process.env.PERPLEXITY_MODEL || "sonar-pro";
  }
  // Reviewer sub-roles (used by reviewer.js):
  if (r === "reviewer_claude") {
    return process.env.REVIEWER_CLAUDE_MODEL || process.env.CLAUDE_REVIEWER_MODEL || "claude-sonnet-4-6";
  }
  if (r === "reviewer_gemini") {
    return process.env.REVIEWER_GEMINI_MODEL || process.env.GEMINI_ANALYZER_MODEL || "gemini-2.5-pro";
  }
  if (r === "reviewer_grok") {
    return process.env.REVIEWER_GROK_MODEL || process.env.GROK_REVIEWER_MODEL || "grok-4";
  }

  return process.env.OPENAI_DEFAULT_MODEL || "gpt-4.1-mini";
}

/**
 * Decide which agent function should handle a task.
 * Returns one of: "developer" | "designer" | "videographer" | "specialist" | "librarian"
 *
 * The orchestrator uses this to dispatch to the right agent module.
 */
export function getAgentForTaskType(taskType) {
  const t = (taskType || "development").toLowerCase();
  if (t === "design" || t === "assets" || t === "image") return "designer";
  if (t === "video") return "videographer";
  if (t === "specialist" || t === "long_running") return "specialist";
  if (t === "docs" || t === "research_docs") return "librarian";
  // Everything else (setup/frontend/backend/database/integration/test/deploy)
  // goes to the OpenAI developer agent.
  return "developer";
}

/**
 * Return a flat object describing the entire routing decision for a task.
 * Useful for logging and for dashboard display.
 */
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
