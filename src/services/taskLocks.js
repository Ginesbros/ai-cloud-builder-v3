import { supabase } from "../lib/supabase.js";

export async function claimNextTask({ workerId }) {
  const lockMinutes = Number(process.env.TASK_LOCK_MINUTES || 20);
  const lockUntil = new Date(Date.now() + lockMinutes * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabase
    .from("tasks")
    .select("*, projects!inner(*)")
    .eq("status", "pending")
    .in("projects.status", ["planned", "building"])
    .in("projects.autonomy_mode", ["dev", "autonomous"])
    .order("priority", { ascending: true })
    .limit(5);

  if (error) throw error;

  if (!candidates || candidates.length === 0) {
    return null;
  }

  for (const task of candidates) {
    const { data: updated, error: updateError } = await supabase
      .from("tasks")
      .update({
        status: "running",
        assigned_worker_id: workerId,
        locked_until: lockUntil,
        attempts: task.attempts + 1,
        updated_at: new Date().toISOString()
      })
      .eq("id", task.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();

    if (!updateError && updated) {
      return updated;
    }
  }

  return null;
}
