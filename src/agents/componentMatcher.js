/**
 * Component Matcher — runs BEFORE each task is sent to the developer.
 *
 * 1. Embed the task description.
 * 2. Cosine-search build_components for top candidates.
 * 3. Apply aggressive thresholds:
 *      similarity > 0.80   → reuse (copy + light adapt)
 *      0.65 - 0.80         → adapt (use as starting template, regenerate)
 *      < 0.65              → fresh (no help available)
 * 4. Returns a routing decision the orchestrator + developer agent can act on.
 */

import { supabase } from "../lib/supabase.js";
import { embedText } from "./embeddings.js";

const REUSE_THRESHOLD = Number(process.env.COMPONENT_REUSE_THRESHOLD || 0.80);
const ADAPT_THRESHOLD = Number(process.env.COMPONENT_ADAPT_THRESHOLD || 0.65);
const MAX_CANDIDATES = 5;

export async function matchComponent({ project, task }) {
  const queryText = [
    `Pipeline kind: ${project?.kind || "web_app"}`,
    `Task type: ${task.type || "development"}`,
    `Task title: ${task.title || ""}`,
    `Task description: ${task.description || ""}`
  ].join("\n");

  const queryEmbedding = await embedText(queryText, {
    projectId: project?.id,
    taskId: task.id
  });

  if (!queryEmbedding) {
    return {
      decision: "fresh",
      reason: "No embedding available (offline or unconfigured).",
      candidates: []
    };
  }

  // Filter to same kind first (a static-site component shouldn't bleed into
  // a backend_api task) — but allow cross-kind for design / docs / generic.
  const filterKind = ["web_app", "static_site", "backend_api", "mobile_app", "script", "automation"].includes(project?.kind)
    ? project.kind
    : null;

  let candidates = [];
  try {
    const { data, error } = await supabase.rpc("match_components", {
      query_embedding: queryEmbedding,
      match_threshold: ADAPT_THRESHOLD,
      match_count: MAX_CANDIDATES,
      filter_kind: filterKind
    });
    if (error) throw error;
    candidates = data || [];
  } catch (err) {
    return {
      decision: "fresh",
      reason: `Match RPC failed: ${err.message}`,
      candidates: []
    };
  }

  if (!candidates.length) {
    return { decision: "fresh", reason: "No candidates above adapt threshold.", candidates: [] };
  }

  const top = candidates[0];
  if (top.similarity >= REUSE_THRESHOLD) {
    return {
      decision: "reuse",
      reason: `High match (${top.similarity.toFixed(3)}) with "${top.name}".`,
      chosen: top,
      candidates
    };
  }
  return {
    decision: "adapt",
    reason: `Moderate match (${top.similarity.toFixed(3)}) with "${top.name}". Using as template.`,
    chosen: top,
    candidates
  };
}

/**
 * Record a reuse event for analytics + ranking.
 */
export async function recordReuse({ componentId, projectId, taskId, similarity, decision }) {
  try {
    await supabase.from("component_reuses").insert({
      component_id: componentId,
      project_id: projectId,
      task_id: taskId,
      similarity,
      decision
    });
    // Bump reuse_count.
    if (decision === "reuse" || decision === "adapt") {
      const { data } = await supabase
        .from("build_components")
        .select("reuse_count")
        .eq("id", componentId)
        .maybeSingle();
      if (data) {
        await supabase
          .from("build_components")
          .update({ reuse_count: (data.reuse_count || 0) + 1, updated_at: new Date().toISOString() })
          .eq("id", componentId);
      }
    }
  } catch {
    // never fail a build because logging failed
  }
}
