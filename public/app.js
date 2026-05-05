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

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...adminHeaders(),
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

/* --- Boot --- */
async function init() {
  // Optional: prompt for admin token if /debug routes are protected.
  const t = new URLSearchParams(location.search).get("token");
  if (t) {
    localStorage.setItem("acb_admin_token", t);
    history.replaceState({}, "", location.pathname);
  }

  await loadBudget();
  await loadProjects();

  // Auto-poll detail every 8s while watching a project.
  state.pollTimer = setInterval(() => {
    if (state.current && !document.hidden) {
      loadDetail();
      loadBudget();
    }
  }, 8000);
}

init();
