import axios from "axios";
import { supabase } from "../lib/supabase.js";
import { logEvent } from "../lib/logger.js";

function vercelHeaders() {
  return {
    Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
    "Content-Type": "application/json"
  };
}

function vercelTeamParam() {
  const team = process.env.VERCEL_TEAM_ID;
  return team ? `?teamId=${encodeURIComponent(team)}` : "";
}

/**
 * Trigger a Vercel preview deployment for the project's GitHub repo.
 * Vercel auto-creates preview URLs for the latest commit on `main` when the
 * project is linked. We just kick a redeploy + poll for the preview URL, and
 * enable deployment protection so the URL isn't public until you publish.
 */
export async function deployPreview(projectId) {
  if (!process.env.VERCEL_TOKEN) {
    return { ok: false, message: "VERCEL_TOKEN not configured." };
  }
  const { data: project } = await supabase.from("projects").select("*").eq("id", projectId).single();
  if (!project?.repo_name) throw new Error("Project has no GitHub repo yet.");

  const projectName = project.repo_name;
  const team = vercelTeamParam();

  // Ensure the Vercel project exists; ignore conflict if it already does.
  try {
    await axios.post(
      `https://api.vercel.com/v10/projects${team}`,
      {
        name: projectName,
        framework: "vite",
        gitRepository: { type: "github", repo: `${process.env.GITHUB_OWNER}/${projectName}` },
        ssoProtection: { deploymentType: "prod_deployment_urls_and_all_previews" }
      },
      { headers: vercelHeaders(), timeout: 30000 }
    );
  } catch (err) {
    if (err?.response?.status !== 409) {
      await logEvent({ projectId, level: "warn", message: "Vercel project create non-fatal warning.", data: { error: err?.response?.data || err.message } });
    }
  }

  // Trigger a preview deployment by creating one explicitly (target=preview).
  try {
    const response = await axios.post(
      `https://api.vercel.com/v13/deployments${team}`,
      {
        name: projectName,
        target: "preview",
        gitSource: {
          type: "github",
          repoId: undefined,
          ref: "main"
        },
        projectSettings: { framework: "vite" }
      },
      { headers: vercelHeaders(), timeout: 60000 }
    );

    const previewUrl = response.data?.url ? `https://${response.data.url}` : null;
    if (previewUrl) {
      await supabase.from("projects").update({
        preview_url: previewUrl,
        preview_expires_at: null,
        updated_at: new Date().toISOString()
      }).eq("id", projectId);
    }

    await logEvent({ projectId, message: "Preview deploy triggered.", data: { previewUrl } });
    return { ok: true, previewUrl, raw: response.data };
  } catch (err) {
    const detail = err?.response?.data || err?.message;
    await logEvent({ projectId, level: "error", message: "Preview deploy failed.", data: detail });
    return { ok: false, error: detail };
  }
}

/**
 * Promote the latest preview deployment to production.
 */
export async function publishToProduction(projectId) {
  if (!process.env.VERCEL_TOKEN) {
    return { ok: false, message: "VERCEL_TOKEN not configured." };
  }
  const { data: project } = await supabase.from("projects").select("*").eq("id", projectId).single();
  if (!project?.repo_name) throw new Error("Project has no repo to publish.");

  const team = vercelTeamParam();
  const projectName = project.repo_name;

  try {
    // Create a production deployment from the same `main` ref.
    const response = await axios.post(
      `https://api.vercel.com/v13/deployments${team}`,
      {
        name: projectName,
        target: "production",
        gitSource: { type: "github", ref: "main" },
        projectSettings: { framework: "vite" }
      },
      { headers: vercelHeaders(), timeout: 60000 }
    );

    const prodUrl = response.data?.url ? `https://${response.data.url}` : null;
    await supabase.from("projects").update({
      production_url: prodUrl,
      vercel_url: prodUrl,
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", projectId);

    await logEvent({ projectId, message: "Promoted preview to production.", data: { prodUrl } });
    return { ok: true, productionUrl: prodUrl };
  } catch (err) {
    const detail = err?.response?.data || err?.message;
    await logEvent({ projectId, level: "error", message: "Publish failed.", data: detail });
    return { ok: false, error: detail };
  }
}

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
