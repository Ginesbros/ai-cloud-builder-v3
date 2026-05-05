import axios from "axios";
import { supabase } from "../lib/supabase.js";
import { logEvent } from "../lib/logger.js";

/**
 * If VERCEL_TOKEN is set, attempt to create a Vercel project linked to the GitHub repo.
 * Otherwise, return a manual handoff message.
 */
export async function deployProjectToVercel(projectId) {
  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error) throw error;
  if (!project.repo_url) throw new Error("Project has no GitHub repo URL yet.");

  if (!process.env.VERCEL_TOKEN) {
    const result = {
      status: "connect_repo_in_vercel",
      message:
        "Import this generated GitHub repo into Vercel once. Future pushes auto-deploy.",
      repoName: project.repo_name,
      repoUrl: project.repo_url
    };
    await logEvent({
      projectId,
      message: "Vercel deployment handoff (manual import).",
      data: result
    });
    return result;
  }

  // Best-effort automated linkage. Vercel auto-deploys on push once the project
  // is linked to the GitHub repository.
  try {
    const response = await axios.post(
      "https://api.vercel.com/v10/projects",
      {
        name: project.repo_name,
        framework: "vite",
        gitRepository: {
          type: "github",
          repo: `${process.env.GITHUB_OWNER}/${project.repo_name}`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    const vercelUrl = response.data?.link?.production || response.data?.targets?.production?.url || null;
    await supabase
      .from("projects")
      .update({ vercel_url: vercelUrl, updated_at: new Date().toISOString() })
      .eq("id", projectId);

    const result = {
      status: "linked",
      message: "Vercel project created and linked to GitHub.",
      vercelUrl,
      raw: response.data
    };
    await logEvent({ projectId, message: "Vercel project linked.", data: result });
    return result;
  } catch (err) {
    const result = {
      status: "manual_required",
      message:
        "Vercel link failed automatically. Please import the GitHub repo manually in Vercel.",
      error: err?.response?.data || err?.message,
      repoName: project.repo_name,
      repoUrl: project.repo_url
    };
    await logEvent({
      projectId,
      level: "warn",
      message: "Vercel auto-link failed.",
      data: result
    });
    return result;
  }
}
