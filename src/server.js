import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";
import { createProject, getProject, runNextTask, runAutonomousProject } from "./services/orchestrator.js";
import { getBudgetConfig, getMonthlyEstimatedSpend } from "./services/budget.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ai-cloud-builder-v3" });
});

app.get("/api/budget", async (_req, res) => {
  res.json({
    config: getBudgetConfig(),
    monthlyEstimatedSpend: await getMonthlyEstimatedSpend()
  });
});

app.post("/api/projects", async (req, res) => {
  try {
    const body = z.object({
      goal: z.string().min(10),
      name: z.string().optional(),
      autonomyMode: z.enum(["safe", "dev", "autonomous"]).optional()
    }).parse(req.body);

    res.json(await createProject(body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/projects/:projectId", async (req, res) => {
  try {
    res.json(await getProject(req.params.projectId));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post("/api/projects/:projectId/run-next", async (req, res) => {
  try {
    res.json(await runNextTask(req.params.projectId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/projects/:projectId/run-autonomous", async (req, res) => {
  try {
    res.json(await runAutonomousProject(req.params.projectId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`AI Cloud Builder v3 running on port ${port}`);
});
