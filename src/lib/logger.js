import { supabase } from "./supabase.js";

export async function logEvent({
  projectId,
  taskId = null,
  level = "info",
  message,
  data = null
}) {
  try {
    await supabase.from("logs").insert({
      project_id: projectId,
      task_id: taskId,
      level,
      message,
      data
    });
  } catch (err) {
    // Never let logging break execution.
    console.error("logEvent failed:", err?.message || err);
  }

  // Mirror to stdout for Render log streams.
  const stamp = new Date().toISOString();
  const tag = `[${level.toUpperCase()}]`;
  console.log(`${stamp} ${tag} project=${projectId} task=${taskId || "-"} ${message}`);
}
