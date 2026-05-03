import axios from "axios";

export async function askGrok({
  system,
  user,
  json = false
}) {
  if (!process.env.XAI_API_KEY) {
    return json
      ? JSON.stringify({ summary: "Grok not configured.", notes: [] })
      : "Grok not configured.";
  }

  const response = await axios.post(
    "https://api.x.ai/v1/chat/completions",
    {
      model: process.env.GROK_REVIEWER_MODEL || "grok-2",
      messages: [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content: user
        }
      ],
      response_format: json
        ? {
            type: "json_object"
          }
        : undefined
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data.choices?.[0]?.message?.content || "";
}
