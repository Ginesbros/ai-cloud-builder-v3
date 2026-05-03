export function getModelForRole(role) {
  const normalized = role.toLowerCase();

  if (normalized === "planner") {
    return process.env.OPENAI_PLANNER_MODEL || "gpt-4.1";
  }

  if (normalized === "developer") {
    return process.env.OPENAI_DEVELOPER_MODEL || "gpt-4.1-mini";
  }

  if (normalized === "debugger") {
    return process.env.OPENAI_DEBUGGER_MODEL || "gpt-4.1";
  }

  if (normalized === "reviewer") {
    return process.env.OPENAI_REVIEWER_MODEL || "gpt-4.1-mini";
  }

  return process.env.OPENAI_DEFAULT_MODEL || "gpt-4.1-mini";
}
