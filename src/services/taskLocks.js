import { supabase } from "../lib/supabase.js";

/**
 * Atomically claim the next pending task — including stale running tasks
 * whose lock has expired (recovery from crashed workers).
 *
 * Strategy:
 *  1. Pull a small batch of candidates that are either:
 *     - status='pending' with no assigned worker, OR
 *     - status='running' with locked_until < now() (stale)
 *  2. For each candidate, attempt an atomic UPDATE that asserts the original
 *     state via WHERE clause. Whichever update succeeds wins.
 */
export async function claimNextTask({ workerId }) {
  const lockMinutes = Number(process.env.TASK_LOCK_MINUTES || 20);
  const lockUntil = new Date(Date.now() + lockMinutes * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  // Pending candidates first.
  const { data: pending, error: pendingErr } = await supabase
    .from("tasks")
    .select("*, projects!inner(*)")
    .eq("status", "pending")
    .is("assigned_worker_id", null)
    .in("projects.status", ["planned", "building"])
    .in("projects.autonomy_mode", ["dev", "autonomous"])
    .order("priority", { ascending: true })
    .limit(5);
  if (pendingErr) throw pendingErr;

  for (const task of pending || []) {
    const { data: updated, error: updateErr } = await supabase
      .from("tasks")
      .update({
        status: "running",
        assigned_worker_id: workerId,
        locked_until: lockUntil,
        attempts: (task.attempts || 0) + 1,
        updated_at: nowIso
      })
      .eq("id", task.id)
      .eq("status", "pending")
      .is("assigned_worker_id", null)
      .select("*")
      .maybeSingle();
    if (!updateErr && updated) return updated;
  }

  // Stale running candidates (worker crashed mid-task).
  const { data: stale, error: staleErr } = await supabase
    .from("tasks")
    .select("*, projects!inner(*)")
    .eq("status", "running")
    .lt("locked_until", nowIso)
    .in("projects.status", ["planned", "building"])
    .in("projects.autonomy_mode", ["dev", "autonomous"])
    .order("priority", { ascending: true })
    .limit(5);
  if (staleErr) throw staleErr;

  for (const task of stale || []) {
    const { data: updated, error: updateErr } = await supabase
      .from("tasks")
      .update({
        status: "running",
        assigned_worker_id: workerId,
        locked_until: lockUntil,
        attempts: (task.attempts || 0) + 1,
        updated_at: nowIso
      })
      .eq("id", task.id)
      .eq("status", "running")
      .lt("locked_until", nowIso)
      .select("*")
      .maybeSingle();
    if (!updateErr && updated) return updated;
  }

  return null;
}
