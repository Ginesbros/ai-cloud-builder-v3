/**
 * Designer agent — wraps Nano Banana to produce image assets for a project.
 *
 * Returned shape matches what the orchestrator expects from the developer
 * agent (so it can be fed through the same pipeline):
 *   { summary, files: [{path, content}], commandsToRun, needsSmokeTest, notes, assets }
 *
 * Generated images are committed to the repo as base64 strings written to
 * disk by the sandbox prepare step (saved to project_files like everything
 * else, but with a marker prefix so we can decode them later).
 *
 * For simplicity we ALSO write the binary into project_assets so the
 * dashboard can show them inline.
 */

import { generateImages } from "./nanoBananaClient.js";
import { askOpenAI } from "./openaiClient.js";
import { safeParseJson } from "./jsonUtils.js";

/**
 * Use a small LLM call to convert a vague task description into 1-3 concrete
 * image prompts (what filename, what style, what dimensions).
 */
async function planImagePrompts({ project, task }) {
  const raw = await askOpenAI({
    role: "developer",
    taskType: "design",
    projectId: project.id,
    taskId: task.id,
    json: true,
    system: "You are an art director. Return strict JSON only.",
    user: `
Project goal: ${project.goal}
Design task: ${task.title}
Description: ${task.description}

Return JSON:
{
  "prompts": [
    { "filename": "public/logo.png", "prompt": "Vector logo, ...", "purpose": "logo" },
    { "filename": "public/hero.png", "prompt": "Cinematic hero image, ...", "purpose": "hero" }
  ]
}
- 1-3 prompts only.
- Prefer "public/" directory paths so they ship with the site.
- Each prompt must be 1-2 sentences, descriptive, brand-appropriate.
`
  });
  const parsed = safeParseJson(raw, { prompts: [] });
  return Array.isArray(parsed.prompts) ? parsed.prompts.slice(0, 3) : [];
}

export async function executeDesignTask({ project, task }) {
  const prompts = await planImagePrompts({ project, task });
  if (!prompts.length) {
    return {
      summary: "Designer skipped: no usable prompts generated.",
      files: [],
      commandsToRun: [],
      needsSmokeTest: false,
      notes: ["No image prompts produced."],
      assets: []
    };
  }

  const assets = [];
  const files = [];

  for (const p of prompts) {
    const { images } = await generateImages({
      prompt: p.prompt,
      count: 1,
      projectId: project.id,
      taskId: task.id
    });

    for (const img of images) {
      if (img.error) {
        assets.push({ ...p, error: img.error });
        continue;
      }
      // Use the planner-supplied filename, fall back to the default the client picked.
      const path = p.filename || img.filename;

      // Write as a special marker so the sandbox can decode base64 → binary on prepare.
      // Format: "__BINARY_BASE64__<mime>\n<base64payload>"
      const content = `__BINARY_BASE64__${img.mimeType}\n${img.base64}`;
      files.push({ path, content });
      assets.push({
        path,
        purpose: p.purpose || "asset",
        mimeType: img.mimeType
      });
    }
  }

  return {
    summary: `Designer generated ${assets.filter(a => !a.error).length} image asset(s).`,
    files,
    commandsToRun: [],
    needsSmokeTest: false,
    notes: assets.map(a => (a.error ? `ERROR ${a.path}: ${a.error}` : `OK ${a.path} (${a.purpose})`)),
    assets
  };
}
