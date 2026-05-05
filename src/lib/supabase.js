import { createClient } from "@supabase/supabase-js";
import WebSocketImpl from "ws";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables.");
}

if (process.env.SUPABASE_URL.includes("/rest/v1")) {
  throw new Error(
    "SUPABASE_URL must be the base project URL only (no /rest/v1/ suffix)."
  );
}

// Provide a WebSocket implementation for Realtime so this works on
// Node < 22 (which lacks a native WebSocket global).
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
    realtime: {
      transport: WebSocketImpl
    }
  }
);
