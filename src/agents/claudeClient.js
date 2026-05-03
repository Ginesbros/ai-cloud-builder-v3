import axios from "axios";

export async function askClaude({
  system,
  user,
  json = false
}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json
      ? JSON.stringify({ summary: "Claude not configured.", notes: [] })
      : "Claude not configured.";
  }

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: process.env.CLAUDE_REVIEWER_MODEL || "claude-3-5-sonnet",
      max_tokens: 4000,
      system,
      messages: [
        {
          role: "user",
          content: user
        }
      ]
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      }
    }
  );

  const text = response.data.content?.[0]?.text || "";

  return text;
}
