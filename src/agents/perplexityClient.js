import axios from "axios";
import { supabase } from "../lib/supabase.js";

export async function askPerplexity(prompt, { projectId = null, taskId = null } = {}) {
  if (!process.env.PERPLEXITY_API_KEY) {
    return "Perplexity not configured.";
  }

  const response = await axios.post(
    "https://api.perplexity.ai/chat/completions",
    {
      model: process.env.PERPLEXITY_MODEL || "sonar-pro",
      messages: [
        {
          role: "system",
          content: "Technical research agent. Be concise and implementation-focused."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  const flatCost = Number(process.env.COST_RESEARCH_FLAT_PER_CALL || 0.01);

  if (projectId) {
    await supabase.from("ai_usage").insert({
      project_id: projectId,
      task_id: taskId,
      role: "research",
      model: process.env.PERPLEXITY_MODEL || "sonar-pro",
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: flatCost
    }).catch(() => null);
  }

  return response.data.choices?.[0]?.message?.content || "";
}
