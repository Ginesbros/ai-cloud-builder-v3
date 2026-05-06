/* AI Cloud Builder v3 — dashboard client */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  projects: [],
  current: null,
  detail: null,
  pollTimer: null
};

const fmtTime = iso => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
};

const fmtRel = iso => {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return Math.max(1, Math.round(diff / 1000)) + "s ago";
  if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago";
  return Math.round(diff / 86_400_000) + "d ago";
};

function adminHeaders() {
  const t = localStorage.getItem("acb_admin_token");
  return t ? { "x-admin-token": t } : {};
}

function getOrCreateUserId() {
  let id = localStorage.getItem("acb_user_id");
  if (!id) {
    // Cheap UUID v4-ish.
    id = "u_" + ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> (c / 4)).toString(16)
    );
    localStorage.setItem("acb_user_id", id);
  }
  return id;
}

function userHeaders() {
  return { "x-user-id": getOrCreateUserId() };
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...adminHeaders(),
      ...userHeaders(),
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

function toast(message, type = "info") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${type}`;
  setTimeout(() => el.classList.add("hidden"), 4000);
}

/* --- Budget pill --- */
async function loadBudget() {
  try {
    const data = await api("/api/budget");
    const spent = Number(data.monthlyEstimatedSpend || 0).toFixed(2);
    const total = data.config.monthlyBudget;
    $("#budget-pill").textContent = `Budget: $${spent} / $${total}`;
  } catch (err) {
    $("#budget-pill").textContent = "Budget: —";
  }
}

/* --- Projects list --- */
async function loadProjects() {
  try {
    const data = await api("/api/projects");
    state.projects = data.projects || [];
    renderProjects();
  } catch (err) {
    $("#project-list").innerHTML = `<li class="muted">${err.message}</li>`;
  }
}

function renderProjects() {
  const ul = $("#project-list");
  if (!state.projects.length) {
    ul.innerHTML = `<li class="muted">No projects yet.</li>`;
    return;
  }
  ul.innerHTML = state.projects
    .map(
      p => `
      <li data-id="${p.id}" class="${state.current === p.id ? "active" : ""}">
        <div class="p-name">${escapeHtml(p.name || "(unnamed)")}</div>
        <div class="p-meta">
          <span class="status-badge status-${p.status}">${p.status}</span>
          · ${fmtRel(p.updated_at)} · $${Number(p.estimated_spend_usd || 0).toFixed(2)}
        </div>
      </li>`
    )
    .join("");
  ul.querySelectorAll("li[data-id]").forEach(li => {
    li.addEventListener("click", () => selectProject(li.dataset.id));
  });
}

/* --- Project detail --- */
async function selectProject(id) {
  state.current = id;
  renderProjects();
  $("#empty-state").classList.add("hidden");
  $("#detail").classList.remove("hidden");
  await loadDetail();
}

async function loadDetail() {
  if (!state.current) return;
  try {
    const data = await api(`/api/projects/${state.current}`);
    state.detail = data;
    renderDetail();
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const p = d.project;

  $("#d-name").textContent = p.name || "(unnamed)";
  $("#d-goal").textContent = p.goal || "";

  const chips = [];
  chips.push(`<span class="chip ${statusChipClass(p.status)}">status: ${p.status}</span>`);
  if (p.kind) chips.push(`<span class="chip kind">kind: ${p.kind}</span>`);
  chips.push(`<span class="chip">autonomy: ${p.autonomy_mode}</span>`);
  if (p.repo_url) chips.push(`<span class="chip acc">repo: <a href="${p.repo_url}" target="_blank" rel="noopener">${p.repo_name}</a></span>`);
  if (p.vercel_url) chips.push(`<span class="chip acc">vercel: <a href="${p.vercel_url}" target="_blank" rel="noopener">live</a></span>`);
  chips.push(`<span class="chip">spend: $${Number(p.estimated_spend_usd || 0).toFixed(2)}</span>`);
  $("#d-meta").innerHTML = chips.join("");

  // Tasks
  $("#tasks-body").innerHTML = (d.tasks || [])
    .map(t => {
      const routing = (t.result && t.result.routing) || routingForType(t.type);
      const agent = routing.agent || "developer";
      const model = routing.model || "—";
      return `
      <tr>
        <td>${t.priority}</td>
        <td>
          <div style="font-weight:600">${escapeHtml(t.title)}</div>
          <div class="muted">${escapeHtml((t.description || "").slice(0, 200))}</div>
          ${t.error ? `<div class="muted" style="color:var(--error)">${escapeHtml(t.error)}</div>` : ""}
        </td>
        <td>${escapeHtml(t.type)}</td>
        <td>
          <span class="agent-badge ${agent}">${agent}</span>
          <span class="agent-model">${escapeHtml(model)}</span>
        </td>
        <td><span class="status-badge status-${t.status}">${t.status}</span></td>
        <td>${t.attempts}</td>
        <td>${fmtRel(t.updated_at)}</td>
      </tr>`;
    })
    .join("");

  // Clarification banner
  const banner = document.getElementById("clarification-banner");
  const qContainer = document.getElementById("clarification-questions");
  if (p.awaiting_clarification && Array.isArray(p.clarifications) && p.clarifications.length) {
    banner.classList.remove("hidden");
    qContainer.innerHTML = p.clarifications.map((q, i) => `
      <div class="clarification-q">
        <label>${escapeHtml(q.question)}</label>
        <input type="text" data-q-index="${i}" value="${escapeHtml(q.suggestedAnswer || "")}" placeholder="Type your answer">
        <div class="hint">${escapeHtml(q.why || "")}</div>
      </div>
    `).join("");
  } else {
    banner.classList.add("hidden");
    qContainer.innerHTML = "";
  }

  // Files
  $("#files-list").innerHTML = (d.files || [])
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(
      f => `
      <li>
        <span>${escapeHtml(f.path)}</span>
        <span class="file-meta">${f.sha ? f.sha.slice(0, 7) : "—"} · ${fmtRel(f.updated_at)}</span>
      </li>`
    )
    .join("") || `<li class="muted">No files yet.</li>`;

  // Deliverables
  $("#deliverables-list").innerHTML = (d.deliverables || []).map(dv => `
    <li>
      <div>
        <div><span class="d-kind">${escapeHtml(dv.kind)}</span><span class="d-name">${escapeHtml(dv.filename)}</span></div>
        <div class="d-meta">${escapeHtml(dv.generator || "—")} · ${formatBytes(dv.size_bytes)} · ${fmtRel(dv.created_at)}</div>
      </div>
      <a class="btn tiny" href="/api/deliverables/${dv.id}/download" target="_blank" rel="noopener">Download</a>
    </li>`).join("") || `<li class="muted">No deliverables yet.</li>`;

  // Assets
  $("#assets-grid").innerHTML = (d.assets || []).map(a => {
    const isImage = a.type === "image";
    const thumb = isImage
      ? `<img class="asset-thumb" src="/api/assets/${a.id}" alt="${escapeHtml(a.filename)}" />`
      : `<div class="video-pill">▶  ${escapeHtml(a.type.toUpperCase())}</div>`;
    return `
      <div class="asset-card">
        ${thumb}
        <div class="asset-meta">
          <div class="asset-name">${escapeHtml(a.filename)}</div>
          <div>${escapeHtml(a.generator || "—")} · ${fmtRel(a.created_at)}</div>
        </div>
      </div>`;
  }).join("") || `<div class="muted">No assets generated yet.</div>`;

  // Logs
  $("#logs-stream").innerHTML = (d.logs || [])
    .map(
      l => `
      <div class="log-line">
        <div class="log-time">${fmtTime(l.created_at)}</div>
        <div class="log-level ${l.level}">${l.level}</div>
        <div>${escapeHtml(l.message || "")}${l.data ? `<div class="muted">${escapeHtml(JSON.stringify(l.data).slice(0, 400))}</div>` : ""}</div>
      </div>`
    )
    .join("") || `<div class="muted">No logs yet.</div>`;

  // Sandbox runs
  $("#sandbox-runs").innerHTML = (d.sandboxRuns || [])
    .map(
      r => `
      <div class="sandbox-card">
        <div><span class="cmd">$ ${escapeHtml(r.command)}</span>
          <span class="status-badge status-${r.status === "passed" ? "complete" : "failed"}" style="margin-left:8px">${r.status}</span>
          <span class="muted" style="margin-left:8px">${r.duration_ms}ms · exit ${r.exit_code}</span>
        </div>
        ${r.stderr ? `<pre>${escapeHtml(r.stderr.slice(-2000))}</pre>` : ""}
        ${!r.stderr && r.stdout ? `<pre>${escapeHtml(r.stdout.slice(-2000))}</pre>` : ""}
      </div>`
    )
    .join("") || `<div class="muted">No sandbox runs yet.</div>`;

  // Spend
  const cfg = d.budget?.config || {};
  const spent = Number(d.budget?.monthlySpend || 0);
  const projectSpent = Number(p.estimated_spend_usd || 0);
  const pct = cfg.monthlyBudget ? Math.min(100, (spent / cfg.monthlyBudget) * 100) : 0;
  $("#spend-grid").innerHTML = `
    <div class="spend-card">
      <div class="label">This project</div>
      <div class="value">$${projectSpent.toFixed(2)}</div>
    </div>
    <div class="spend-card">
      <div class="label">Monthly total</div>
      <div class="value">$${spent.toFixed(2)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="muted" style="margin-top:6px">of $${cfg.monthlyBudget || 0} (${cfg.mode || "—"})</div>
    </div>
    <div class="spend-card">
      <div class="label">Soft / hard limits</div>
      <div class="value" style="font-size:14px">$${(cfg.softLimit || 0).toFixed(0)} / $${(cfg.hardLimit || 0).toFixed(0)}</div>
    </div>
  `;
}

// Best-effort routing fallback when a task hasn't run yet (no .result.routing).
function routingForType(type) {
  const t = (type || "development").toLowerCase();
  if (t === "design" || t === "assets" || t === "image") return { agent: "designer", model: "nano-banana" };
  if (t === "video") return { agent: "videographer", model: "higgsfield" };
  if (t === "specialist" || t === "long_running") return { agent: "specialist", model: "manus" };
  if (t === "docs") return { agent: "librarian", model: "notebooklm" };
  if (t === "backend" || t === "database" || t === "integration") return { agent: "developer", model: "gpt-4.1" };
  if (t === "review") return { agent: "reviewer", model: "claude+gemini+grok" };
  return { agent: "developer", model: "gpt-4.1-mini" };
}

function formatBytes(n) {
  if (!n) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function statusChipClass(status) {
  if (["complete"].includes(status)) return "ok";
  if (["failed", "error"].includes(status)) return "err";
  if (["planning", "planned", "building"].includes(status)) return "acc";
  return "";
}

/* --- Tabs --- */
$$(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach(b => b.classList.toggle("active", b === btn));
    const target = btn.dataset.tab;
    $$(".tab-panel").forEach(p => {
      p.classList.toggle("hidden", p.dataset.panel !== target);
    });
  });
});

/* --- Actions --- */
$("#create-form").addEventListener("submit", async e => {
  e.preventDefault();
  const goal = $("#goal").value.trim();
  const name = $("#name").value.trim();
  const autonomyMode = $("#autonomy").value;
  if (goal.length < 10) {
    toast("Goal must be at least 10 characters.", "error");
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = "Planning…";
  try {
    const data = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ goal, name: name || undefined, autonomyMode })
    });
    toast(`Created with ${data.tasksCreated} tasks.`, "success");
    $("#goal").value = "";
    $("#name").value = "";
    await loadProjects();
    if (data.project?.id) await selectProject(data.project.id);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create + Plan";
  }
});

$("#btn-run-next").addEventListener("click", async () => {
  if (!state.current) return;
  toast("Running next task…");
  try {
    await api(`/api/projects/${state.current}/run-next`, { method: "POST" });
    toast("Task complete.", "success");
    await Promise.all([loadDetail(), loadProjects(), loadBudget()]);
  } catch (err) {
    toast(err.message, "error");
    loadDetail();
  }
});

$("#btn-run-auto").addEventListener("click", async () => {
  if (!state.current) return;
  if (!confirm("Run all remaining tasks autonomously? This may take several minutes and consume budget.")) return;
  toast("Running autonomous build…");
  try {
    await api(`/api/projects/${state.current}/run-autonomous`, { method: "POST" });
    toast("Autonomous run complete.", "success");
    await Promise.all([loadDetail(), loadProjects(), loadBudget()]);
  } catch (err) {
    toast(err.message, "error");
    loadDetail();
  }
});

$("#btn-deploy").addEventListener("click", async () => {
  if (!state.current) return;
  try {
    const data = await api(`/api/projects/${state.current}/deploy`, { method: "POST" });
    toast(data.result?.message || "Deploy handoff created.", "success");
    await loadDetail();
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#submit-clarifications").addEventListener("click", async () => {
  if (!state.current) return;
  const inputs = $$("#clarification-questions input[data-q-index]");
  const answers = inputs.map(el => el.value || "");
  if (answers.some(a => !a.trim())) {
    toast("Please answer every question.", "error");
    return;
  }
  try {
    await api(`/api/projects/${state.current}/clarifications`, {
      method: "POST",
      body: JSON.stringify({ answers })
    });
    toast("Plan generated. Ready to build.", "success");
    await Promise.all([loadDetail(), loadProjects()]);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#refresh-btn").addEventListener("click", async () => {
  await Promise.all([loadProjects(), loadBudget(), loadDetail()]);
});
$("#reload-projects").addEventListener("click", loadProjects);

/* --- Helpers --- */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/* --- Terms of Service flow --- */
async function checkTermsAndShowModal() {
  try {
    const status = await api("/api/terms/status");
    document.getElementById("tos-version").textContent = status.currentVersion || "1.0.0";
    if (status.banned) {
      // Banned users see a hard message and can't dismiss.
      const modal = document.getElementById("tos-modal");
      modal.classList.remove("hidden");
      document.getElementById("tos-content").textContent =
        "Your access to the Service has been terminated." +
        (status.banReason ? `\n\nReason: ${status.banReason}` : "");
      document.querySelector(".tos-check").style.display = "none";
      document.getElementById("tos-accept").style.display = "none";
      return false;
    }
    if (!status.accepted) {
      await openTosModal({ requireAcceptance: true });
      return false;
    }
    return true;
  } catch (err) {
    console.error("Terms status check failed:", err);
    return false;
  }
}

async function openTosModal({ requireAcceptance = false } = {}) {
  const modal = document.getElementById("tos-modal");
  const content = document.getElementById("tos-content");
  const checkBox = document.getElementById("tos-check");
  const acceptBtn = document.getElementById("tos-accept");

  modal.classList.remove("hidden");
  content.textContent = "Loading…";

  try {
    const t = await api("/api/terms");
    content.textContent = t.markdown;
    document.getElementById("tos-version").textContent = t.version;
  } catch (err) {
    content.textContent = `Could not load terms: ${err.message}`;
  }

  // Reset state.
  checkBox.checked = false;
  acceptBtn.disabled = true;
  checkBox.onchange = () => { acceptBtn.disabled = !checkBox.checked; };

  acceptBtn.onclick = async () => {
    acceptBtn.disabled = true;
    acceptBtn.textContent = "Saving…";
    try {
      await api("/api/terms/accept", { method: "POST", body: JSON.stringify({}) });
      modal.classList.add("hidden");
      toast("Terms accepted. Welcome.", "success");
      // After accepting, kick off the regular boot.
      bootAfterTerms();
    } catch (err) {
      toast(err.message, "error");
      acceptBtn.disabled = false;
      acceptBtn.textContent = "Accept & Continue";
    }
  };

  if (!requireAcceptance) {
    // "View terms" mode — user can close without re-accepting.
    acceptBtn.textContent = "Close";
    acceptBtn.disabled = false;
    checkBox.parentElement.style.display = "none";
    acceptBtn.onclick = () => {
      modal.classList.add("hidden");
      checkBox.parentElement.style.display = "";
      acceptBtn.textContent = "Accept & Continue";
    };
  } else {
    checkBox.parentElement.style.display = "";
    acceptBtn.textContent = "Accept & Continue";
  }
}

/* --- Connections panel + Higgsfield re-auth --- */
const hfState = { deviceCode: null, expiresAt: 0 };

async function openConnections() {
  const modal = document.getElementById("connections-modal");
  const cards = document.getElementById("connection-cards");
  modal.classList.remove("hidden");
  cards.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    const [hfStatus, manusStatus] = await Promise.all([
      api("/api/oauth/higgsfield/status").catch(e => ({ error: e.message })),
      api("/api/connections/manus/status").catch(e => ({ error: e.message }))
    ]);
    cards.innerHTML = renderHiggsfieldCard(hfStatus) + renderManusCard(manusStatus);
    document.getElementById("hf-reauth-btn")?.addEventListener("click", openHiggsfieldAuth);
  } catch (err) {
    cards.innerHTML = `<div class="muted">Failed: ${escapeHtml(err.message)}</div>`;
  }
}

function renderManusCard(s) {
  let line, klass;
  if (s.error) {
    line = `Status check failed: ${s.error}`;
    klass = "err";
  } else if (!s.configured) {
    line = "Not configured — set MANUS_API_KEY in Render env vars.";
    klass = "muted";
  } else if (s.ok) {
    line = "Connected. Specialist tasks ready.";
    klass = "ok";
  } else {
    line = `Configured but check failed (status ${s.status || "?"}). Token may be invalid.`;
    klass = "err";
  }
  return `
    <div class="connection-card">
      <div>
        <div class="c-name">Manus (specialist)</div>
        <div class="c-status ${klass}">${escapeHtml(line)}</div>
        <div class="c-meta">Static API key auth. Generate at <a href="https://manus.ai" target="_blank" rel="noopener">manus.ai</a> → API settings.</div>
      </div>
      <span class="muted" style="font-size:11px">Set via env</span>
    </div>
  `;
}

function renderHiggsfieldCard(s) {
  let statusLine, statusClass, btnLabel;
  if (!s.configured) {
    statusLine = "Not configured — video pipeline disabled.";
    statusClass = "muted";
    btnLabel = "Authorize Higgsfield";
  } else if (s.needsReauth) {
    statusLine = `Refresh token expired ${fmtRel(s.refreshExpiresAt)} — re-authorize required.`;
    statusClass = "err";
    btnLabel = "Re-authorize";
  } else if (s.accessExpired) {
    statusLine = "Access token expired — will auto-refresh on next use.";
    statusClass = "warn";
    btnLabel = "Re-authorize";
  } else {
    statusLine = `Connected. Refresh expires ${fmtRel(s.refreshExpiresAt)}.`;
    statusClass = "ok";
    btnLabel = "Re-authorize";
  }
  return `
    <div class="connection-card">
      <div>
        <div class="c-name">Higgsfield (video)</div>
        <div class="c-status ${statusClass}">${escapeHtml(statusLine)}</div>
        ${s.accessExpiresAt ? `<div class="c-meta">Access: expires ${fmtRel(s.accessExpiresAt)}</div>` : ""}
      </div>
      <button class="btn" id="hf-reauth-btn">${btnLabel}</button>
    </div>
  `;
}

function openHiggsfieldAuth() {
  document.getElementById("connections-modal").classList.add("hidden");
  document.getElementById("higgsfield-auth-modal").classList.remove("hidden");
  document.getElementById("hf-step1").classList.remove("hidden");
  document.getElementById("hf-step2").classList.add("hidden");
  document.getElementById("hf-step3").classList.add("hidden");
}

async function startHiggsfieldFlow() {
  const startBtn = document.getElementById("hf-start");
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";
  try {
    const r = await api("/api/oauth/higgsfield/authorize", { method: "POST", body: "{}" });
    hfState.deviceCode = r.device_code;
    hfState.expiresAt = Date.now() + (r.expires_in || 900) * 1000;
    document.getElementById("hf-verify-link").href = r.verification_uri;
    document.getElementById("hf-verify-link").textContent = r.verification_uri;
    const mins = Math.round((r.expires_in || 900) / 60);
    document.getElementById("hf-expiry").textContent = `Code expires in ~${mins} minutes.`;
    document.getElementById("hf-step1").classList.add("hidden");
    document.getElementById("hf-step2").classList.remove("hidden");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Start authorization";
  }
}

async function claimHiggsfieldTokens() {
  if (!hfState.deviceCode) return;
  if (Date.now() > hfState.expiresAt) {
    toast("Authorization code expired — starting fresh.", "error");
    document.getElementById("hf-step1").classList.remove("hidden");
    document.getElementById("hf-step2").classList.add("hidden");
    return;
  }
  const claimBtn = document.getElementById("hf-claim");
  claimBtn.disabled = true;
  claimBtn.textContent = "Fetching tokens…";
  try {
    const r = await api("/api/oauth/higgsfield/poll", {
      method: "POST",
      body: JSON.stringify({ device_code: hfState.deviceCode })
    });
    if (r.ok) {
      document.getElementById("hf-step2").classList.add("hidden");
      document.getElementById("hf-step3").classList.remove("hidden");
      toast("Higgsfield connected.", "success");
    } else {
      const detail = r.detail || "unknown";
      if (detail === "authorization_pending") {
        toast("Still pending — click Approve on Higgsfield first, then try again.", "error");
      } else {
        toast(`Failed: ${detail}`, "error");
      }
    }
  } catch (err) {
    toast(err.message, "error");
  } finally {
    claimBtn.disabled = false;
    claimBtn.textContent = "I approved — fetch tokens";
  }
}

/* --- Library tab --- */
async function loadLibrary() {
  const ul = document.getElementById("library-list");
  if (!ul) return;
  const q = document.getElementById("library-search").value.trim();
  const kind = document.getElementById("library-kind").value.trim();
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (kind) params.set("kind", kind);
  ul.innerHTML = `<li class="muted">Loading…</li>`;
  try {
    const data = await api("/api/library?" + params.toString());
    const items = data.components || [];
    if (!items.length) {
      ul.innerHTML = `<li class="muted">No saved components yet. They appear here as builds finish.</li>`;
      return;
    }
    ul.innerHTML = items.map(c => `
      <li>
        <div>
          <div class="l-name">${escapeHtml(c.name)} ${c.pinned ? '<span class="l-pin">★ pinned</span>' : ""}</div>
          <div class="l-desc">${escapeHtml(c.description)}</div>
          <div class="l-tags">
            <span class="l-tag">${escapeHtml(c.kind)}</span>
            ${(c.tags || []).map(t => `<span class="l-tag">${escapeHtml(t)}</span>`).join("")}
          </div>
        </div>
        <div class="l-meta">
          ${c.reuse_count} reuse${c.reuse_count === 1 ? "" : "s"}<br>
          ${fmtRel(c.created_at)}
        </div>
      </li>
    `).join("");
  } catch (err) {
    ul.innerHTML = `<li class="muted">Library failed: ${escapeHtml(err.message)}</li>`;
  }
}

async function loadLibraryKinds() {
  try {
    const data = await api("/api/kinds");
    const select = document.getElementById("library-kind");
    for (const k of data.kinds || []) {
      const opt = document.createElement("option");
      opt.value = k; opt.textContent = k;
      select.appendChild(opt);
    }
  } catch {}
}

/* --- Boot --- */
async function bootAfterTerms() {
  await loadBudget();
  await loadProjects();

  state.pollTimer = setInterval(() => {
    if (state.current && !document.hidden) {
      loadDetail();
      loadBudget();
    }
  }, 8000);
}

async function init() {
  // Optional: prompt for admin token if /debug routes are protected.
  const t = new URLSearchParams(location.search).get("token");
  if (t) {
    localStorage.setItem("acb_admin_token", t);
    history.replaceState({}, "", location.pathname);
  }

  await loadLibraryKinds();

  // Wire footer + library tab listeners (always available).
  document.getElementById("open-tos").addEventListener("click", e => {
    e.preventDefault();
    openTosModal({ requireAcceptance: false });
  });
  const lsearch = document.getElementById("library-search");
  const lkind = document.getElementById("library-kind");
  if (lsearch) lsearch.addEventListener("input", debounce(loadLibrary, 350));
  if (lkind) lkind.addEventListener("change", loadLibrary);

  // Tab switch to library should load it (lazy).
  document.querySelectorAll(".tab[data-tab='library']").forEach(btn => {
    btn.addEventListener("click", loadLibrary);
  });

  // Connections modal wiring.
  document.getElementById("open-connections").addEventListener("click", openConnections);
  document.getElementById("close-connections").addEventListener("click", () => {
    document.getElementById("connections-modal").classList.add("hidden");
  });
  document.getElementById("hf-start").addEventListener("click", startHiggsfieldFlow);
  document.getElementById("hf-claim").addEventListener("click", claimHiggsfieldTokens);
  document.getElementById("hf-close").addEventListener("click", () => {
    document.getElementById("higgsfield-auth-modal").classList.add("hidden");
  });

  // Gate everything else on terms acceptance.
  const accepted = await checkTermsAndShowModal();
  if (accepted) {
    bootAfterTerms();
  }
}

function debounce(fn, ms) {
  let h;
  return (...args) => { clearTimeout(h); h = setTimeout(() => fn(...args), ms); };
}

init();
