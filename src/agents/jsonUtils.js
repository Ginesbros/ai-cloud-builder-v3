/**
 * Robust JSON extraction. Handles:
 *  - Plain JSON
 *  - JSON inside ```json ... ``` fences
 *  - Trailing/leading prose before/after the JSON object
 */
export function safeParseJson(raw, fallback = {}) {
  if (typeof raw !== "string" || !raw.trim()) return fallback;

  // Try direct parse first.
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  // Strip markdown code fences.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // continue
    }
  }

  // Find first { ... last } and try.
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = raw.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }

  return fallback;
}
