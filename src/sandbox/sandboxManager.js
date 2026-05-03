import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { supabase } from "../lib/supabase.js";
import { logEvent } from "../lib/logger.js";
import { assertCommandAllowed } from "./commandPolicy.js";

const ROOT = process.env.SANDBOX_ROOT || "/tmp/ai-builder-sandboxes";
const TIMEOUT = Number(process.env.SANDBOX_TIMEOUT_MS || 120000);
const MAX = Number(process.env.SANDBOX_MAX_OUTPUT_CHARS || 12000);

function safe(rel) {
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
    throw new Error(`Unsafe path ${rel}`);
  }

  return rel;
}

export async function prepareSandbox(projectId) {
  const dir = path.join(ROOT, projectId);
  await fs.mkdir(dir, { recursive: true });

  const { data, error } = await supabase
    .from("project_files")
    .select("path,content")
    .eq("project_id", projectId);

  if (error) throw error;

  for (const file of data || []) {
    const fp = path.join(dir, safe(file.path));
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, file.content, "utf8");
  }

  return dir;
}

async function walk(dir) {
  const out = [];

  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...await walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }

  return out;
}

export async function syncSandboxToSupabase(projectId, dir) {
  const skip = ["node_modules", ".git", "dist", ".next", "coverage"];

  for (const fp of await walk(dir)) {
    const rel = path.relative(dir, fp);

    if (skip.some(s => rel.split(path.sep).includes(s))) continue;

    const content = await fs.readFile(fp, "utf8").catch(() => null);

    if (content !== null) {
      await supabase.from("project_files").upsert({
        project_id: projectId,
        path: rel.replaceAll(path.sep, "/"),
        content,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "project_id,path"
      });
    }
  }
}

export async function runSandboxCommand({
  projectId,
  taskId = null,
  command
}) {
  assertCommandAllowed(command);

  const dir = await prepareSandbox(projectId);
  const started = Date.now();

  await logEvent({
    projectId,
    taskId,
    message: `Sandbox command: ${command}`
  });

  const result = await execa(command, {
    cwd: dir,
    shell: true,
    timeout: TIMEOUT,
    reject: false,
    env: {
      CI: "true",
      APP_PORT: process.env.APP_PORT || "4173"
    }
  });

  await supabase.from("sandbox_runs").insert({
    project_id: projectId,
    task_id: taskId,
    command,
    status: result.exitCode === 0 ? "passed" : "failed",
    stdout: (result.stdout || "").slice(-MAX),
    stderr: (result.stderr || "").slice(-MAX),
    exit_code: result.exitCode,
    duration_ms: Date.now() - started
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${command}\n${result.stderr || result.stdout}`);
  }

  await syncSandboxToSupabase(projectId, dir);

  return result;
}
