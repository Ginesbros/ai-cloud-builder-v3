import { askClaude } from "./claudeClient.js";
import { askGemini } from "./geminiClient.js";
import { askGrok } from "./grokClient.js";

export async function reviewProject({
  project,
  task,
  files
}) {
  const compactFiles = files.map(file => ({
    path: file.path,
    preview: file.content.slice(0, 4000)
  }));

  const system = `
You are a senior code reviewer.
Review for:
- bugs
- broken imports
- build problems
- security issues
- missing files
- poor architecture
- deployment problems

Return practical, direct feedback.
`;

  const user = `
Project goal:
${project.goal}

Current task:
${task?.title || "full project review"}

Files:
${JSON.stringify(compactFiles, null, 2)}
`;

  const claudeReview = await askClaude({
    system,
    user,
    json: false
  });

  const geminiReview = await askGemini({
    system: `
You are a long-context software analyst.
Focus on project structure, missing files, dependency issues, and architecture.
`,
    user,
    json: false
  });

  const grokReview = await askGrok({
    system: `
You are a blunt secondary code reviewer.
Look for obvious mistakes and practical fixes.
`,
    user,
    json: false
  });

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
