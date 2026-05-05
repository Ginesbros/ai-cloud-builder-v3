import http from "http";
import dotenv from "dotenv";
dotenv.config();

const WORKER_ID =
  process.env.WORKER_ID || "worker-" + Math.random().toString(36).slice(2);
const PORT = process.env.PORT || 3001;
const POLL_MS = Number(process.env.WORKER_POLL_MS || 10000);

http
  .createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "ai-cloud-builder-worker",
        worker: WORKER_ID,
        time: new Date().toISOString()
      })
    );
  })
  .listen(PORT, () => {
    console.log(`Worker health server running on port ${PORT}`);
  });

async function startWorker() {
  console.log("Worker started:", WORKER_ID);

  // Lazy imports so the health server starts even if Supabase is mis-configured.
  const { claimNextTask } = await import("./services/taskLocks.js");
  const { runSpecificTask } = await import("./services/orchestrator.js");
  const { supabase } = await import("./lib/supabase.js");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const task = await claimNextTask({ workerId: WORKER_ID });

      if (!task) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        continue;
      }

      console.log("Claimed task:", task.title, task.id);
      try {
        await runSpecificTask(task.project_id, task);
        console.log("Completed task:", task.title);
      } catch (err) {
        console.error("Task execution failed:", err?.message || err);
      }

      // Heartbeat so dashboards can show worker activity.
      await supabase
        .from("projects")
        .update({ last_worker_heartbeat: new Date().toISOString() })
        .eq("id", task.project_id);

      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      console.error("Worker loop error:", err?.message || err);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

if (process.env.WORKER_ENABLED !== "false") {
  startWorker();
} else {
  console.log("Worker disabled via WORKER_ENABLED=false");
}
