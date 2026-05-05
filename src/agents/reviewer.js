import { askClaude } from "./claudeClient.js";
import { askGemini } from "./geminiClient.js";
import { askGrok } from "./grokClient.js";

export async function reviewProject({ project, task, files }) {
  const compactFiles = (files || []).map(file => ({
    path: file.path,
    preview: typeof file.content === "string" ? file.content.slice(0, 4000) : ""
  }));

  const user = `Project goal:\n${project.goal}\n\nCurrent task:\n${
    task?.title || "full project review"
  }\n\nFiles:\n${JSON.stringify(compactFiles, null, 2)}`;

  const [claudeReview, geminiReview, grokReview] = await Promise.all([
    askClaude({
      system:
        "You are a senior code reviewer. Review for bugs, imports, build problems, security, missing files, architecture, and deployment problems.",
      user
    }),
    askGemini({
      system:
        "You are a long-context software analyst. Focus on project structure, missing files, dependency issues, and architecture.",
      user
    }),
    askGrok({
      system: "You are a blunt secondary code reviewer. Look for obvious mistakes and practical fixes.",
      user
    })
  ]);

  return {
    claudeReview,
    geminiReview,
    grokReview,
    summary: [
      "Claude used for senior code/security review.",
      "Gemini used for large-structure analysis.",
      "Grok used for alternative second opinion."
    ]
  };
}
