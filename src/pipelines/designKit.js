/**
 * design_kit pipeline — Logo + brand colors + image variants.
 *
 * Uses generateImages from src/agents/nanoBananaClient.js.
 * Each generated image is returned as a deliverable.
 *
 * files = []          (no code written to the repo)
 * deliverables = [logo x3, hero image, icon set images, brand guide .md]
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { askClaude } from "../agents/claudeClient.js";
import { generateImages } from "../agents/nanoBananaClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return strict JSON only, no prose, no markdown fences.
{
  "projectName": "kebab-case-name",
  "summary": "One sentence description",
  "techStack": ["Nano Banana (AI Image Gen)", "Brand Design"],
  "successCriteria": ["Logo variants generated", "Hero image generated", "Brand guide produced", "..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "design",
      "priority": 1
    }
  ]
}

Rules:
- 5-7 tasks total.
- Always include: brand brief, generate logo (3 variants), generate hero image, generate icon set, brand guide document.
- All tasks should have type "design".
- Never include secrets or credentials.
`;

/**
 * Plan tasks for a design kit project.
 */
export async function planTasks({ project, goal, clarifications, projectId }) {
  const effectiveGoal = clarifications
    ? `${goal}\n\nAdditional clarifications:\n${clarifications}`
    : goal;

  const raw = await askOpenAI({
    role: "planner",
    projectId: projectId || project?.id || null,
    json: true,
    system:
      "You are a senior brand designer and creative director. Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

${PLAN_SCHEMA_HINT}
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("designKit planner did not return a valid plan JSON.");
  }

  parsed.tasks = parsed.tasks.slice(0, 7);
  return parsed;
}

/**
 * Execute a single design kit task.
 *
 * For image generation tasks → calls generateImages() and emits deliverables.
 * For brand guide task → writes a Markdown brand guide as a deliverable.
 */
export async function executeTask({ project, task, existingFiles }) {
  const taskTitleLower = (task.title || "").toLowerCase();
  const taskDescLower = (task.description || "").toLowerCase();
  const isLogoTask = taskTitleLower.includes("logo");
  const isHeroTask = taskTitleLower.includes("hero");
  const isIconTask = taskTitleLower.includes("icon");
  const isBrandGuideTask =
    taskTitleLower.includes("brand guide") ||
    taskTitleLower.includes("brand brief") ||
    taskDescLower.includes("brand guide") ||
    taskDescLower.includes("brand brief");

  const deliverables = [];
  const notes = [];

  // --- Brand brief / brand guide task ---
  if (isBrandGuideTask) {
    const brandGuide = await askClaude({
      role: "reviewer",
      projectId: project?.id || null,
      json: false,
      system:
        "You are a senior brand strategist. Write a professional brand guide in Markdown.",
      user: `
Project goal: ${project?.goal || ""}
Task: ${task.title}
${task.description}

Write a comprehensive brand guide covering:
1. Brand identity & positioning
2. Primary and accent color palette (with hex codes)
3. Typography recommendations (Google Fonts)
4. Logo usage guidelines
5. Voice & tone
6. Do's and Don'ts

Format as Markdown with clear headings.
`
    });

    deliverables.push({
      kind: "report",
      filename: "brand-guide.md",
      data: brandGuide || "# Brand Guide\n\n(Content generation failed)",
      mimeType: "text/markdown",
      generator: "design_kit",
      metadata: { taskTitle: task.title }
    });

    notes.push("Brand guide saved as Markdown deliverable.");

    return {
      summary: `Brand guide produced for: ${project?.goal || task.title}`,
      files: [],
      commandsToRun: [],
      needsSmokeTest: false,
      notes,
      deliverables
    };
  }

  // --- Image generation tasks (logo / hero / icon set) ---
  const count = isLogoTask ? 3 : isIconTask ? 4 : 1;

  // Build a precise image prompt via OpenAI.
  const promptRaw = await askOpenAI({
    role: "developer",
    taskType: "design",
    projectId: project?.id || null,
    json: true,
    system: "You are a prompt engineer specializing in image generation. Return strict JSON only.",
    user: `
Project goal: ${project?.goal || ""}
Task: ${task.title} — ${task.description}

Generate ${count} detailed image generation prompt(s) suitable for a professional brand designer.
Focus on: clean, modern, professional aesthetic. Transparent or white background for logos/icons.

Return JSON:
{
  "prompts": ["prompt 1", "prompt 2", ...]
}

Generate exactly ${count} prompt(s).
`
  });

  const promptData = safeParseJson(promptRaw, { prompts: [] });
  const prompts = Array.isArray(promptData.prompts) && promptData.prompts.length > 0
    ? promptData.prompts
    : [`Professional ${task.title} for: ${project?.goal || "a modern startup"}. Clean, minimalist design on white background.`];

  // Generate images sequentially (one per prompt).
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i] || prompts[0];
    const label = isLogoTask ? `logo-variant-${i + 1}` : isHeroTask ? "hero-image" : isIconTask ? `icon-${i + 1}` : `image-${i + 1}`;

    const result = await generateImages({
      prompt,
      count: 1,
      projectId: project?.id || null,
      taskId: task?.id || null
    });

    if (result.images && result.images.length > 0) {
      for (const img of result.images) {
        if (img.error) {
          notes.push(`Image generation failed for ${label}: ${img.error}`);
          continue;
        }
        const ext = (img.mimeType || "image/png").split("/")[1] || "png";
        const filename = `${label}.${ext}`;
        // Convert base64 to Buffer for the orchestrator.
        const data = Buffer.from(img.base64, "base64");
        deliverables.push({
          kind: "image",
          filename,
          data,
          mimeType: img.mimeType || "image/png",
          generator: "nano_banana",
          metadata: { prompt, label, taskTitle: task.title }
        });
      }
    } else {
      notes.push(`No images returned for ${label}. ${result.note || ""}`);
    }
  }

  if (deliverables.length > 0) {
    notes.push(`${deliverables.length} image(s) generated and saved as deliverables.`);
  }

  return {
    summary: `${task.title}: generated ${deliverables.length} image deliverable(s).`,
    files: [],
    commandsToRun: [],
    needsSmokeTest: false,
    notes,
    deliverables
  };
}
