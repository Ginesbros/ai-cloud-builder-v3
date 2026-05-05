/**
 * research pipeline — Multi-source research report.
 *
 * Flow per task:
 *  1. askPerplexity for 3-5 research angles.
 *  2. askClaude to synthesize findings into a structured Markdown report.
 *  3. Return the report as a 'report' deliverable.
 *
 * files = []           (no code in repo)
 * deliverables = [Markdown report as 'report' deliverable per synthesis task]
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { askClaude } from "../agents/claudeClient.js";
import { askPerplexity } from "../agents/perplexityClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return strict JSON only, no prose, no markdown fences.
{
  "projectName": "kebab-case-name",
  "summary": "One sentence description",
  "techStack": ["Perplexity (research)", "Claude (synthesis)"],
  "successCriteria": ["All research angles covered", "Synthesis report produced", "PDF deliverable available", "..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "docs|review",
      "priority": 1
    }
  ]
}

Rules:
- 4-8 tasks total.
- Always include: 3-5 research query tasks (one per angle), one synthesis task, one review/polish task.
- Research tasks have type "docs"; synthesis and review tasks have type "review".
- Never include secrets or credentials.
`;

/**
 * Plan tasks for a research report project.
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
      "You are a senior research director and analyst. Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

${PLAN_SCHEMA_HINT}

The tasks should cover distinct research angles. Examples:
- "Market landscape research"
- "Competitive analysis research"
- "Technical feasibility research"
- "Regulatory and compliance research"
- "Synthesize all findings"
- "Review and finalize report"
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("research planner did not return a valid plan JSON.");
  }

  parsed.tasks = parsed.tasks.slice(0, 8);
  return parsed;
}

/**
 * Execute a single research task.
 *
 * Research tasks → query Perplexity for the angle, save raw as a note.
 * Synthesis / review tasks → Claude synthesizes all prior findings into a report.
 */
export async function executeTask({ project, task, existingFiles }) {
  const taskTitleLower = (task.title || "").toLowerCase();
  const isSynthesis =
    taskTitleLower.includes("synthes") ||
    taskTitleLower.includes("review") ||
    taskTitleLower.includes("final") ||
    taskTitleLower.includes("polish") ||
    task.type === "review";

  const deliverables = [];
  const notes = [];

  // ---- Synthesis / review task ----
  if (isSynthesis) {
    // Gather all prior research notes from existingFiles (if any stored as .md).
    const priorResearch = (existingFiles || [])
      .filter(f => f.path && f.path.endsWith(".md"))
      .map(f => `### ${f.path}\n${(f.content || "").slice(0, 4000)}`)
      .join("\n\n---\n\n");

    const synthesis = await askClaude({
      role: "reviewer",
      projectId: project?.id || null,
      json: false,
      maxTokens: 8192,
      system:
        "You are a senior research analyst. Synthesize multiple research sources into a coherent, well-structured Markdown report. Use clear headings, executive summary, key findings, and actionable conclusions.",
      user: `
Research project goal:
${project?.goal || ""}

Task: ${task.title}
${task.description}

Prior research collected:
${priorResearch || "(No prior research files found — synthesize based on the goal.)"}

Write a comprehensive research report in Markdown covering:
1. Executive Summary
2. Key Findings (organized by research angle)
3. Competitive / Market Landscape (if applicable)
4. Technical Feasibility (if applicable)
5. Risks and Opportunities
6. Recommendations
7. Sources and Methodology

Be specific, cite data points where possible, and write for a professional audience.
`
    });

    const reportContent = synthesis || "# Research Report\n\n(Synthesis failed)";
    const reportFilename = "research-report.md";

    deliverables.push({
      kind: "report",
      filename: reportFilename,
      data: reportContent,
      mimeType: "text/markdown",
      generator: "research",
      metadata: { taskTitle: task.title, projectGoal: project?.goal || "" }
    });

    notes.push("Full research report saved as a Markdown deliverable.");

    return {
      summary: `Research synthesized into comprehensive report for: ${project?.goal || task.title}`,
      files: [{ path: reportFilename, content: reportContent }],
      commandsToRun: [],
      needsSmokeTest: false,
      notes,
      deliverables
    };
  }

  // ---- Research query task ----
  // Generate 3-5 focused query angles for this task.
  const queryRaw = await askOpenAI({
    role: "planner",
    projectId: project?.id || null,
    json: true,
    system: "You are a research strategist. Return strict JSON only.",
    user: `
Research goal: ${project?.goal || ""}
Current research task: ${task.title} — ${task.description}

Generate 3 specific, focused research queries to answer this angle thoroughly.

Return JSON:
{
  "queries": ["query 1", "query 2", "query 3"]
}
`
  });

  const queryData = safeParseJson(queryRaw, { queries: [] });
  const queries = Array.isArray(queryData.queries) && queryData.queries.length > 0
    ? queryData.queries
    : [
        `${task.title} for: ${project?.goal || ""}`,
        `Best practices and recent developments: ${task.title}`,
        `Key challenges and opportunities: ${task.title}`
      ];

  // Query Perplexity for each angle in parallel.
  const researchResults = await Promise.all(
    queries.map(q =>
      askPerplexity(q, {
        projectId: project?.id || null,
        taskId: task?.id || null
      })
    )
  );

  // Compile raw research into a Markdown file stored in the repo for the synthesis step.
  const compiledContent = [
    `# Research: ${task.title}`,
    `\n_Project goal: ${project?.goal || ""}_\n`,
    ...queries.map((q, i) => `## Query ${i + 1}: ${q}\n\n${researchResults[i] || "(No results)"}\n`)
  ].join("\n");

  const filename = `research-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`;

  notes.push(`Queried ${queries.length} research angles via Perplexity.`);
  notes.push(`Raw findings saved to ${filename} for synthesis step.`);

  return {
    summary: `Research collected for: ${task.title}`,
    files: [{ path: filename, content: compiledContent }],
    commandsToRun: [],
    needsSmokeTest: false,
    notes,
    deliverables: []
  };
}
