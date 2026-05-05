/**
 * document pipeline — Generate a document deliverable (PDF/DOCX/PPTX/XLSX).
 *
 * Strategy (v1):
 *  1. LLM writes the full content as Markdown.
 *  2. A conversion script (convert.js using pdfkit) is included in the repo
 *     so the orchestrator can run it if pdfkit is available.
 *  3. The Markdown file is always returned as a 'report' deliverable.
 *  4. If pandoc is available in the sandbox, commandsToRun includes the
 *     pandoc call to produce a PDF.
 *
 * files = [markdown + conversion script]
 * deliverables = [{ kind: 'report', filename: '*.md', data: <markdown string> }]
 *                + optionally PDF if post-processing is done by orchestrator
 */

import { askOpenAI } from "../agents/openaiClient.js";
import { askClaude } from "../agents/claudeClient.js";
import { safeParseJson } from "../agents/jsonUtils.js";

const PLAN_SCHEMA_HINT = `
Return strict JSON only, no prose, no markdown fences.
{
  "projectName": "kebab-case-name",
  "summary": "One sentence description",
  "techStack": ["Markdown", "pdfkit", "pandoc"],
  "successCriteria": ["Document is complete and well-structured", "PDF deliverable generated", "..."],
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "type": "docs|setup|review",
      "priority": 1
    }
  ]
}

Rules:
- 4-6 tasks total.
- Tasks: outline content, write each major section, generate file (Markdown + conversion script), review / final polish.
- The final output format may be PDF, DOCX, PPTX, or XLSX depending on the goal.
- Never include secrets or credentials.
`;

/**
 * Plan tasks for a document generation project.
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
      "You are a senior technical writer and document architect. Return strict JSON only.",
    user: `
Goal:
${effectiveGoal}

${PLAN_SCHEMA_HINT}
`
  });

  const parsed = safeParseJson(raw, null);
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error("document planner did not return a valid plan JSON.");
  }

  parsed.tasks = parsed.tasks.slice(0, 6);
  return parsed;
}

/**
 * Execute a single document task.
 *
 * For content tasks → Claude writes the Markdown.
 * For the "generate file" task → also emit a pdfkit conversion script.
 */
export async function executeTask({ project, task, existingFiles }) {
  const previewFiles = (existingFiles || []).map(f => ({
    path: f.path,
    preview: typeof f.content === "string" ? f.content.slice(0, 3000) : ""
  }));

  // Use Claude for rich prose writing; falls back to OpenAI if unconfigured.
  const contentRaw = await askClaude({
    role: "reviewer",
    projectId: project?.id || null,
    json: false,
    system:
      "You are an expert technical writer. Write in clear, professional Markdown. No JSON — just the document content.",
    user: `
Project goal:
${project?.goal || ""}

Document plan:
${JSON.stringify(project?.plan || {})}

Current task:
${task.title}
${task.description}

Existing document sections (path + preview):
${JSON.stringify(previewFiles)}

Write the Markdown content for this task section. Be thorough and professional.
If this is a final "generate" or "review" task, produce the complete assembled document.
`
  });

  // Now build the file list with a structured LLM call.
  const structureRaw = await askOpenAI({
    role: "developer",
    taskType: "docs",
    projectId: project?.id || null,
    json: true,
    system: "You are a document engineer. Return strict JSON only.",
    user: `
You are assembling a document project. The content for this task is below.
Wrap it into the correct file structure.

Task: ${task.title}
Content written by Claude:
${contentRaw}

Existing files (path + preview):
${JSON.stringify(previewFiles)}

Return JSON of the form:
{
  "summary": "...",
  "files": [
    { "path": "document.md", "content": "...full markdown..." },
    { "path": "convert.js", "content": "...pdfkit script to convert document.md to document.pdf..." }
  ],
  "commandsToRun": ["node convert.js"],
  "needsSmokeTest": false,
  "notes": ["The .md file is also provided as a deliverable", "Run convert.js to produce a PDF"]
}

Rules:
- document.md must contain the complete, assembled Markdown document.
- convert.js must use pdfkit (npm package 'pdfkit') to write document.pdf. Use: const PDFDocument = require('pdfkit'); const fs = require('fs');
- commandsToRun should be: ["npm install pdfkit", "node convert.js"] only when this is the final generation task; otherwise [].
- Return complete files. No diffs.
`
  });

  const parsed = safeParseJson(structureRaw, null);

  // Fallback: if parsing failed, wrap contentRaw as a plain markdown file.
  const files = (parsed?.files || []).filter(
    f => f && typeof f.path === "string" && typeof f.content === "string"
  );

  if (files.length === 0) {
    // Minimal fallback: just save the markdown.
    files.push({ path: "document.md", content: contentRaw || "# Document\n\n(No content generated)" });
  }

  // Find the markdown file to emit as a deliverable.
  const mdFile = files.find(f => f.path.endsWith(".md")) || files[0];
  const deliverables = [
    {
      kind: "report",
      filename: mdFile.path.split("/").pop() || "document.md",
      data: mdFile.content,
      mimeType: "text/markdown",
      generator: "document",
      metadata: { projectGoal: project?.goal || "", taskTitle: task.title }
    }
  ];

  return {
    summary: parsed?.summary || `Generated document content for: ${task.title}`,
    files,
    commandsToRun: Array.isArray(parsed?.commandsToRun) ? parsed.commandsToRun : [],
    needsSmokeTest: false,
    notes: Array.isArray(parsed?.notes) ? parsed.notes : [
      "The Markdown file is provided as a 'report' deliverable.",
      "Run 'npm install pdfkit && node convert.js' to produce a PDF."
    ],
    deliverables
  };
}
