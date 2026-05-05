/**
 * Librarian agent — wraps NotebookLM digest as a task-level executor.
 *
 * Most of the time the librarian runs INSIDE the planner (passed as
 * `attachedDocs`). But the planner can also emit a `docs` task type if there
 * are docs to digest after the project is already underway. This wrapper
 * handles that case.
 *
 * Inputs come from task.description, which may include URLs or inline doc
 * content. The librarian returns its digest as a project_files entry at
 * `docs/research-digest.md` so it ships with the repo.
 */

import { digestDocs } from "./notebookLmClient.js";

export async function executeLibrarianTask({ project, task }) {
  // A simple convention: each non-empty line of the description that starts
  // with `http` is treated as a URL; everything else is the inline doc body.
  const lines = (task.description || "").split("\n").map(s => s.trim()).filter(Boolean);
  const urls = lines.filter(l => /^https?:\/\//i.test(l));
  const inline = lines.filter(l => !/^https?:\/\//i.test(l)).join("\n");

  const docs = [];
  if (inline.length > 0) {
    docs.push({ filename: "task-description", content: inline });
  }
  for (const url of urls) {
    docs.push({ url, content: `URL only — fetch not implemented in librarian agent: ${url}` });
  }

  if (!docs.length) {
    return {
      summary: "Librarian: no docs found in task description.",
      files: [],
      commandsToRun: [],
      needsSmokeTest: false,
      notes: ["Nothing to digest."]
    };
  }

  const digest = await digestDocs({
    docs,
    projectId: project.id,
    taskId: task.id
  });

  return {
    summary: "Librarian produced research digest.",
    files: [
      {
        path: "docs/research-digest.md",
        content: `# Research Digest\n\n${digest}\n`
      }
    ],
    commandsToRun: [],
    needsSmokeTest: false,
    notes: ["Digest written to docs/research-digest.md"]
  };
}
