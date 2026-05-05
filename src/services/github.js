import axios from "axios";
import { supabase } from "../lib/supabase.js";

function githubClient() {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER) {
    throw new Error("Missing GitHub env vars (GITHUB_TOKEN, GITHUB_OWNER).");
  }

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

export async function createRepoIfNeeded(project) {
  const owner = process.env.GITHUB_OWNER;
  const repoName = project.repo_name || project.name;
  const gh = githubClient();

  if (project.repo_name && project.repo_url) {
    return { repoName: project.repo_name, repoUrl: project.repo_url };
  }

  try {
    const existing = await gh.get(`/repos/${owner}/${repoName}`);
    return { repoName, repoUrl: existing.data.html_url };
  } catch {
    const created = await gh.post("/user/repos", {
      name: repoName,
      private: true,
      auto_init: true,
      description: `AI-generated: ${(project.goal || "").slice(0, 120)}`
    });
    return { repoName, repoUrl: created.data.html_url };
  }
}

async function getExistingSha({ gh, owner, repoName, path }) {
  try {
    const existing = await gh.get(
      `/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}`
    );
    return existing.data.sha;
  } catch {
    return null;
  }
}

export async function upsertFilesToGitHub({ projectId, repoName }) {
  const gh = githubClient();
  const owner = process.env.GITHUB_OWNER;

  const { data: files, error } = await supabase
    .from("project_files")
    .select("*")
    .eq("project_id", projectId);
  if (error) throw error;

  const pushed = [];
  for (const file of files || []) {
    const sha = await getExistingSha({ gh, owner, repoName, path: file.path });

    // Decode designer's __BINARY_BASE64__ marker → raw base64 for GitHub.
    let contentBase64;
    if (typeof file.content === "string" && file.content.startsWith("__BINARY_BASE64__")) {
      const newlineIdx = file.content.indexOf("\n");
      contentBase64 = newlineIdx >= 0 ? file.content.slice(newlineIdx + 1) : "";
    } else {
      contentBase64 = Buffer.from(file.content, "utf8").toString("base64");
    }

    const payload = {
      message: `AI update ${file.path}`,
      content: contentBase64,
      branch: "main"
    };
    if (sha) payload.sha = sha;

    const response = await gh.put(
      `/repos/${owner}/${repoName}/contents/${encodeURIComponent(file.path)}`,
      payload
    );
    await supabase
      .from("project_files")
      .update({ sha: response.data.content.sha, updated_at: new Date().toISOString() })
      .eq("id", file.id);
    pushed.push(file.path);
  }

  return { pushed };
}
