/**
 * Manus client — long-running autonomous agent.
 *
 * API: v2 REST, base URL https://api.manus.ai
 * Auth: x-manus-api-key header (NOT Authorization: Bearer)
 *
 * Docs: https://open.manus.ai/docs/v2/authentication
 *
 * Submit:  POST /v2/task.create   body: { message: { content: "..." }, ... }
 * Poll:    GET  /v2/task.detail?task_id=...
 * Stop:    POST /v2/task.stop     body: { task_id }
 *
 * Manus runs tasks asynchronously. We submit and either poll, or rely on the
 * webhook subscription (future work) to mark the orchestrator task complete.
 */

import axios from "axios";
import { supabase } from "../lib/supabase.js";

const BASE = process.env.MANUS_BASE_URL || "https://api.manus.ai";

function isConfigured() {
  return Boolean(process.env.MANUS_API_KEY);
}

function client() {
  return axios.create({
    baseURL: BASE,
    headers: {
      "x-manus-api-key": process.env.MANUS_API_KEY,
      "Content-Type": "application/json"
    },
    timeout: 60000,
    validateStatus: () => true // we'll surface non-2xx via response body
  });
}

/**
 * Submit a task and persist the job handle.
 * Returns: { jobId, status, taskUrl } or { error }.
 */
export async function submitManusJob({
  prompt,
  projectId = null,
  taskId = null,
  agentProfile = null,
  hideInTaskList = true
}) {
  if (!isConfigured()) {
    return { error: "Manus not configured (MANUS_API_KEY missing)." };
  }

  try {
    const body = {
      message: { content: prompt },
      hide_in_task_list: hideInTaskList,
      interactive_mode: false
    };
    if (agentProfile || process.env.MANUS_AGENT_PROFILE) {
      body.agent_profile = agentProfile || process.env.MANUS_AGENT_PROFILE;
    }

    const response = await client().post("/v2/task.create", body);
    const data = response.data || {};

    if (!data.ok || !data.task_id) {
      return {
        error: `Manus submit failed: ${data.error?.message || `status=${response.status}`}`
      };
    }

    const jobId = data.task_id;
    const status = "queued";

    if (projectId) {
      await supabase
        .from("manus_jobs")
        .insert({
          project_id: projectId,
          task_id: taskId,
          job_id: jobId,
          status,
          payload: {
            prompt,
            taskUrl: data.task_url,
            taskTitle: data.task_title,
            requestId: data.request_id
          }
        })
        .catch(() => null);

      // Approximate flat-rate cost record for accounting.
      const flatCost = Number(process.env.COST_MANUS_FLAT_PER_TASK || 0.50);
      await supabase
        .from("ai_usage")
        .insert({
          project_id: projectId,
          task_id: taskId,
          role: "specialist",
          model: agentProfile || process.env.MANUS_AGENT_PROFILE || "manus-1.6",
          estimated_cost_usd: flatCost
        })
        .catch(() => null);
    }

    return {
      jobId,
      status,
      taskUrl: data.task_url,
      taskTitle: data.task_title,
      raw: data
    };
  } catch (err) {
    return { error: `Manus submit failed: ${err?.message || "unknown"}` };
  }
}

/**
 * Poll a Manus task. Returns: { status, output, raw } or { error }.
 */
export async function pollManusJob({ jobId }) {
  if (!isConfigured()) return { error: "Manus not configured." };
  try {
    const response = await client().get(`/v2/task.detail`, { params: { task_id: jobId } });
    const data = response.data || {};
    if (!data.ok) return { error: data.error?.message || `status=${response.status}` };

    const t = data.task || {};
    return {
      status: t.status || "unknown",
      output: t,
      raw: data
    };
  } catch (err) {
    return { error: err?.message };
  }
}

/**
 * Stop a running Manus task.
 */
export async function stopManusJob({ jobId }) {
  if (!isConfigured()) return { error: "Manus not configured." };
  try {
    const response = await client().post("/v2/task.stop", { task_id: jobId });
    const data = response.data || {};
    if (!data.ok) return { error: data.error?.message || `status=${response.status}` };
    return { stopped: true, raw: data };
  } catch (err) {
    return { error: err?.message };
  }
}

/**
 * Lightweight health check: try to list 1 task.
 */
export async function manusHealthCheck() {
  if (!isConfigured()) return { ok: false, configured: false };
  try {
    const response = await client().get("/v2/task.list", { params: { limit: 1 } });
    return {
      ok: response.data?.ok === true,
      configured: true,
      status: response.status
    };
  } catch (err) {
    return { ok: false, configured: true, error: err?.message };
  }
}
