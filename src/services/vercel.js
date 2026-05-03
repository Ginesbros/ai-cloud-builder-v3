
import { supabase } from "../lib/supabase.js";
import { logEvent } from "../lib/logger.js";

export async function deployProjectToVercel(projectId) {
  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();

  if (error) throw error;

  if (!project.repo_url) {
    throw new Error("Project has no GitHub repo URL yet.");
  }

  const result = {
    status: "connect_repo_in_vercel",
    message: "Import this generated GitHub repo into Vercel once. Future pushes auto-deploy.",
    repoName: project.repo_name,
    repoUrl: project.repo_url
  };

  await logEvent({
    projectId,
    message: "Vercel deployment handoff created.",
    data: result
  });

  return result;
}
