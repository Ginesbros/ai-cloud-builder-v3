import { supabase } from "./supabase.js";

export async function logEvent({
  projectId,
  taskId = null,
  level = "info",
  message,
  data = null
}) {
  await supabase.from("logs").insert({
    project_id: projectId,
    task_id: taskId,
    level,
    message,
    data
  });
}
