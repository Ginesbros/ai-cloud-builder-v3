/**
 * Higgsfield — text-to-video generation for marketing/demo videos.
 *
 * Higgsfield's public API is job-based (submit prompt → poll job → fetch
 * MP4 URL). We model that here. If your Higgsfield account uses different
 * paths, override HIGGSFIELD_BASE_URL.
 *
 * Requires: HIGGSFIELD_API_KEY
 */

import axios from "axios";
import { supabase } from "../lib/supabase.js";

const BASE = process.env.HIGGSFIELD_BASE_URL || "https://api.higgsfield.ai";

function isConfigured() {
  return Boolean(process.env.HIGGSFIELD_API_KEY);
}

function client() {
  return axios.create({
    baseURL: BASE,
    headers: {
      Authorization: `Bearer ${process.env.HIGGSFIELD_API_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 60000
  });
}

/**
 * Submit a video generation job.
 * Returns: { jobId, status } or { error }
 */
export async function submitVideoJob({
  prompt,
  durationSeconds = 6,
  aspectRatio = "16:9",
  projectId = null,
  taskId = null
}) {
  if (!isConfigured()) {
    return { error: "Higgsfield not configured (HIGGSFIELD_API_KEY missing)." };
  }

  try {
    const response = await client().post("/v1/text-to-video", {
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

/**
 * Poll a Higgsfield video job once.
 */
export async function pollVideoJob({ jobId }) {
  if (!isConfigured()) return { error: "Higgsfield not configured." };
  try {
    const response = await client().get(`/v1/jobs/${jobId}`);
    return {
      status: response.data?.status,
      videoUrl: response.data?.output?.url || response.data?.video_url,
      raw: response.data
    };
  } catch (err) {
    return { error: err?.message };
  }
}
