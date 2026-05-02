import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { claimNextTask } from "./services/taskLocks.js";
import { runSpecificTask } from "./services/orchestrator.js";

dotenv.config();

const workerId = process.env.WORKER_ID || `worker-${uuidv4().slice(0, 8)}`;
const pollMs = Number(process.env.WORKER_POLL_MS || 10000);
const concurrency = Number(process.env.WORKER_CONCURRENCY || 1);
const enabled = process.env.WORKER_ENABLED !== "false";

const active = new Set();

async function runClaimedTask(task) {
  active.add(task.id);

  try {
    await runSpecificTask(task.project_id, task);
  } catch (error) {
    console.error("Worker task error:", error.message);
  } finally {
    active.delete(task.id);
  }
}

async function loop() {
  if (!enabled) {
    console.log("Worker disabled.");
    return;
  }

  console.log(`Worker started: ${workerId}, concurrency=${concurrency}`);

  while (true) {
    try {
      while (active.size < concurrency) {
        const task = await claimNextTask({ workerId });
        if (!task) break;
        runClaimedTask(task);
      }
    } catch (error) {
      console.error("Worker loop error:", error.message);
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

loop();
