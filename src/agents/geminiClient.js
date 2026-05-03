import axios from "axios";

export async function askGemini({
  system,
  user,
  json = false
}) {
  if (!process.env.GOOGLE_GEMINI_API_KEY) {
    return json
      ? JSON.stringify({ summary: "Gemini not configured.", notes: [] })
      : "Gemini not configured.";
  }

  const model = process.env.GEMINI_ANALYZER_MODEL || "gemini-1.5-pro";

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_GEMINI_API_KEY}`,
    {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${system}\n\n${user}`
            }
          ]
        }
      ],
      generationConfig: json
        ? {
            responseMimeType: "application/json"
          }
        : undefined
    }
  );

  return response.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}
