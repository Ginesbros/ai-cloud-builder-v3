/**
 * Supabase Storage helper — uploads non-code deliverables (PDFs, videos,
 * design kits, etc.) to the 'deliverables' bucket and records them in
 * the deliverables table for the dashboard.
 */

import { supabase } from "./supabase.js";

const BUCKET = "deliverables";

/**
 * Upload a buffer/string to storage and record it as a deliverable.
 *
 * Args:
 *   projectId, taskId       — context
 *   kind                    — 'pdf' | 'pptx' | 'xlsx' | 'docx' | 'video' | 'image' | 'zip' | 'audio' | 'report' | 'other'
 *   filename                — display name (e.g. 'logo.png', 'report.pdf')
 *   data                    — Buffer | string | Uint8Array
 *   mimeType                — optional, inferred from filename if missing
 *   generator               — agent name that produced it (e.g. 'designer', 'document', 'video')
 *   metadata                — any extra JSON
 *
 * Returns: { id, storagePath, signedUrl }
 */
export async function saveDeliverable({
  projectId,
  taskId = null,
  kind,
  filename,
  data,
  mimeType = null,
  generator = null,
  metadata = {}
}) {
  if (!projectId) throw new Error("saveDeliverable: projectId required");
  if (!filename) throw new Error("saveDeliverable: filename required");
  if (data == null) throw new Error("saveDeliverable: data required");

  // Path: <projectId>/<timestamp>-<filename>
  const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${projectId}/${Date.now()}-${safeName}`;

  // Normalize body to a Buffer for Node fetch.
  const body = data instanceof Buffer ? data
    : data instanceof Uint8Array ? Buffer.from(data)
    : typeof data === "string" ? Buffer.from(data, "utf8")
    : null;
  if (!body) throw new Error("saveDeliverable: unsupported data type");

  const finalMime = mimeType || guessMime(filename) || "application/octet-stream";

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, body, {
      contentType: finalMime,
      upsert: false
    });
  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

  // Signed URL valid for 7 days.
  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 7);
  if (signErr) throw new Error(`Signed URL failed: ${signErr.message}`);

  const { data: row, error: insErr } = await supabase
    .from("deliverables")
    .insert({
      project_id: projectId,
      task_id: taskId,
      kind,
      filename,
      storage_path: storagePath,
      size_bytes: body.length,
      mime_type: finalMime,
      generator,
      metadata
    })
    .select()
    .single();
  if (insErr) throw new Error(`Deliverables insert failed: ${insErr.message}`);

  return {
    id: row.id,
    storagePath,
    signedUrl: signed.signedUrl,
    sizeBytes: body.length
  };
}

/**
 * Get a fresh signed URL for an existing deliverable.
 */
export async function getDeliverableUrl(deliverableId) {
  const { data, error } = await supabase
    .from("deliverables")
    .select("storage_path,external_url")
    .eq("id", deliverableId)
    .maybeSingle();
  if (error || !data) return null;
  if (data.external_url) return data.external_url;
  if (!data.storage_path) return null;
  const { data: signed } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(data.storage_path, 60 * 60 * 24);
  return signed?.signedUrl || null;
}

function guessMime(filename) {
  const ext = String(filename).toLowerCase().split(".").pop();
  const map = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    zip: "application/zip",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    html: "text/html"
  };
  return map[ext] || null;
}
