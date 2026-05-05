/**
 * Manus — long-running autonomous agent for multi-hour complex tasks.
 *
 * Manus exposes a job-based API: you submit a task, get a job id, and poll
 * for completion. We model it the same way here. The orchestrator submits the
 * job and returns immediately; a separate poller (or the next worker tick)
 * picks up the result.
 *
 * Requires: MANUS_API_KEY
 * Base URL: MANUS_BASE_URL (default https://open.manus.im)
 */

import axios from "axios";
import { supabase } from "../lib/supabase.js";

const BASE = process.env.MANUS_BASE_URL || "https://open.manus.im";

function isConfigured() {
  return Boolean(process.env.MANUS_API_KEY);
}

function client() {
  return axios.create({
    baseURL: BASE,
    headers: {
      Authorization: `Bearer ${process.env.MANUS_API_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 60000
  });
}

/**
 * Submit a long-running task to Manus and persist the job handle.
 * Returns: { jobId, status } or { error }.
 */
export async function submitManusJob({ prompt, projectId = null, taskId = null }) {
  if (!isConfigured()) {
    return { error: "Manus not configured (MANUS_API_KEY missing)." };
  }

  try {
    const response = await client().post("/api/v1/tasks", {
      prompt,
      mode: "autonomous"
    });
    const jobId = response.data?.id || response.data?.task_id || response.data?.taskId;
    const status = response.data?.status || "queued";

    if (projectId && jobId) {
      await supabase
        .from("manus_jobs")
        .insert({
          project_id: projectId,
          task_id: taskId,
          job_id: jobId,
          status,
          payload: { prompt }
        })
        .catch(() => null);
    }

    return { jobId, status, raw: response.data };
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message;
    return { error: `Manus submit failed: ${msg}` };
  }
}

/**
 * Poll a Manus job once. Returns the latest status + any output.
 */
export async function pollManusJob({ jobId }) {
  if (!isConfigured()) return { error: "Manus not configured." };
  try {
    const response = await client().get(`/api/v1/tasks/${jobId}`);
    return {
      status: response.data?.status,
      output: response.data?.output,
      raw: response.data
    };
  } catch (err) {
    return { error: err?.message };
  }
}
