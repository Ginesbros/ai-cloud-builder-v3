/**
 * Higgsfield client — wraps text-to-video generation.
 *
 * Auth strategy:
 *   1. If HIGGSFIELD_API_KEY env is set → use as static Bearer (fallback).
 *   2. Otherwise try OAuth tokens stored in oauth_tokens table; auto-refresh
 *      if expired. Throws OAUTH_REAUTH_REQUIRED when refresh token is gone.
 *
 * Endpoints:
 *   submit  POST {BASE}/v1/text-to-video
 *   poll    GET  {BASE}/v1/jobs/:id
 *
 * Default base URL is the MCP / API gateway. Override with HIGGSFIELD_BASE_URL.
 */

import axios from "axios";
import { supabase } from "../lib/supabase.js";
import { getAccessToken, getProviderStatus } from "../lib/oauthStore.js";

const BASE = process.env.HIGGSFIELD_BASE_URL || "https://api.higgsfield.ai";
const PROVIDER = "higgsfield";

async function authHeader() {
  // Static key wins if explicitly provided (lets you swap to a service key later).
  if (process.env.HIGGSFIELD_API_KEY) {
    return `Bearer ${process.env.HIGGSFIELD_API_KEY}`;
  }
  try {
    const { token, tokenType } = await getAccessToken(PROVIDER);
    return `${tokenType || "Bearer"} ${token}`;
  } catch (err) {
    // Bubble up so callers can return a clean "not configured" message.
    throw err;
  }
}

async function isConfigured() {
  if (process.env.HIGGSFIELD_API_KEY) return true;
  const status = await getProviderStatus(PROVIDER).catch(() => ({ configured: false }));
  return status.configured && !status.needsReauth;
}

async function client() {
  const auth = await authHeader();
  return axios.create({
    baseURL: BASE,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json"
    },
    timeout: 60000
  });
}

/**
 * Submit a text-to-video job.
 */
export async function submitVideoJob({
  prompt,
  durationSeconds = 6,
  aspectRatio = "16:9",
  projectId = null,
  taskId = null
}) {
  if (!(await isConfigured())) {
    return {
      error:
        "Higgsfield not configured (no HIGGSFIELD_API_KEY env and no valid OAuth token in oauth_tokens). Run device-auth flow."
    };
  }

  try {
    const c = await client();
    const response = await c.post("/v1/text-to-video", {
      prompt,
      duration: durationSeconds,
      aspect_ratio: aspectRatio,
      model: process.env.HIGGSFIELD_MODEL || "higgsfield-v1"
    });
    const jobId = response.data?.id || response.data?.job_id;
    const status = response.data?.status || "queued";

    if (projectId && jobId) {
      await supabase
        .from("project_assets")
        .insert({
          project_id: projectId,
          task_id: taskId,
          type: "video",
          filename: `video-${jobId}.mp4`,
          mime_type: "video/mp4",
          generator: "higgsfield",
          metadata: { jobId, status, prompt, durationSeconds, aspectRatio }
        })
        .catch(() => null);

      const flatCost = Number(process.env.COST_VIDEO_FLAT_PER_SECOND || 0.10) * durationSeconds;
      await supabase
        .from("ai_usage")
        .insert({
          project_id: projectId,
          task_id: taskId,
          role: "videographer",
          model: process.env.HIGGSFIELD_MODEL || "higgsfield-v1",
          estimated_cost_usd: flatCost
        })
        .catch(() => null);
    }

    return { jobId, status, raw: response.data };
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message;
    return { error: `Higgsfield submit failed: ${msg}` };
  }
}

export async function pollVideoJob({ jobId }) {
  if (!(await isConfigured())) return { error: "Higgsfield not configured." };
  try {
    const c = await client();
    const response = await c.get(`/v1/jobs/${jobId}`);
    return {
      status: response.data?.status,
      videoUrl: response.data?.output?.url || response.data?.video_url,
      raw: response.data
    };
  } catch (err) {
    return { error: err?.message };
  }
}

export async function getHiggsfieldStatus() {
  if (process.env.HIGGSFIELD_API_KEY) {
    return { mode: "static_key", configured: true };
  }
  const status = await getProviderStatus(PROVIDER).catch(() => ({ configured: false }));
  return { mode: "oauth", ...status };
}
