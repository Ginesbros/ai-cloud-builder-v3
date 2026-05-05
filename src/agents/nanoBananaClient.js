/**
 * Nano Banana — image generation via Gemini's image-preview model.
 * Endpoint: same Gemini generateContent API; we pass an image-capable model
 * and decode the base64 inline data the response returns.
 *
 * Requires: GOOGLE_GEMINI_API_KEY
 * Model env: NANO_BANANA_MODEL (default: gemini-3.1-flash-image-preview)
 */

import axios from "axios";
import { supabase } from "../lib/supabase.js";

const API_BASE =
  process.env.NOTEBOOKLM_API_BASE || "https://generativelanguage.googleapis.com/v1beta";

function isConfigured() {
  return Boolean(process.env.GOOGLE_GEMINI_API_KEY);
}

/**
 * Generate one or more images from a prompt.
 * Returns: [{ filename, mimeType, base64 }]
 */
export async function generateImages({
  prompt,
  count = 1,
  projectId = null,
  taskId = null
}) {
  if (!isConfigured()) {
    return { images: [], note: "Nano Banana not configured (GOOGLE_GEMINI_API_KEY missing)." };
  }

  const model = process.env.NANO_BANANA_MODEL || "gemini-3.1-flash-image-preview";
  const url = `${API_BASE}/models/${model}:generateContent?key=${process.env.GOOGLE_GEMINI_API_KEY}`;

  const images = [];

  for (let i = 0; i < count; i++) {
    try {
      const response = await axios.post(
        url,
        {
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            responseModalities: ["IMAGE", "TEXT"]
          }
        },
        { timeout: 120000 }
      );

      const parts = response.data?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const filename = `generated/${Date.now()}-${i}.${
            (part.inlineData.mimeType || "image/png").split("/")[1] || "png"
          }`;
          images.push({
            filename,
            mimeType: part.inlineData.mimeType || "image/png",
            base64: part.inlineData.data
          });
        }
      }
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err?.message;
      images.push({ error: `Nano Banana call failed: ${msg}` });
    }
  }

  // Persist to project_assets table for the dashboard to display.
  if (projectId) {
    for (const img of images) {
      if (img.error) continue;
      await supabase
        .from("project_assets")
        .insert({
          project_id: projectId,
          task_id: taskId,
          type: "image",
          filename: img.filename,
          mime_type: img.mimeType,
          content_base64: img.base64,
          generator: "nano_banana"
        })
        .catch(() => null);
    }

    // Flat-rate cost record (image gen pricing varies; approximate).
    const flatCost = Number(process.env.COST_IMAGE_FLAT_PER_IMAGE || 0.04);
    await supabase
      .from("ai_usage")
      .insert({
        project_id: projectId,
        task_id: taskId,
        role: "designer",
        model,
        estimated_cost_usd: flatCost * images.filter(i => !i.error).length
      })
      .catch(() => null);
  }

  return { images };
}
