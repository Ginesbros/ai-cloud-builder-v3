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
  // Errors are sticky until the user dismisses them; info/success auto-hide.
  el.innerHTML = type === "error"
    ? `${escapeHtml(String(message))} <span style="opacity:.6;cursor:pointer;margin-left:8px" onclick="this.parentElement.classList.add('hidden')">✕</span>`
    : escapeHtml(String(message));
  el.className = `toast ${type}`;
  if (type !== "error") setTimeout(() => el.classList.add("hidden"), 4000);
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
    .map(p => {
      const cost = Number(p.estimated_spend_usd || 0);
      const costStr = cost === 0 ? "$0" : (cost < 0.01 ? "<$0.01" : cost < 1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`);
      return `
      <li data-id="${p.id}" class="${state.current === p.id ? "active" : ""}">
        <div class="p-name">${escapeHtml(p.name || "(unnamed)")}</div>
        <div class="p-meta">
          <span class="status-badge status-${p.status}">${p.status}</span>
          · ${fmtRel(p.updated_at)} · <span style="color: var(--accent); font-weight: 600">${costStr}</span>
        </div>
      </li>`;
    })
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
  const spendValue = Number(p.estimated_spend_usd || 0);
  const spendStr = spendValue < 0.01 && spendValue > 0 ? "$0.00<" : `$${spendValue.toFixed(spendValue < 1 ? 4 : 2)}`;
  chips.push(`<span class="chip" style="background: rgba(47,212,194,0.10); color: var(--accent); border-color: rgba(47,212,194,0.3)">cost: ${spendStr}</span>`);
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

  // Estimate banner — shown when project has cost_estimate AND has not started yet (or just before run)
  const estBanner = document.getElementById("estimate-banner");
  const est = p.cost_estimate;
  if (est && p.status !== "complete" && p.status !== "failed") {
    document.getElementById("estimate-value").textContent = `$${Number(est.expected || 0).toFixed(2)}`;
    document.getElementById("estimate-range").textContent =
      `Range: $${Number(est.low || 0).toFixed(2)} – $${Number(est.high || 0).toFixed(2)} · confidence ${Math.round((est.confidence || 0) * 100)}%`;
    const methodLabel =
      est.method === "historical" ? `Based on ${(est.comparables || []).length} similar past build(s)`
      : est.method === "llm" ? "LLM-projected (no comparables yet)"
      : "Fallback estimate";
    document.getElementById("estimate-method").textContent = methodLabel;

    const compEl = document.getElementById("estimate-comparables");
    if ((est.comparables || []).length > 0) {
      compEl.innerHTML = `Similar past builds:<ul>${
        est.comparables.map(c => `<li>${escapeHtml(c.name)} — $${Number(c.cost).toFixed(2)} (${Math.round(c.similarity * 100)}% match)</li>`).join("")
      }</ul>`;
    } else if (est.reasoning) {
      compEl.innerHTML = `<em>${escapeHtml(est.reasoning)}</em>`;
    } else {
      compEl.innerHTML = "";
    }
    estBanner.classList.remove("hidden");
  } else {
    estBanner.classList.add("hidden");
  }

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

  // Approval banner — shown when plan is ready but not yet approved
  const approvalBanner = document.getElementById("approval-banner");
  if ((p.awaiting_approval || p.status === "awaiting_approval") && !p.awaiting_clarification) {
    approvalBanner.classList.remove("hidden");
    document.getElementById("approval-revision").textContent =
      p.plan_revision && p.plan_revision > 1 ? `revision ${p.plan_revision}` : "";
  } else {
    approvalBanner.classList.add("hidden");
    document.getElementById("refine-form")?.classList.add("hidden");
  }

  // Disable run buttons while awaiting approval
  const awaitingApproval = !!(p.awaiting_approval || p.status === "awaiting_approval");
  document.getElementById("btn-run-next").disabled = awaitingApproval;
  document.getElementById("btn-run-auto").disabled = awaitingApproval;

  // Preview panel — shown once a preview URL exists
  const previewPanel = document.getElementById("preview-panel");
  if (p.preview_url || p.production_url) {
    previewPanel.classList.remove("hidden");
    const url = p.preview_url || p.production_url;
    document.getElementById("preview-frame").src = url;
    document.getElementById("preview-open").href = url;
    const pubLine = document.getElementById("published-line");
    if (p.production_url) {
      pubLine.innerHTML = `Published → <a href="${p.production_url}" target="_blank" rel="noopener">${p.production_url}</a>`;
    } else {
      pubLine.textContent = "Preview only — click Publish to push to production.";
    }
  } else {
    previewPanel.classList.add("hidden");
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

  // Per-role breakdown for THIS project
  const usage = d.aiUsage || [];
  const byRole = {};
  let calls = 0;
  for (const u of usage) {
    const role = u.role || "unknown";
    if (!byRole[role]) byRole[role] = { cost: 0, calls: 0, tokensIn: 0, tokensOut: 0, model: u.model };
    byRole[role].cost += Number(u.estimated_cost_usd || 0);
    byRole[role].calls += 1;
    byRole[role].tokensIn += Number(u.input_tokens || 0);
    byRole[role].tokensOut += Number(u.output_tokens || 0);
    calls += 1;
  }
  const roleRows = Object.entries(byRole)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([role, info]) => `
      <tr>
        <td><span class="agent-badge ${role}">${escapeHtml(role)}</span></td>
        <td class="muted" style="font-family: ui-monospace,monospace; font-size:11px">${escapeHtml(info.model || "—")}</td>
        <td>${info.calls}</td>
        <td>${(info.tokensIn + info.tokensOut).toLocaleString()}</td>
        <td style="font-weight:600">$${info.cost.toFixed(4)}</td>
      </tr>
    `).join("");

  $("#spend-grid").innerHTML = `
    <div class="spend-card" style="grid-column: span 2; background: linear-gradient(135deg, rgba(47,212,194,0.10), rgba(79,140,255,0.08));">
      <div class="label">This project total</div>
      <div class="value" style="font-size:32px">$${projectSpent.toFixed(4)}</div>
      <div class="muted" style="margin-top:6px">${calls} AI call${calls === 1 ? "" : "s"} across ${Object.keys(byRole).length} role${Object.keys(byRole).length === 1 ? "" : "s"}</div>
    </div>
    <div class="spend-card">
      <div class="label">Monthly total (all projects)</div>
      <div class="value">$${spent.toFixed(2)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="muted" style="margin-top:6px">of $${cfg.monthlyBudget || 0} (${cfg.mode || "—"})</div>
    </div>
    <div class="spend-card">
      <div class="label">Soft / hard limits</div>
      <div class="value" style="font-size:14px">$${(cfg.softLimit || 0).toFixed(0)} / $${(cfg.hardLimit || 0).toFixed(0)}</div>
    </div>
  `;

  // Per-role breakdown table BELOW the cards.
  if (roleRows) {
    $("#spend-grid").insertAdjacentHTML("beforeend", `
      <div style="grid-column: 1 / -1; margin-top: 16px;">
        <h2 style="margin-bottom:10px">Cost breakdown by role</h2>
        <table class="data-table">
          <thead><tr><th>Role</th><th>Model</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead>
          <tbody>${roleRows}</tbody>
        </table>
      </div>
    `);
  }
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

$("#refresh-estimate").addEventListener("click", async () => {
  if (!state.current) return;
  const btn = document.getElementById("refresh-estimate");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await api(`/api/projects/${state.current}/estimate`, { method: "POST", body: "{}" });
    await loadDetail();
    toast("Estimate refreshed.", "success");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
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

/* --- Self-improvement inbox --- */
async function loadImprovements() {
  const ul = document.getElementById("improvement-list");
  if (!ul) return;
  ul.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const data = await api("/api/improvements");
    const items = data.items || [];
    if (items.length === 0) {
      ul.innerHTML = '<li class="muted">No ideas yet. File one above.</li>';
      return;
    }
    ul.innerHTML = items.map(i => {
      const statusColor = ({
        queued: "#94a3b8", planning: "#4f8cff", building: "#4f8cff", reviewing: "#4f8cff",
        pr_open: "#34d399", merged: "#34d399", failed: "#f87171", skipped: "#fbbf24", rejected: "#94a3b8"
      })[i.status] || "#94a3b8";
      const actions = [];
      if (i.status === "queued") {
        actions.push(`<button class="btn tiny primary" data-act="process" data-id="${i.id}">Build PR</button>`);
        actions.push(`<button class="btn tiny ghost" data-act="reject" data-id="${i.id}">Reject</button>`);
      }
      if (i.pr_url) actions.push(`<a class="btn tiny" href="${i.pr_url}" target="_blank" rel="noopener">View PR</a>`);
      return `
        <li class="improvement-item" style="border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px; margin-bottom:8px; background:rgba(0,0,0,0.2);">
          <div style="display:flex; justify-content:space-between; align-items:start; gap:10px; flex-wrap:wrap;">
            <div style="flex:1; min-width:0;">
              <div style="font-weight:600;">${escapeHtml(i.title)}</div>
              <div class="muted" style="font-size:12px; margin-top:2px;">
                ${escapeHtml(i.scope || "small")} · source: ${escapeHtml(i.source)} · ${fmtRel(i.created_at)}
              </div>
              ${i.description ? `<div class="muted" style="font-size:12px; margin-top:4px;">${escapeHtml(i.description.slice(0, 240))}</div>` : ""}
              ${i.error ? `<div style="color:#f87171; font-size:12px; margin-top:4px;">${escapeHtml(i.error)}</div>` : ""}
              ${i.forbidden_violation ? `<div style="color:#fbbf24; font-size:12px; margin-top:4px;">🚫 ${escapeHtml(i.forbidden_violation)}</div>` : ""}
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
              <span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; background:${statusColor}22; color:${statusColor}; border:1px solid ${statusColor}55;">${i.status}</span>
              <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end;">${actions.join("")}</div>
            </div>
          </div>
        </li>`;
    }).join("");
    // Wire action buttons
    ul.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        if (act === "process") {
          if (!confirm("Build a PR for this idea? Costs ~$1–$5 in model credits.")) return;
          btn.disabled = true; btn.textContent = "Building…";
          try {
            const r = await api(`/api/improvements/${id}/process`, { method: "POST" });
            const url = r.result?.result?.prUrl || r.result?.prUrl;
            toast(url ? `PR opened: ${url}` : (r.result?.error || "Done."), url ? "success" : "error");
            await loadImprovements();
          } catch (err) { toast(err.message, "error"); btn.disabled = false; btn.textContent = "Build PR"; }
        } else if (act === "reject") {
          const reason = prompt("Why reject this idea? (optional)") || "rejected by user";
          try {
            await api(`/api/improvements/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
            await loadImprovements();
          } catch (err) { toast(err.message, "error"); }
        }
      });
    });
  } catch (err) {
    ul.innerHTML = `<li class="muted" style="color:var(--error)">Failed to load: ${escapeHtml(err.message)}</li>`;
  }
}

document.addEventListener("click", e => {
  if (e.target?.matches(".tab[data-tab='improve']")) loadImprovements();
});

document.getElementById("si-submit")?.addEventListener("click", async () => {
  const title = document.getElementById("si-title").value.trim();
  const description = document.getElementById("si-desc").value.trim();
  const scope = document.getElementById("si-scope").value;
  if (!title || title.length < 4) { toast("Title too short.", "error"); return; }
  try {
    await api("/api/improvements", { method: "POST", body: JSON.stringify({ title, description, scope }) });
    document.getElementById("si-title").value = "";
    document.getElementById("si-desc").value = "";
    toast("Idea queued.", "success");
    await loadImprovements();
  } catch (err) { toast(err.message, "error"); }
});

document.getElementById("si-refresh")?.addEventListener("click", loadImprovements);

document.getElementById("si-scan-logs")?.addEventListener("click", async () => {
  toast("Scanning logs…");
  try {
    const r = await api("/api/improvements/scan-logs", { method: "POST", body: JSON.stringify({ hours: 24, minOccurrences: 3 }) });
    toast(`Filed ${r.result?.filed || 0} idea(s) from ${r.result?.scanned || 0} log entries.`, "success");
    await loadImprovements();
  } catch (err) { toast(err.message, "error"); }
});

/* --- Plan approval / refinement --- */
$("#btn-approve-plan")?.addEventListener("click", async () => {
  if (!state.current) return;
  if (!confirm("Approve the plan and start the paid build?")) return;
  try {
    await api(`/api/projects/${state.current}/approve`, { method: "POST" });
    toast("Plan approved — ready to build.", "success");
    await Promise.all([loadDetail(), loadProjects()]);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#btn-toggle-refine")?.addEventListener("click", () => {
  document.getElementById("refine-form").classList.toggle("hidden");
});

$("#btn-submit-refine")?.addEventListener("click", async () => {
  if (!state.current) return;
  const notes = document.getElementById("refine-notes").value.trim();
  if (!notes) {
    toast("Add a note describing what should change.", "error");
    return;
  }
  toast("Re-running planner with your notes…");
  try {
    await api(`/api/projects/${state.current}/refine`, {
      method: "POST",
      body: JSON.stringify({ notes })
    });
    document.getElementById("refine-notes").value = "";
    document.getElementById("refine-form").classList.add("hidden");
    toast("New plan ready — review and approve.", "success");
    await Promise.all([loadDetail(), loadProjects()]);
  } catch (err) {
    toast(err.message, "error");
  }
});

/* --- Preview / publish --- */
$("#btn-redeploy-preview")?.addEventListener("click", async () => {
  if (!state.current) return;
  toast("Triggering preview deploy…");
  try {
    const data = await api(`/api/projects/${state.current}/preview`, { method: "POST" });
    toast(data.result?.previewUrl ? "Preview deploying… it may take 1–2 min." : "Preview triggered.", "success");
    setTimeout(loadDetail, 2000);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#btn-publish")?.addEventListener("click", async () => {
  if (!state.current) return;
  if (!confirm("Publish the preview to your production URL?")) return;
  try {
    const data = await api(`/api/projects/${state.current}/publish`, { method: "POST" });
    toast(data.result?.productionUrl ? "Published." : "Publish triggered.", "success");
    await loadDetail();
  } catch (err) {
    toast(err.message, "error");
  }
});

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
    // Bypass mode: server reports ToS not required — hide the modal forever for this session.
    if (status.bypassed === true || status.acceptedVersion === "bypass") {
      document.getElementById("tos-modal")?.classList?.add("hidden");
      return true;
    }
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
