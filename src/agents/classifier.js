/**
 * Classifier — first step in the universal builder pipeline.
 *
 * Reads the user's goal and decides:
 *   1. Which pipeline kind to run (web_app, static_site, backend_api,
 *      mobile_app, script, document, design_kit, video, research, automation, freeform)
 *   2. Whether the goal is clear enough to start, or if we need clarifying
 *      questions first.
 *
 * Powered by Claude (best long-form reasoning).
 */

import { askClaude } from "./claudeClient.js";
import { askOpenAI } from "./openaiClient.js";
import { safeParseJson } from "./jsonUtils.js";

export const PIPELINE_KINDS = [
  "web_app",
  "static_site",
  "backend_api",
  "mobile_app",
  "script",
  "document",
  "design_kit",
  "video",
  "research",
  "automation",
  "freeform"
];

const SYSTEM = `You are the dispatcher for a universal AI builder. Your job is to read a user's goal and decide which build pipeline is the best fit, plus whether you have enough information to start.

Pipeline kinds and when to pick each:
- web_app          : Interactive web app (React/Vite/Next), needs build step + smoke test
- static_site      : Plain HTML/CSS landing page, brochure site, no build step
- backend_api      : REST/GraphQL service, no UI (Node, Python, Go)
- mobile_app       : iOS/Android/React Native scaffold
- script           : One-off CLI script, automation, data pipeline (Node/Python/Bash)
- document         : Generate a PDF/DOCX/PPTX/XLSX (report, deck, spreadsheet, contract)
- design_kit       : Logo + brand assets + image set (no code)
- video            : Marketing/demo video (text-to-video, multi-scene)
- research         : Research report — gather sources, synthesize, deliver as markdown + PDF
- automation       : Cron job, webhook, integration glue (deploys but no UI)
- freeform         : Goal doesn't fit above categories; hand off to Manus

Return STRICT JSON only.`;

const SCHEMA = `Return JSON of the form:
{
  "kind": "<one of: web_app | static_site | backend_api | mobile_app | script | document | design_kit | video | research | automation | freeform>",
  "confidence": 0-1.0,
  "reasoning": "Short explanation of why this kind.",
  "needsClarification": true|false,
  "clarifyingQuestions": [
    { "question": "...", "why": "...", "suggestedAnswer": "..." }
  ],
  "suggestedName": "kebab-case-name"
}

Rules:
- needsClarification=true ONLY when the goal is genuinely ambiguous (e.g. "build me something for HVAC" — could be a website, a CRM, a quote tool, a video).
- If goal is clear, set needsClarification=false and clarifyingQuestions=[].
- Maximum 2 clarifying questions. Each must have a suggestedAnswer the user could just accept.
- For confident matches (>0.85), don't ask clarifying questions.`;

export async function classifyGoal({ goal, projectId = null }) {
  const user = `Goal:\n${goal}\n\n${SCHEMA}`;

  // Try Claude first (best at this).
  let raw = await askClaude({
    role: "planner",
    projectId,
    json: true,
    system: SYSTEM,
    user,
    maxTokens: 2048
  });

  let parsed = safeParseJson(raw, null);

  // Fallback to OpenAI if Claude isn't configured or returns garbage.
  if (!parsed || !PIPELINE_KINDS.includes(parsed.kind)) {
    raw = await askOpenAI({
      role: "planner",
      projectId,
      json: true,
      system: SYSTEM,
      user
    });
    parsed = safeParseJson(raw, null);
  }

  if (!parsed || !PIPELINE_KINDS.includes(parsed.kind)) {
    // Final fallback: assume freeform, no clarification.
    return {
      kind: "freeform",
      confidence: 0.3,
      reasoning: "Classifier could not determine a pipeline; defaulting to freeform.",
      needsClarification: false,
      clarifyingQuestions: [],
      suggestedName: null
    };
  }

  // Sanitize.
  parsed.confidence = Number(parsed.confidence) || 0.5;
  parsed.needsClarification = Boolean(parsed.needsClarification);
  parsed.clarifyingQuestions = Array.isArray(parsed.clarifyingQuestions)
    ? parsed.clarifyingQuestions.slice(0, 2)
    : [];
  parsed.reasoning = String(parsed.reasoning || "");
  parsed.suggestedName = parsed.suggestedName ? String(parsed.suggestedName).toLowerCase().replace(/[^a-z0-9-]/g, "-") : null;

  return parsed;
}
