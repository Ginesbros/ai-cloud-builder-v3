/**
 * Component Extractor — runs AFTER a task succeeds.
 *
 * Decides whether the produced files form a clean, reusable chunk worth
 * saving to the global component library. Filters:
 *   - Failed tasks → never save (caller enforces this)
 *   - Whole-app boilerplate (App.jsx, package.json scaffolds) → skip
 *   - Anything that fails the PII/secret scrubber → skip
 *
 * For the keepers, asks Claude to extract a name + tags + description, embeds
 * it, and inserts into build_components.
 */

import { supabase } from "../lib/supabase.js";
import { askClaude } from "./claudeClient.js";
import { askOpenAI } from "./openaiClient.js";
import { safeParseJson } from "./jsonUtils.js";
import { embedText } from "./embeddings.js";
import { scrubFiles } from "../lib/scrubber.js";
import { logEvent } from "../lib/logger.js";

// Files that are pure scaffolding — skip these from extraction.
const BORING_PATHS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^vite\.config\.(js|ts)$/,
  /^tsconfig\.json$/,
  /^\.gitignore$/,
  /^README\.md$/i,
  /^src\/main\.(jsx|tsx|js|ts)$/,
  /^src\/index\.(jsx|tsx|js|ts)$/,
  /^src\/App\.(jsx|tsx)$/   // whole-app shells per spec
];

function isBoring(path) {
  return BORING_PATHS.some(p => p.test(path));
}

async function classifyAndName({ project, task, files }) {
  const sample = files.slice(0, 6).map(f => ({
    path: f.path,
    preview: (f.content || "").slice(0, 1500)
  }));

  const system =
    "You are a component librarian. You read code and extract a reusable component summary. Return strict JSON only.";
  const user = `
Project goal: ${project.goal}
Task: ${task.title}
Description: ${task.description}
Pipeline kind: ${project.kind}
Task type: ${task.type}

Files produced:
${JSON.stringify(sample)}

Decide whether this is a clean reusable component (form, hero, card grid,
checkout flow, API endpoint, cron handler, brand asset, etc) OR boilerplate
(scaffolding, empty templates, app shell, tooling configs).

Return JSON:
{
  "saveWorthy": true|false,
  "reasonIfNot": "...",
  "name": "kebab-case-name",
  "description": "1-2 sentence summary of what it does",
  "tags": ["form", "lead-gen", "..."],
  "abstractedDescription": "Generic description with all business-specific names removed (e.g. 'Quote form with calculator for a service business' instead of 'HVAC quote form for Thor Industries')"
}

Rules:
- saveWorthy=false for: app shells, package.json, README files, full-page wrappers, tooling configs.
- saveWorthy=true for: isolated reusable chunks like a single form, a hero section, an API route group, a chart, a logo/brand asset, an email template.
- name: 2-5 words, lowercase, hyphenated.
- tags: 3-8 tags. Include the kind (form/hero/api/script), domain (trades/ecommerce/saas/etc), and capability (calculator/auth/payments/etc).
`;

  let raw = await askClaude({
    role: "reviewer",
    system,
    user,
    json: true,
    projectId: project.id,
    taskId: task.id
  });
  let parsed = safeParseJson(raw, null);

  // Fallback to OpenAI if Claude not configured.
  if (!parsed) {
    raw = await askOpenAI({
      role: "reviewer",
      system,
      user,
      json: true,
      projectId: project.id,
      taskId: task.id
    });
    parsed = safeParseJson(raw, null);
  }

  if (!parsed || typeof parsed !== "object") {
    return { saveWorthy: false, reasonIfNot: "Classifier returned no JSON." };
  }
  parsed.tags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 12) : [];
  parsed.name = parsed.name ? String(parsed.name).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64) : null;
  return parsed;
}

export async function maybeExtractComponent({ project, task, files }) {
  if (!project?.id || !task?.id || !files || files.length === 0) return { saved: false };

  // Skip the whole-app / config files first.
  const interesting = files.filter(f => !isBoring(f.path));
  if (interesting.length === 0) return { saved: false, reason: "Only scaffolding files." };

  // Scrub.
  const { ok, scrubbed, reasons } = scrubFiles(interesting);
  if (!ok) {
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "warn",
      message: "Component skipped: scrubber blocked save.",
      data: { reasons }
    });
    return { saved: false, reason: reasons.join("; ") };
  }

  // Ask Claude to name + tag + decide.
  const meta = await classifyAndName({ project, task, files: scrubbed });
  if (!meta.saveWorthy || !meta.name) {
    return { saved: false, reason: meta.reasonIfNot || "Not save-worthy." };
  }

  // Embed the abstracted description for the matcher.
  const embeddingText = [
    meta.abstractedDescription || meta.description || "",
    `Tags: ${(meta.tags || []).join(", ")}`,
    `Kind: ${project.kind} / ${task.type || "development"}`
  ].join("\n");
  const embedding = await embedText(embeddingText, { projectId: project.id, taskId: task.id });
  if (!embedding) {
    return { saved: false, reason: "Embedding failed." };
  }

  const { data: row, error } = await supabase
    .from("build_components")
    .insert({
      name: meta.name,
      description: meta.abstractedDescription || meta.description || meta.name,
      tags: meta.tags || [],
      kind: project.kind || "web_app",
      task_type: task.type || "development",
      files: scrubbed,
      embedding,
      source_project_id: project.id,
      source_task_id: task.id,
      source_goal: (project.goal || "").slice(0, 1000),
      success_score: 1.0,
      shared: true,
      scrubbed: true
    })
    .select("id")
    .single();

  if (error) {
    await logEvent({
      projectId: project.id,
      taskId: task.id,
      level: "warn",
      message: "Component save failed.",
      data: { error: error.message }
    });
    return { saved: false, reason: error.message };
  }

  await logEvent({
    projectId: project.id,
    taskId: task.id,
    message: `Saved component "${meta.name}" to library`,
    data: { tags: meta.tags, scrubReasons: reasons }
  });

  return { saved: true, componentId: row.id, name: meta.name, tags: meta.tags };
}
