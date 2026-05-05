const WORKER_ID = "worker-" + Math.random().toString(36).slice(2);

async function startWorker() {
  console.log("Worker started:", WORKER_ID);

  while (true) {
    try {
      const { supabase } = await import("./lib/supabase.js");
      const { runNextTask } = await import("./services/orchestrator.js");

      // Get ONE pending task
      const { data: task } = await supabase
        .from("tasks")
        .select("*")
        .eq("status", "pending")
        .is("assigned_worker_id", null)
        .order("priority", { ascending: true })
        .limit(1)
        .single();

      if (!task) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      console.log("Claiming task:", task.title);

      // Lock it
      await supabase
        .from("tasks")
        .update({
          status: "running",
          assigned_worker_id: WORKER_ID,
          locked_until: new Date(Date.now() + 60000).toISOString()
        })
        .eq("id", task.id)
        .is("assigned_worker_id", null);

      // Run it
      await runNextTask(task.project_id);

      console.log("Completed task:", task.title);

      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error("Worker error:", err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

startWorker();
