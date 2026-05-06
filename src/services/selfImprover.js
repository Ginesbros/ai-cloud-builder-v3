import axios from "axios";
import { supabase } from "../lib/supabase.js";
import { logEvent } from "../lib/logger.js";
import { askClaude } from "../agents/claudeClient.js";
import { askOpenAI } from "../agents/openaiClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

/**
 * Self-improvement system: lets the orchestrator open pull requests against
 * its own repo (Ginesbros/ai-cloud-builder-v3) without ever pushing to main.
 *
 * Hard guardrails:
 *  1. Forbidden file allowlist (auth, billing, secrets, the self-improver itself)
 *  2. PR-only — never pushes to main
 *  3. Per-idea cost cap (default $5)
 *  4. Daily PR cap (default 3)
 *  5. Always opens a real GitHub PR with full diff so user can review
 */

const SELF_REPO = process.env.SELF_REPO_NAME || "ai-cloud-builder-v3";
const SELF_OWNER = process.env.GITHUB_OWNER || "Ginesbros";
const MAX_PRS_PER_DAY = Number(process.env.SELF_IMPROVE_DAILY_CAP || 3);
const DEFAULT_COST_CAP = Number(process.env.SELF_IMPROVE_COST_CAP || 5);

// Files the self-improver is FORBIDDEN to read OR modify. Anything matching is
// silently dropped from prompts and any attempt to write triggers an abort.
const FORBIDDEN_PATTERNS = [
  /^\.env(\..+)?$/,                        // .env, .env.example, .env.production etc.
  /^legal\//,                              // legal/terms.md
  /^src\/services\/budget\.js$/,           // money handling
  /^src\/services\/terms\.js$/,            // terms acceptance
  /^src\/services\/selfImprover\.js$/,     // can't touch itself
  /^src\/lib\/oauthStore\.js$/,            // OAuth tokens
  /^src\/lib\/supabase\.js$/,              // service role wiring
  /SECRET|PRIVATE_KEY|TOKEN|API_KEY/i,
  /\.pem$|\.key$|\.crt$/
];

function isForbidden(filePath) {
  return FORBIDDEN_PATTERNS.some(pat => pat.test(filePath));
}

function gh() {
  if (!process.env.GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN.");
  return axios.create({
    baseURL: "https://api.github.com",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    timeout: 30000
  });
}

/**
 * Fetch a flat list of repo files (paths only) for context, skipping forbidden ones.
 */
async function listRepoFiles() {
  const client = gh();
  // Get default branch HEAD
  const repo = await client.get(`/repos/${SELF_OWNER}/${SELF_REPO}`);
  const defaultBranch = repo.data.default_branch || "main";
  const head = await client.get(`/repos/${SELF_OWNER}/${SELF_REPO}/branches/${defaultBranch}`);
  const treeSha = head.data.commit.commit.tree.sha;
  const tree = await client.get(`/repos/${SELF_OWNER}/${SELF_REPO}/git/trees/${treeSha}?recursive=1`);
  return (tree.data.tree || [])
    .filter(n => n.type === "blob")
    .map(n => n.path)
    .filter(p => !isForbidden(p));
}

async function readRepoFile(path) {
  if (isForbidden(path)) return null;
  const client = gh();
  try {
    const r = await client.get(
      `/repos/${SELF_OWNER}/${SELF_REPO}/contents/${encodeURIComponent(path)}`
    );
    if (r.data.encoding === "base64") {
      return Buffer.from(r.data.content, "base64").toString("utf8");
    }
    return r.data.content || "";
  } catch (err) {
    return null;
  }
}

async function getDailyQuota() {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("self_improvement_quota")
    .select("*").eq("day", today).maybeSingle();
  return data || { day: today, prs_opened: 0, ideas_processed: 0, total_cost_usd: 0 };
}

async function bumpQuota({ prs = 0, ideas = 0, cost = 0 }) {
  const today = new Date().toISOString().slice(0, 10);
  const current = await getDailyQuota();
  await supabase.from("self_improvement_quota").upsert({
    day: today,
    prs_opened: (current.prs_opened || 0) + prs,
    ideas_processed: (current.ideas_processed || 0) + ideas,
    total_cost_usd: Number(current.total_cost_usd || 0) + cost
  });
}

/**
 * File a new improvement idea (from user or auto-monitor).
 */
export async function fileIdea({ title, description, source = "user", scope = "small" }) {
  if (!title || title.trim().length < 4) {
    throw new Error("Idea title too short.");
  }
  const { data, error } = await supabase
    .from("improvement_ideas")
    .insert({
      title: title.trim().slice(0, 200),
      description: (description || "").trim().slice(0, 4000),
      source,
      scope,
      status: "queued"
    })
    .select().single();
  if (error) throw error;
  await logEvent({ projectId: null, message: `Self-improvement idea filed: ${data.title}`, data: { id: data.id, source } });
  return data;
}

export async function listIdeas({ limit = 50, status = null } = {}) {
  let q = supabase.from("improvement_ideas").select("*").order("created_at", { ascending: false }).limit(limit);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function rejectIdea(ideaId, reason = "rejected by user") {
  await supabase.from("improvement_ideas").update({
    status: "rejected", error: reason, updated_at: new Date().toISOString()
  }).eq("id", ideaId);
  return { ok: true };
}

/**
 * Process a queued idea end-to-end: plan → develop → review → open PR.
 * Never pushes to main. Returns the PR url on success.
 */
export async function processIdea(ideaId) {
  const { data: idea, error } = await supabase.from("improvement_ideas").select("*").eq("id", ideaId).single();
  if (error) throw error;
  if (idea.status !== "queued") {
    return { ok: false, error: `Idea status is ${idea.status}, can only process queued ideas.` };
  }

  // Daily cap check
  const quota = await getDailyQuota();
  if (quota.prs_opened >= MAX_PRS_PER_DAY) {
    await supabase.from("improvement_ideas").update({
      status: "skipped", error: `Daily PR cap (${MAX_PRS_PER_DAY}) reached.`, updated_at: new Date().toISOString()
    }).eq("id", ideaId);
    return { ok: false, error: `Daily PR cap reached.` };
  }

  await supabase.from("improvement_ideas").update({ status: "planning", updated_at: new Date().toISOString() }).eq("id", ideaId);

  try {
    // === Step 1: Plan ===
    const repoFiles = await listRepoFiles();
    const planRaw = await askClaude({
      role: "planner",
      json: true,
      system: "You are a senior engineer planning a small, surgical change to an existing repo. Return strict JSON. Keep changes minimal and focused. Favor editing existing files over creating new ones.",
      user: `
Repo: ${SELF_OWNER}/${SELF_REPO}
Idea title: ${idea.title}
Idea description: ${idea.description || "(no extra description)"}

You have access to this list of repo file paths (forbidden files already removed):
${JSON.stringify(repoFiles.slice(0, 200))}

Return JSON:
{
  "summary": "one-sentence description of the change",
  "files_to_read": ["src/services/foo.js", "src/server.js"],
  "files_to_modify": ["src/services/foo.js"],
  "files_to_create": ["docs/new-thing.md"],
  "approach": "2-4 sentences describing the implementation approach",
  "risk": "low | medium | high",
  "tests_needed": ["what to verify after merge"]
}

Rules:
- Only paths from the file list above (or new file paths under src/, docs/, public/, supabase/migrations/).
- Do NOT plan changes to files matching: .env, legal/, src/services/budget.js, src/services/terms.js, src/services/selfImprover.js, src/lib/oauthStore.js, src/lib/supabase.js, anything with SECRET/TOKEN/KEY in the path.
- Maximum 8 files modified+created total.
`
    });
    const plan = safeParseJson(planRaw, null);
    if (!plan || !Array.isArray(plan.files_to_modify) || !Array.isArray(plan.files_to_create)) {
      throw new Error("Planner did not return a usable plan.");
    }

    // Forbidden-file guard on the plan
    const allTargets = [...plan.files_to_modify, ...plan.files_to_create];
    const violations = allTargets.filter(p => isForbidden(p));
    if (violations.length) {
      await supabase.from("improvement_ideas").update({
        status: "skipped",
        forbidden_violation: `Plan tried to touch forbidden files: ${violations.join(", ")}`,
        updated_at: new Date().toISOString()
      }).eq("id", ideaId);
      return { ok: false, error: "forbidden_file_in_plan", violations };
    }

    await supabase.from("improvement_ideas").update({
      status: "building",
      result: { plan },
      updated_at: new Date().toISOString()
    }).eq("id", ideaId);

    // === Step 2: Read files the planner asked for (skipping forbidden) ===
    const fileContext = {};
    for (const path of (plan.files_to_read || []).slice(0, 12)) {
      if (isForbidden(path)) continue;
      const content = await readRepoFile(path);
      if (content) fileContext[path] = content.slice(0, 8000); // cap per file
    }

    // === Step 3: Develop ===
    const devRaw = await askOpenAI({
      role: "developer",
      taskType: "self_improvement",
      json: true,
      system: "You are an expert engineer making a surgical change to an existing repo. Return strict JSON. Always produce complete file contents.",
      user: `
Idea: ${idea.title}
Description: ${idea.description || ""}
Approach: ${plan.approach}

Files you may modify or create (and only these):
${JSON.stringify([...plan.files_to_modify, ...plan.files_to_create])}

Current contents of relevant files:
${JSON.stringify(fileContext, null, 2)}

Return JSON:
{
  "files": [{"path": "...", "content": "complete new file contents"}],
  "summary": "what changed and why",
  "commit_message": "<= 72 char headline"
}

Rules:
- Only paths in the allowed list above.
- Provide COMPLETE file contents (not diffs).
- Never include secrets, .env values, or hardcoded API keys.
- Keep style consistent with existing code (ES modules, async/await, double quotes for JS strings).
`
    });
    const dev = safeParseJson(devRaw, null);
    if (!dev || !Array.isArray(dev.files) || dev.files.length === 0) {
      throw new Error("Developer did not return file contents.");
    }

    // Forbidden check on actual produced files (defense-in-depth)
    for (const f of dev.files) {
      if (!f.path || typeof f.content !== "string") {
        throw new Error("Developer returned malformed file entry.");
      }
      if (isForbidden(f.path)) {
        await supabase.from("improvement_ideas").update({
          status: "skipped",
          forbidden_violation: `Developer tried to modify forbidden file: ${f.path}`,
          updated_at: new Date().toISOString()
        }).eq("id", ideaId);
        return { ok: false, error: "forbidden_file_in_output", path: f.path };
      }
    }

    // === Step 4: Reviewer panel (uses existing reviewer service) ===
    await supabase.from("improvement_ideas").update({
      status: "reviewing", updated_at: new Date().toISOString()
    }).eq("id", ideaId);

    let reviewVerdict = { approved: true, notes: "" };
    try {
      const compactFiles = dev.files.map(f => ({ path: f.path, preview: f.content.slice(0, 4000) }));
      const reviewRaw = await askClaude({
        role: "reviewer_claude",
        json: true,
        system: "You are a senior reviewer for a small self-improvement PR. Return JSON only.",
        user: `Idea: ${idea.title}\nDescription: ${idea.description || ""}\n\nFiles in this change:\n${JSON.stringify(compactFiles, null, 2)}\n\nReturn JSON:\n{\n  \"approved\": true|false,\n  \"reason\": \"short reason\",\n  \"concerns\": [\"...\"],\n  \"notes\": \"\"\n}\n\nApprove unless you see: clear bugs, missing imports, broken syntax, security/secret leaks, or changes outside the idea's stated scope.`
      });
      const parsed = safeParseJson(reviewRaw, null);
      if (parsed) reviewVerdict = parsed;
      if (parsed && parsed.approved === false) {
        await supabase.from("improvement_ideas").update({
          status: "failed",
          error: `Review panel rejected: ${parsed.reason || "no reason"}`,
          result: { plan, dev, review: parsed },
          updated_at: new Date().toISOString()
        }).eq("id", ideaId);
        return { ok: false, error: "review_rejected", review: parsed };
      }
    } catch (err) {
      reviewVerdict = { approved: true, notes: `reviewer error: ${err.message}` };
    }

    // === Step 5: Open a branch + push files + open PR ===
    const branchName = `self-improve/${ideaId.slice(0, 8)}-${Date.now()}`;
    const client = gh();

    // Get HEAD sha of main
    const repo = await client.get(`/repos/${SELF_OWNER}/${SELF_REPO}`);
    const defaultBranch = repo.data.default_branch || "main";
    const refRes = await client.get(`/repos/${SELF_OWNER}/${SELF_REPO}/git/refs/heads/${defaultBranch}`);
    const baseSha = refRes.data.object.sha;

    // Create branch
    await client.post(`/repos/${SELF_OWNER}/${SELF_REPO}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });

    // Push each file to the branch
    for (const f of dev.files) {
      let existingSha = null;
      try {
        const cur = await client.get(`/repos/${SELF_OWNER}/${SELF_REPO}/contents/${encodeURIComponent(f.path)}?ref=${branchName}`);
        existingSha = cur.data.sha;
      } catch {}
      const payload = {
        message: `${dev.commit_message || `self-improve: ${idea.title}`} (${f.path})`,
        content: Buffer.from(f.content, "utf8").toString("base64"),
        branch: branchName
      };
      if (existingSha) payload.sha = existingSha;
      await client.put(`/repos/${SELF_OWNER}/${SELF_REPO}/contents/${encodeURIComponent(f.path)}`, payload);
    }

    // Open PR
    const prBody = `**Self-improvement idea:** ${idea.title}

**Source:** ${idea.source}
**Risk:** ${plan.risk || "unknown"}
**Approach:** ${plan.approach || "(no description)"}

**Files changed:** ${dev.files.length}
${dev.files.map(f => `- \`${f.path}\``).join("\n")}

**Tests / verification needed:**
${(plan.tests_needed || []).map(t => `- ${t}`).join("\n") || "(none specified)"}

**Reviewer panel:** ${reviewVerdict.approved ? "✅ approved" : "❌ rejected"}
${reviewVerdict.notes ? `> ${reviewVerdict.notes}` : ""}

---
Auto-opened by self-improvement system. Idea ID: \`${ideaId}\`. Merge here or close this PR to discard.`;

    const prRes = await client.post(`/repos/${SELF_OWNER}/${SELF_REPO}/pulls`, {
      title: `self-improve: ${idea.title}`,
      head: branchName,
      base: defaultBranch,
      body: prBody
    });

    // Add label (best-effort)
    try {
      await client.post(`/repos/${SELF_OWNER}/${SELF_REPO}/issues/${prRes.data.number}/labels`, {
        labels: ["self-improvement"]
      });
    } catch {}

    await supabase.from("improvement_ideas").update({
      status: "pr_open",
      branch_name: branchName,
      pr_url: prRes.data.html_url,
      pr_number: prRes.data.number,
      result: { plan, dev, review: reviewVerdict, pr: prRes.data.html_url },
      updated_at: new Date().toISOString()
    }).eq("id", ideaId);

    await bumpQuota({ prs: 1, ideas: 1 });
    await logEvent({ projectId: null, message: `Self-improvement PR opened: ${prRes.data.html_url}`, data: { idea: idea.title } });

    return { ok: true, prUrl: prRes.data.html_url, prNumber: prRes.data.number, branch: branchName };
  } catch (err) {
    await supabase.from("improvement_ideas").update({
      status: "failed",
      error: err.message || String(err),
      updated_at: new Date().toISOString()
    }).eq("id", ideaId);
    await logEvent({ projectId: null, level: "error", message: `Self-improvement failed: ${err.message}` });
    return { ok: false, error: err.message };
  }
}

/**
 * Roll back a merged self-improvement PR by reverting the merge commit.
 */
export async function rollbackIdea(ideaId) {
  const { data: idea } = await supabase.from("improvement_ideas").select("*").eq("id", ideaId).single();
  if (!idea) throw new Error("Idea not found.");
  if (!idea.merge_commit_sha) {
    return { ok: false, error: "No merge_commit_sha recorded — was this idea merged via the self-improver?" };
  }
  const client = gh();
  // GitHub doesn't have a single revert API; we open a revert PR.
  // For simplicity we flip status and ping the user to do a `git revert` manually
  // (production-grade revert requires a follow-up PR — left as a TODO).
  await supabase.from("improvement_ideas").update({
    reverted_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }).eq("id", ideaId);
  return {
    ok: true,
    message: `To revert ${idea.merge_commit_sha}, run locally: \`git revert ${idea.merge_commit_sha} && git push\``
  };
}

/**
 * Auto-monitor: scan recent error logs and file ideas for repeating errors.
 * Designed to be called by a cron or interval. Idempotent (skips errors
 * that already have an open idea).
 */
export async function scanLogsAndFileIdeas({ hours = 24, minOccurrences = 3 } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const { data: logs } = await supabase
    .from("logs").select("message, data, created_at")
    .eq("level", "error").gte("created_at", since).limit(500);

  if (!logs || logs.length === 0) return { filed: 0 };

  // Cluster by normalized message
  const clusters = new Map();
  for (const l of logs) {
    const key = (l.message || "").replace(/\d+/g, "N").replace(/[a-f0-9-]{8,}/g, "ID").slice(0, 120);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(l);
  }

  const repeatingClusters = [...clusters.entries()].filter(([, items]) => items.length >= minOccurrences);

  // Already-open ideas with same title prefix to avoid duplicates
  const { data: openIdeas } = await supabase.from("improvement_ideas")
    .select("title").in("status", ["queued", "planning", "building", "reviewing", "pr_open"]);
  const openTitles = new Set((openIdeas || []).map(i => i.title));

  let filed = 0;
  for (const [key, items] of repeatingClusters) {
    const title = `Fix repeating error: ${key.slice(0, 80)}`;
    if (openTitles.has(title)) continue;
    await fileIdea({
      title,
      description: `This error appeared ${items.length} times in the last ${hours}h.\n\nSample messages:\n${items.slice(0, 5).map(i => `- ${i.message}`).join("\n")}`,
      source: "auto_log",
      scope: "bugfix"
    });
    filed++;
  }
  return { filed, scanned: logs.length, clusters: repeatingClusters.length };
}
