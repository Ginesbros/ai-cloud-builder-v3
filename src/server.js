import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";
import {
  createProject,
  getProject,
  runNextTask,
  runAutonomousProject
} from "./services/orchestrator.js";
import {
  getBudgetConfig,
  getMonthlyEstimatedSpend
} from "./services/budget.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ai-cloud-builder-v3"
  });
});

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

app.post("/api/projects", async (req, res) => {
  try {
    const body = z.object({
      goal: z.string().min(10),
      name: z.string().optional(),
      autonomyMode: z.enum(["safe", "dev", "autonomous"]).optional()
    }).parse(req.body);

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
    res.json({
      ok: true,
      ...result
    });
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
    res.json({
      ok: true,
      result
    });
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
    res.json({
      ok: true,
      result
    });
  } catch (error) {
    console.error("Run autonomous error:", error);

    res.status(500).json({
      ok: false,
      error: error?.message || JSON.stringify(error)
    });
  }
});
app.get("/debug/env-safe", async (_req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  res.json({
    ok: true,
    supabaseUrlPresent: Boolean(supabaseUrl),
    supabaseUrl,
    supabaseUrlHasRestV1: supabaseUrl.includes("/rest/v1"),
    supabaseKeyPresent: Boolean(supabaseKey),
    supabaseKeyStartsWith: supabaseKey.slice(0, 10),
    supabaseKeyLength: supabaseKey.length
  });
});
app.get("/debug/supabase-test", async (_req, res) => {
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
const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log(`AI Cloud Builder v3 running on port ${port}`);
});
