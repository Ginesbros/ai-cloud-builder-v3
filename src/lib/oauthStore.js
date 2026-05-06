/**
 * OAuth token store + auto-refresh.
 *
 * Higgsfield (and future OAuth providers) issues short-lived access tokens
 * and longer-lived refresh tokens. This module:
 *   - Loads the current token row from oauth_tokens.
 *   - Refreshes the access token automatically when it's near/past expiry.
 *   - Persists rotated tokens back to the DB.
 *   - Surfaces a "needs reauth" state when the refresh token has expired
 *     so the operator can run the device flow again.
 *
 * Concurrency: a 60-second skew window means we refresh slightly early
 * to avoid handing out tokens that are about to expire.
 */

import axios from "axios";
import { supabase } from "./supabase.js";

const SKEW_SECONDS = 60;

/**
 * Provider config — endpoints and refresh request shape.
 * To add another OAuth-protected service, append a new entry here.
 */
const PROVIDERS = {
  higgsfield: {
    refreshUrl: "https://fnf-device-auth.higgsfield.ai/refresh",
    deviceAuthUrl: "https://fnf-device-auth.higgsfield.ai/authorize",
    tokenUrl: "https://fnf-device-auth.higgsfield.ai/token",
    refreshBody: refreshToken => ({ refresh_token: refreshToken }),
    method: "POST",
    headers: { "Content-Type": "application/json" }
  }
};

async function loadRow(provider) {
  const { data, error } = await supabase
    .from("oauth_tokens")
    .select("*")
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(`oauth_tokens load failed: ${error.message}`);
  return data;
}

async function saveRow(provider, row) {
  const { error } = await supabase
    .from("oauth_tokens")
    .upsert({ provider, ...row, updated_at: new Date().toISOString() }, { onConflict: "provider" });
  if (error) throw new Error(`oauth_tokens save failed: ${error.message}`);
}

function expired(iso, skewSeconds = SKEW_SECONDS) {
  if (!iso) return true;
  const exp = new Date(iso).getTime();
  return Date.now() + skewSeconds * 1000 >= exp;
}

async function refreshAccess(provider, row) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);
  if (!row.refresh_token) {
    throw new Error(`No refresh token stored for ${provider}. Run the device-auth flow.`);
  }
  if (expired(row.refresh_expires_at, 0)) {
    throw new Error(`OAUTH_REAUTH_REQUIRED: ${provider} refresh token expired (was ${row.refresh_expires_at}).`);
  }

  const response = await axios({
    method: cfg.method,
    url: cfg.refreshUrl,
    headers: cfg.headers,
    data: cfg.refreshBody(row.refresh_token),
    timeout: 30000
  });

  const t = response.data;
  const now = Date.now();
  const accessExp = new Date(now + (t.expires_in || 3600) * 1000).toISOString();
  const refreshExp = t.refresh_expires_in
    ? new Date(now + t.refresh_expires_in * 1000).toISOString()
    : row.refresh_expires_at;

  const updated = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || row.refresh_token,
    token_type: t.token_type || row.token_type || "Bearer",
    access_expires_at: accessExp,
    refresh_expires_at: refreshExp,
    scope: t.scope || row.scope,
    metadata: row.metadata || {}
  };
  await saveRow(provider, updated);
  return updated;
}

/**
 * Get a valid access token for the provider. Auto-refreshes if expired.
 * Throws OAUTH_REAUTH_REQUIRED when the refresh token itself has expired.
 */
export async function getAccessToken(provider) {
  const row = await loadRow(provider);
  if (!row) {
    throw new Error(`OAUTH_NOT_CONFIGURED: no oauth_tokens row for ${provider}.`);
  }
  if (!expired(row.access_expires_at)) {
    return { token: row.access_token, tokenType: row.token_type || "Bearer", row };
  }
  const refreshed = await refreshAccess(provider, row);
  return { token: refreshed.access_token, tokenType: refreshed.token_type, row: refreshed };
}

/**
 * Status helper for diagnostics / dashboard.
 */
export async function getProviderStatus(provider) {
  const row = await loadRow(provider);
  if (!row) return { configured: false };
  return {
    configured: true,
    accessExpiresAt: row.access_expires_at,
    accessExpired: expired(row.access_expires_at),
    refreshExpiresAt: row.refresh_expires_at,
    refreshExpired: expired(row.refresh_expires_at, 0),
    needsReauth: expired(row.refresh_expires_at, 0)
  };
}

/**
 * Manually save a fresh token bundle (used by the re-auth API endpoint
 * after a successful device flow).
 */
export async function persistTokens(provider, tokens) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);
  const now = Date.now();
  const accessExp = new Date(now + (tokens.expires_in || 3600) * 1000).toISOString();
  const refreshExp = tokens.refresh_expires_in
    ? new Date(now + tokens.refresh_expires_in * 1000).toISOString()
    : null;

  await saveRow(provider, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type || "Bearer",
    access_expires_at: accessExp,
    refresh_expires_at: refreshExp,
    scope: tokens.scope || null,
    metadata: tokens.metadata || {}
  });
  return { accessExp, refreshExp };
}
