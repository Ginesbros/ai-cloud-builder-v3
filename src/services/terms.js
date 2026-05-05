/**
 * Terms of Service service.
 * Reads the canonical legal/terms.md file at startup, exposes its version,
 * records acceptances in the tos_acceptances table, and provides a gate
 * function used by the project-creation route.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { supabase } from "../lib/supabase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMS_PATH = path.resolve(__dirname, "..", "..", "legal", "terms.md");

let cached = null;

function load() {
  if (cached) return cached;
  const raw = fs.readFileSync(TERMS_PATH, "utf8");
  // Pull "Version: x.y.z" from the doc.
  const versionMatch = raw.match(/\*\*Version:\*\*\s*([\d.]+)/i);
  const updatedMatch = raw.match(/\*\*Last updated:\*\*\s*([^\n]+)/i);
  cached = {
    version: versionMatch ? versionMatch[1].trim() : "1.0.0",
    lastUpdated: updatedMatch ? updatedMatch[1].trim() : null,
    markdown: raw
  };
  return cached;
}

export function getTerms() {
  return load();
}

export async function recordAcceptance({ userId, userEmail, ipAddress, userAgent }) {
  if (!userId) throw new Error("userId required");
  const terms = load();
  const { error } = await supabase.from("tos_acceptances").insert({
    user_id: userId,
    user_email: userEmail || null,
    terms_version: terms.version,
    ip_address: ipAddress || null,
    user_agent: userAgent || null
  });
  if (error) throw error;
  return { acceptedVersion: terms.version, acceptedAt: new Date().toISOString() };
}

/**
 * Has this user accepted the CURRENT version of the terms?
 * Returns: { accepted: bool, acceptedVersion, currentVersion }
 */
export async function hasAccepted(userId) {
  const terms = load();
  if (!userId) return { accepted: false, acceptedVersion: null, currentVersion: terms.version };

  const { data, error } = await supabase
    .from("tos_acceptances")
    .select("terms_version,accepted_at")
    .eq("user_id", userId)
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return { accepted: false, acceptedVersion: null, currentVersion: terms.version };

  return {
    accepted: data.terms_version === terms.version,
    acceptedVersion: data.terms_version,
    currentVersion: terms.version
  };
}

/**
 * Quick ban check.
 */
export async function isBanned(userId) {
  if (!userId) return { banned: false };
  const { data } = await supabase
    .from("banned_users")
    .select("reason,banned_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { banned: false };
  return { banned: true, reason: data.reason, bannedAt: data.banned_at };
}
