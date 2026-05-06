import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { z } from "zod";
import {
  createProject,
  getProject,
  listProjects,
  runNextTask,
  runAutonomousProject,
  submitClarifications
} from "./services/orchestrator.js";
import { getDeliverableUrl } from "./lib/storage.js";
import { listKinds } from "./pipelines/index.js";
import { getTerms, hasAccepted, recordAcceptance, isBanned } from "./services/terms.js";
import { getProviderStatus, persistTokens } from "./lib/oauthStore.js";
import { manusHealthCheck } from "./agents/manusClient.js";
import axios from "axios";
import { getBudgetConfig, getMonthlyEstimatedSpend } from "./services/budget.js";
import { deployProjectToVercel } from "./services/vercel.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

// --- Static dashboard ---
app.use(express.static(path.join(__dirname, "..", "public")));

// --- Public health ---
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ai-cloud-builder-v3" });
});

// --- Admin auth middleware (gates /debug and optionally /api) ---
function getUserId(req) {
  // Identity strategy: prefer authenticated user, fall back to anonymous
  // browser fingerprint sent via x-user-id header. Dashboard generates a UUID
  // on first visit and stores it in localStorage.
  return (
    req.header("x-user-id") ||
    req.header("x-user-email") ||
    req.ip ||
    "anonymous"
  );
}

async function requireTermsAccepted(req, res, next) {
  try {
    const userId = getUserId(req);
    const ban = await isBanned(userId);
    if (ban.banned) {
      return res.status(403).json({
        ok: false,
        error: "Your access to the Service has been terminated.",
        reason: ban.reason || null
      });
    }
    const status = await hasAccepted(userId);
    if (!status.accepted) {
      return res.status(412).json({
        ok: false,
        error: "Terms of Service must be accepted before using this endpoint.",
        currentTermsVersion: status.currentVersion,
        acceptedVersion: status.acceptedVersion
      });
    }
    next();
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
}

function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return next(); // no token configured = open mode (dev)
  const provided =
    req.header("x-admin-token") ||
    (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (provided && provided === expected) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized." });
}

// --- API routes ---
app.get("/api/budget", async (_req, res) => {
  try {
    const monthlyEstimatedSpend = await getMonthlyEstimatedSpend();
    res.json({
      ok: true,
      config: getBudgetConfig(),
      monthlyEstimatedSpend
    });
  } catch (error) {
    console.error("Budget endpoint error:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || JSON.stringify(error)
    });
  }
});

app.get("/api/projects", async (_req, res) => {
  try {
    const projects = await listProjects({ limit: 100 });
    res.json({ ok: true, projects });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message });
  }
});

app.get("/api/kinds", (_req, res) => {
  res.json({ ok: true, kinds: listKinds() });
});

// --- OAuth re-auth (Higgsfield device flow) ---
// Admin-gated because device-flow tokens grant access to your billable services.
app.post("/api/oauth/:provider/authorize", requireAdminToken, async (req, res) => {
  try {
    const provider = req.params.provider;
    if (provider !== "higgsfield") return res.status(400).json({ ok: false, error: "Unsupported provider." });
    const r = await axios.post(
      "https://fnf-device-auth.higgsfield.ai/authorize",
      {},
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    res.json({ ok: true, ...r.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

app.post("/api/oauth/:provider/poll", requireAdminToken, async (req, res) => {
  try {
    const provider = req.params.provider;
    const { device_code } = req.body || {};
    if (provider !== "higgsfield") return res.status(400).json({ ok: false, error: "Unsupported provider." });
    if (!device_code) return res.status(400).json({ ok: false, error: "device_code required." });

    const r = await axios.post(
      "https://fnf-device-auth.higgsfield.ai/token",
      { device_code },
      { headers: { "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true }
    );
    if (r.status !== 200) {
      return res.json({ ok: false, status: r.status, detail: r.data?.detail });
    }
    const result = await persistTokens(provider, r.data);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

app.get("/api/oauth/:provider/status", requireAdminToken, async (req, res) => {
  try {
    const status = await getProviderStatus(req.params.provider);
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

app.get("/api/connections/manus/status", requireAdminToken, async (_req, res) => {
  try {
    const status = await manusHealthCheck();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

// --- Terms of Service ---
app.get("/api/terms", (_req, res) => {
  const t = getTerms();
  res.json({ ok: true, version: t.version, lastUpdated: t.lastUpdated, markdown: t.markdown });
});

app.get("/api/terms/status", async (req, res) => {
  try {
    const userId = getUserId(req);
    const status = await hasAccepted(userId);
    const ban = await isBanned(userId);
    res.json({ ok: true, userId, ...status, banned: ban.banned, banReason: ban.reason || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

app.post("/api/terms/accept", async (req, res) => {
  try {
    const userId = getUserId(req);
    const userEmail = req.body?.email || req.header("x-user-email") || null;
    const ban = await isBanned(userId);
    if (ban.banned) {
      return res.status(403).json({ ok: false, error: "Account terminated.", reason: ban.reason });
    }
    const result = await recordAcceptance({
      userId,
      userEmail,
      ipAddress: req.ip,
      userAgent: req.header("user-agent") || null
    });
    res.json({ ok: true, ...result, userId });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message });
  }
});

// --- Component library (shared memory of past builds) ---
app.get("/api/library", async (req, res) => {
  try {
    const { supabase } = await import("./lib/supabase.js");
    const q = (req.query.q || "").toString().trim();
    const kind = (req.query.kind || "").toString().trim();
    let query = supabase
      .from("build_components")
      .select("id,name,description,tags,kind,task_type,reuse_count,pinned,created_at,source_project_id")
      .eq("shared", true)
      .order("reuse_count", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200);
    if (kind) query = query.eq("kind", kind);
    if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, components: data || [] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message });
  }
});

app.get("/api/library/:id", async (req, res) => {
  try {
    const { supabase } = await import("./lib/supabase.js");
    const { data, error } = await supabase
      .from("build_components")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ ok: false, error: "Not found." });
    // Don't expose embedding in API response (huge + private).
    delete data.embedding;
    res.json({ ok: true, component: data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message });
  }
});

app.post("/api/library/:id/pin", requireAdminToken, async (req, res) => {
  try {
    const { supabase } = await import("./lib/supabase.js");
    const pinned = Boolean(req.body?.pinned);
    const { error } = await supabase
      .from("build_components")
      .update({ pinned, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message });
  }
});

app.delete("/api/library/:id", requireAdminToken, async (req, res) => {
  try {
    const { supabase } = await import("./lib/supabase.js");
    const { error } = await supabase.from("build_components").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message });
  }
});

app.post("/api/projects/:projectId/clarifications", async (req, res) => {
  try {
    const body = z.object({ answers: z.array(z.string()) }).parse(req.body);
    const result = await submitClarifications({
      projectId: req.params.projectId,
      answers: body.answers
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message });
  }
});

app.get("/api/deliverables/:id/url", async (req, res) => {
  try {
    const url = await getDeliverableUrl(req.params.id);
    if (!url) return res.status(404).json({ ok: false, error: "Not found." });
    res.json({ ok: true, url });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message });
  }
});

app.get("/api/deliverables/:id/download", async (req, res) => {
  try {
    const url = await getDeliverableUrl(req.params.id);
    if (!url) return res.status(404).json({ ok: false, error: "Not found." });
    res.redirect(url);
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message });
  }
});

app.post("/api/projects", requireTermsAccepted, async (req, res) => {
  try {
    const body = z
      .object({
        goal: z.string().min(10),
        name: z.string().optional(),
        autonomyMode: z.enum(["safe", "dev", "autonomous"]).optional(),
        attachedDocs: z.array(z.object({
          filename: z.string().optional(),
          url: z.string().optional(),
          content: z.string().optional()
        })).optional()
      })
      .parse(req.body);

    const result = await createProject(body);
    res.json(result);
  } catch (error) {
    console.error("Create project error:", error);
    res.status(400).json({
      ok: false,
      error: error?.message || JSON.stringify(error)
    });
  }
});

app.get("/api/projects/:projectId", async (req, res) => {
  try {
    const result = await getProject(req.params.projectId);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error("Get project error:", error);
    res.status(404).json({
      ok: false,
      error: error?.message || JSON.stringify(error)
    });
  }
});

app.post("/api/projects/:projectId/run-next", async (req, res) => {
  try {
    const result = await runNextTask(req.params.projectId);
    res.json({ ok: true, result });
  } catch (error) {
    console.error("Run next task error:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || JSON.stringify(error)
    });
  }
});

app.post("/api/projects/:projectId/run-autonomous", async (req, res) => {
  try {
    const result = await runAutonomousProject(req.params.projectId);
    res.json({ ok: true, result });
  } catch (error) {
    console.error("Run autonomous error:", error);
    res.status(500).json({
      ok: false,
      error: error?.message || JSON.stringify(error)
    });
  }
});

app.get("/api/assets/:assetId", async (req, res) => {
  try {
    const { supabase } = await import("./lib/supabase.js");
    const { data, error } = await supabase
      .from("project_assets")
      .select("mime_type,content_base64,external_url")
      .eq("id", req.params.assetId)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ ok: false, error: "Not found." });
    if (data.external_url) return res.redirect(data.external_url);
    if (!data.content_base64) return res.status(404).json({ ok: false, error: "No content." });
    res.setHeader("Content-Type", data.mime_type || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(data.content_base64, "base64"));
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message });
  }
});

app.post("/api/projects/:projectId/deploy", async (req, res) => {
  try {
    const result = await deployProjectToVercel(req.params.projectId);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message });
  }
});

// --- Protected debug routes ---
app.get("/debug/env-safe", requireAdminToken, async (_req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  res.json({
    ok: true,
    supabaseUrlPresent: Boolean(supabaseUrl),
    supabaseUrl,
    supabaseUrlHasRestV1: supabaseUrl.includes("/rest/v1"),
    supabaseKeyPresent: Boolean(supabaseKey),
    supabaseKeyStartsWith: supabaseKey.slice(0, 10),
    supabaseKeyLength: supabaseKey.length,
    openaiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
    githubTokenPresent: Boolean(process.env.GITHUB_TOKEN),
    perplexityKeyPresent: Boolean(process.env.PERPLEXITY_API_KEY),
    anthropicKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
    geminiKeyPresent: Boolean(process.env.GOOGLE_GEMINI_API_KEY),
    grokKeyPresent: Boolean(process.env.XAI_API_KEY),
    vercelTokenPresent: Boolean(process.env.VERCEL_TOKEN)
  });
});

app.get("/debug/supabase-test", requireAdminToken, async (_req, res) => {
  try {
    const { supabase } = await import("./lib/supabase.js");
    const { data, error } = await supabase
      .from("ai_usage")
      .select("id")
      .limit(1);

    res.json({
      ok: !error,
      data,
      error: error
        ? {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code
          }
        : null
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      errorName: error?.name,
      errorMessage: error?.message,
      fullError: String(error)
    });
  }
});

// --- Fallback: serve dashboard for any other GET (SPA-style) ---
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/debug")) return next();
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`AI Cloud Builder v3 running on port ${port}`);
});
