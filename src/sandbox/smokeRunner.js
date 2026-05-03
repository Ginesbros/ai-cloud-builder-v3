import { execa } from "execa";
import { prepareSandbox } from "./sandboxManager.js";
import { logEvent } from "../lib/logger.js";
import { runDefaultSmokeTest } from "../tests/defaultSmoke.js";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runSmokeForProject({
  projectId,
  taskId = null
}) {
  const dir = await prepareSandbox(projectId);
  const port = Number(process.env.APP_PORT || 4173);
  let server;

  try {
    await logEvent({
      projectId,
      taskId,
      message: "Starting smoke server."
    });

    server = execa("npx", [
      "vite",
      "--host",
      "0.0.0.0",
      "--port",
      String(port)
    ], {
      cwd: dir,
      reject: false,
      env: {
        CI: "true"
      }
    });

    await wait(5000);

    const result = await runDefaultSmokeTest(`http://127.0.0.1:${port}`);

    await logEvent({
      projectId,
      taskId,
      message: "Smoke test passed.",
      data: result
    });

    return result;
  } catch (error) {
    await logEvent({
      projectId,
      taskId,
      level: "error",
      message: "Smoke test failed.",
      data: {
        error: error.message
      }
    });

    throw error;
  } finally {
    if (server) {
      server.kill("SIGTERM", {
        forceKillAfterDelay: 2000
      });
    }
  }
}
