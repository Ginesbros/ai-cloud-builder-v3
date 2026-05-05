/**
 * NotebookLM (Librarian) — digests reference docs (PDFs, markdown, URLs) into
 * a compact context block the planner can use.
 *
 * Google has not exposed NotebookLM as a first-party API at time of writing.
 * We implement this as a "Gemini long-context summarizer" that uses the
 * Gemini API to read attached docs and produce a structured digest. If
 * `NOTEBOOKLM_API_KEY` is set and the proper endpoint becomes available,
 * swap the base URL via `NOTEBOOKLM_API_BASE`.
 *
 * Inputs: docs = [{ filename, content }] OR [{ url }]
 */

import axios from "axios";
import { recordAiUsage } from "../services/budget.js";

const API_BASE =
  process.env.NOTEBOOKLM_API_BASE || "https://generativelanguage.googleapis.com/v1beta";

function isConfigured() {
  return Boolean(
    process.env.NOTEBOOKLM_API_KEY || process.env.GOOGLE_GEMINI_API_KEY
  );
}

export async function digestDocs({ docs = [], projectId = null, taskId = null }) {
  if (!docs.length) return "";
  if (!isConfigured()) {
    return "[Librarian not configured — skipping doc digest.]";
  }

  const apiKey = process.env.NOTEBOOKLM_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  const model = process.env.NOTEBOOKLM_MODEL || "gemini-2.5-pro";
  const url = `${API_BASE}/models/${model}:generateContent?key=${apiKey}`;

  // Compact the docs into a single message. Long-context models handle this fine.
  const flat = docs
    .map((d, i) => {
      const header = `--- Doc ${i + 1} (${d.filename || d.url || "untitled"}) ---`;
      const body = (d.content || "").slice(0, 60000);
      return `${header}\n${body}`;
    })
    .join("\n\n");

  try {
    const response = await axios.post(
      url,
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `You are a senior research librarian. Read the attached documents and produce a structured digest covering:
1. Key facts the planner must know.
2. Constraints, deadlines, or requirements.
3. APIs / packages / vendors named.
4. Open questions worth flagging.

Documents:
${flat}

Return concise bullet points only.`
              }
            ]
          }
        ]
      },
      { timeout: 120000 }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Approximate cost record.
    await recordAiUsage({
      projectId,
      taskId,
      role: "librarian",
      model,
      inputTokens: Math.round(flat.length / 4),
      outputTokens: Math.round(text.length / 4)
    }).catch(() => null);

    return text;
  } catch (err) {
    return `[Librarian digest failed: ${err?.message || "unknown"}]`;
  }
}
