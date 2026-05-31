const pages = ["overview", "websites", "teams", "wallets", "domains", "webhooks", "activity", "settings"];
let state = null;
let page = "overview";

const $ = (selector) => document.querySelector(selector);
const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[char]));
const short = (value = "") => value ? `${value.slice(0, 5)}...${value.slice(-5)}` : "-";
const date = (value) => value ? new Date(value).toLocaleString() : "-";
const nestedDomain = (record) => record?.websites?.domains?.domain ?? record?.domains?.domain ?? "-";

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    $("#login-dialog").showModal();
    throw new Error("Please sign in");
  }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function notice(message, type = "success") {
  $("#notice").innerHTML = `<div class="notice ${type}">${esc(message)}</div>`;
  setTimeout(() => { $("#notice").innerHTML = ""; }, 4500);
}

async function mutate(url, method, body) {
  try {
    await api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    notice("Saved successfully.");
    await load();
  } catch (error) {
    notice(error.message, "error");
  }
}

function renderNav() {
  $("#nav").innerHTML = pages.map((item) =>
    `<button data-page="${item}" class="${item === page ? "active" : ""}">${item[0].toUpperCase() + item.slice(1)}</button>`
  ).join("");
  $("#page-title").textContent = page[0].toUpperCase() + page.slice(1);
}

function option(items, value, label, placeholder = "Select") {
  return `<option value="">${placeholder}</option>${items.map((item) =>
    `<option value="${esc(item[value])}">${esc(item[label])}</option>`
  ).join("")}`;
}

function overview() {
  const pool = state.domains.filter((item) => item.status === "pool").length;
  const hosted = state.websites.filter((item) => item.active && item.hosted).length;
  const status = state.settings.emergency_paused ? "Emergency pause enabled" :
    state.settings.live_payouts_enabled ? "Live payouts enabled" : "Dry-run mode";
  return `
    <div class="grid stats">
      <article class="card stat"><strong>${state.teams.filter((item) => item.active).length}</strong><span>Active teams</span></article>
      <article class="card stat"><strong>${hosted}</strong><span>Hosted websites</span></article>
      <article class="card stat"><strong>${pool}</strong><span>Domains in pool</span></article>
      <article class="card stat"><strong>${state.wallets.filter((item) => item.active).length}</strong><span>Revenue wallets</span></article>
    </div>
    <div class="grid two" style="margin-top:1rem">
      <article class="card"><h3>System guardrails</h3>
        <div class="stack">
          <span class="chip ${state.settings.emergency_paused ? "bad" : "good"}">${esc(status)}</span>
          <span class="chip ${state.settings.swaps_enabled ? "good" : "warn"}">SPL swaps ${state.settings.swaps_enabled ? "enabled" : "disabled"}</span>
          <span class="chip">Global threshold: $${esc(state.settings.global_threshold_usd)}</span>
          <span class="chip">Wallet reserve: ${esc(state.settings.global_sol_reserve)} SOL</span>
        </div>
      </article>
      <article class="card"><h3>Latest payouts</h3>${activityTable(state.payouts, "payout")}</article>
    </div>`;
}

function websites() {
  const pool = state.domains.filter((item) => item.status === "pool");
  return `
    <div class="grid two">
      <article class="card"><h3>Assign website</h3>
        <form id="website-form" class="form-grid">
          <label>Domain<select name="domain_id" required>${option(pool, "id", "domain", "Choose pooled domain")}</select></label>
          <label>Team<select name="team_id" required>${option(state.teams.filter(t => t.active), "id", "name", "Choose team")}</select></label>
          <label>Revenue wallet<select name="revenue_wallet_id" required>${option(state.wallets.filter(w => w.active), "id", "label", "Choose wallet")}</select></label>
          <label>Company wallet<input name="company_wallet_address" required placeholder="Solana wallet" /></label>
          <label>Threshold override<input name="threshold_usd" type="number" step="0.01" placeholder="Use global" /></label>
          <label>Manager % override<input name="manager_percent" type="number" step="0.0001" placeholder="Use global" /></label>
          <label>Company % override<input name="company_percent" type="number" step="0.0001" placeholder="Use global" /></label>
          <label>SOL reserve override<input name="sol_reserve" type="number" step="0.000000001" placeholder="Use global" /></label>
          <label class="full">Remarks<textarea name="remarks" placeholder="Internal or launch remarks"></textarea></label>
          <button class="full">Assign website</button>
        </form>
      </article>
      <article class="card"><h3>Assigned websites</h3>
        <div class="table-wrap"><table><thead><tr><th>Domain</th><th>Team</th><th>Wallet</th><th>Hosted</th><th>Actions</th></tr></thead>
        <tbody>${state.websites.map((item) => `<tr>
          <td>${esc(item.domains?.domain)}<br /><small>${item.active ? "Active" : "Archived"}</small></td>
          <td>${esc(item.teams?.name)}</td><td><code>${esc(short(item.revenue_wallets?.address))}</code></td>
          <td><label class="toggle"><input data-hosted="${item.id}" type="checkbox" ${item.hosted ? "checked" : ""} ${!item.active ? "disabled" : ""}/><span class="slider"></span></label></td>
          <td><div class="actions"><button class="small ghost" data-edit-website="${item.id}">Edit</button><button class="small ghost danger" data-archive-website="${item.id}">Archive</button></div></td>
        </tr>`).join("")}</tbody></table></div>
      </article>
    </div>`;
}

function teams() {
  return `<div class="grid two">
    <article class="card"><h3>Add manager</h3><form id="manager-form" class="form-grid">
      <label>Name<input name="display_name" required /></label><label>Discord user ID<input name="discord_user_id" required /></label>
      <label>Discord username<input name="discord_username" /></label><button>Add manager</button></form>
      <div class="stack" style="margin-top:1rem">${state.managers.map(manager => `<div class="actions"><small>${esc(manager.display_name)} · ${esc(manager.discord_user_id)}</small>${manager.active ? `<button class="small ghost danger" data-archive-manager="${manager.id}">Archive</button>` : '<small>Archived</small>'}</div>`).join("")}</div>
      <h3 style="margin-top:1.2rem">Add team</h3><form id="team-form" class="form-grid">
      <label>Name<input name="name" required /></label><label>Initial manager wallet<input name="manager_wallet_address" placeholder="Can be added later" /></label>
      <label>Team Discord channel ID<input name="payout_discord_channel_id" /></label><label class="full">Team payout message<input name="payout_message" value="New payout for the team. GG! 💸 🎉" /></label>
      <button class="full">Add team</button></form></article>
    <article class="card"><h3>Teams and assigned managers</h3>
      <div class="stack">${state.teams.map((team) => `<div class="card">
        <strong>${esc(team.name)}</strong> ${team.active ? '<span class="chip good">Active</span>' : '<span class="chip bad">Archived</span>'}
        <p><small>Wallet: <code>${esc(team.manager_wallet_address || "Not set")}</code><br />Channel: ${esc(team.payout_discord_channel_id || "Not set")}</small></p>
        <p><small>Managers: ${(team.team_managers || []).map((item) => esc(item.managers?.display_name)).join(", ") || "None"}</small></p>
        <div class="actions"><button class="small ghost" data-assign-manager="${team.id}">Assign manager</button><button class="small ghost" data-remove-manager="${team.id}">Remove manager</button><button class="small ghost" data-team-wallet="${team.id}">Update wallet</button><button class="small ghost" data-team-channel="${team.id}">Edit message/channel</button>${team.active ? `<button class="small ghost danger" data-archive-team="${team.id}">Archive</button>` : ""}</div>
      </div>`).join("")}</div>
    </article></div>`;
}

function wallets() {
  return `<div class="grid two">
    <article class="card"><h3>Import revenue wallet</h3><p><small>The private key is encrypted by the server immediately and is never returned to the browser.</small></p>
      <form id="wallet-form" class="stack"><label>Label<input name="label" required /></label>
      <label>Private key<textarea name="private_key" required placeholder="Base58, base64, or JSON byte array"></textarea></label><button>Encrypt and import</button></form></article>
    <article class="card"><h3>Revenue wallets</h3><div class="table-wrap"><table><thead><tr><th>Label</th><th>Address</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${state.wallets.map((item) => `<tr><td>${esc(item.label)}</td><td><code>${esc(item.address)}</code></td><td>${item.active ? "Active" : "Archived"}</td><td>${item.active ? `<button class="small ghost danger" data-archive-wallet="${item.id}">Archive</button>` : ""}</td></tr>`).join("")}</tbody></table></div></article></div>`;
}

function domains() {
  return `<div class="grid two">
    <article class="card"><h3>Bulk import</h3><form id="domain-form" class="stack"><label>Domains<textarea name="domains" required placeholder="example.com, another-site.com"></textarea></label><button>Import domains</button></form></article>
    <article class="card"><h3>Domain pool</h3><div class="table-wrap"><table><thead><tr><th>Domain</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${state.domains.map((item) => `<tr><td>${esc(item.domain)}</td><td>${esc(item.status)}</td><td><button class="small ghost danger" data-archive-domain="${item.id}">Archive</button></td></tr>`).join("")}</tbody></table></div></article></div>`;
}

function webhooks() {
  const kinds = ["website_request", "website_activation", "deposit", "payout", "security_alert", "worker_error"];
  return `<div class="grid two">
    <article class="card"><h3>Save Discord webhook</h3><p><small>Leave team empty for a global route. A team-specific route overrides the global route.</small></p>
      <form id="route-form" class="stack"><label>Purpose<select name="kind">${kinds.map(k => `<option>${k}</option>`).join("")}</select></label>
      <label>Team override<select name="team_id">${option(state.teams, "id", "name", "Global route")}</select></label><label>Name<input name="name" required /></label>
      <label>Discord webhook URL<input name="webhook_url" type="url" required /></label><button>Encrypt and save route</button></form></article>
    <article class="card"><h3>Configured routes</h3><div class="table-wrap"><table><thead><tr><th>Purpose</th><th>Team</th><th>Name</th><th>Action</th></tr></thead>
      <tbody>${state.notificationRoutes.map((item) => `<tr><td>${esc(item.kind)}</td><td>${esc(state.teams.find(t => t.id === item.team_id)?.name || "Global")}</td><td>${esc(item.name)}</td><td><div class="actions"><button class="small ghost" data-test-route="${item.id}">Test</button><button class="small ghost danger" data-delete-route="${item.id}">Remove</button></div></td></tr>`).join("")}</tbody></table></div></article></div>`;
}

function activityTable(items, type) {
  if (!items.length) return "<small>No records yet.</small>";
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Website</th><th>Status</th><th>Details</th></tr></thead><tbody>${items.slice(0, 15).map((item) => `<tr>
    <td>${date(item.created_at)}</td><td>${esc(nestedDomain(item))}</td><td>${esc(item.status || type)}</td>
    <td><code>${esc(short(item.signature || item.asset_mint || item.action || ""))}</code>${item.reason ? `<br /><small>${esc(item.reason)}</small>` : ""}</td>
  </tr>`).join("")}</tbody></table></div>`;
}

function activity() {
  return `<div class="grid two"><article class="card"><h3>Deposits</h3>${activityTable(state.deposits, "deposit")}</article>
    <article class="card"><h3>Payouts</h3>${activityTable(state.payouts, "payout")}</article>
    <article class="card"><h3>Swap attempts</h3>${activityTable(state.swaps, "swap")}</article>
    <article class="card"><h3>Website requests</h3>${state.websiteRequests.map(item => `<p><strong>${esc(item.teams?.name)}</strong> requested ${item.website_count} website(s)<br /><small>${esc(item.requested_by_username)} · ${date(item.created_at)}</small></p>`).join("") || "<small>No requests yet.</small>"}</article>
    <article class="card full"><h3>Audit trail</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead><tbody>
    ${state.auditLogs.map(item => `<tr><td>${date(item.created_at)}</td><td>${esc(item.actor_type)}: ${esc(item.actor_id)}</td><td>${esc(item.action)}</td><td>${esc(item.entity_type)} ${esc(short(item.entity_id))}</td></tr>`).join("")}</tbody></table></div></article></div>`;
}

function settings() {
  const s = state.settings;
  return `<article class="card"><h3>Global defaults and guardrails</h3><form id="settings-form" class="form-grid">
    <label>Threshold USD<input name="global_threshold_usd" type="number" step="0.01" value="${esc(s.global_threshold_usd)}" /></label>
    <label>Manager %<input name="global_manager_percent" type="number" step="0.0001" value="${esc(s.global_manager_percent)}" /></label>
    <label>Company %<input name="global_company_percent" type="number" step="0.0001" value="${esc(s.global_company_percent)}" /></label>
    <label>SOL reserve<input name="global_sol_reserve" type="number" step="0.000000001" value="${esc(s.global_sol_reserve)}" /></label>
    <label>Minimum swap USD<input name="min_swap_usd" type="number" step="0.01" value="${esc(s.min_swap_usd)}" /></label>
    <label>Max price impact %<input name="max_price_impact_pct" type="number" step="0.0001" value="${esc(s.max_price_impact_pct)}" /></label>
    <label>Minimum organic score<input name="min_organic_score" type="number" step="0.0001" value="${esc(s.min_organic_score)}" /></label>
    <label>Manager role IDs<input name="discord_manager_role_ids" value="${esc((s.discord_manager_role_ids || []).join(","))}" placeholder="comma-separated" /></label>
    <label>Staff role IDs<input name="discord_staff_role_ids" value="${esc((s.discord_staff_role_ids || []).join(","))}" placeholder="comma-separated" /></label>
    <label><input name="swaps_enabled" type="checkbox" ${s.swaps_enabled ? "checked" : ""}/> Enable guarded SPL swaps</label>
    <label><input name="live_payouts_enabled" type="checkbox" ${s.live_payouts_enabled ? "checked" : ""}/> Enable live payouts</label>
    <label><input name="emergency_paused" type="checkbox" ${s.emergency_paused ? "checked" : ""}/> Emergency pause</label>
    <button class="full">Save settings</button>
  </form></article>`;
}

function render() {
  renderNav();
  $("#system-status").textContent = state.settings.emergency_paused ? "PAUSED" :
    state.settings.live_payouts_enabled ? "LIVE" : "DRY RUN";
  $("#system-status").className = `status-pill ${state.settings.emergency_paused ? "bad" : state.settings.live_payouts_enabled ? "good" : "warn"}`;
  $("#content").innerHTML = ({ overview, websites, teams, wallets, domains, webhooks, activity, settings }[page])();
}

async function load() {
  try {
    state = await api("/api/bootstrap");
    $("#login-dialog").close();
    render();
  } catch (error) {
    if (error.message !== "Please sign in") notice(error.message, "error");
  }
}

function data(form) {
  return Object.fromEntries(new FormData(form).entries());
}
function optionalNumeric(value) { return value === "" ? null : Number(value); }
function splitIds(value) { return value.split(",").map(v => v.trim()).filter(Boolean); }

function openAssignManagerDialog(teamId) {
  const team = state.teams.find((item) => item.id === teamId);
  const assignedIds = new Set((team.team_managers || []).map((item) => item.manager_id));
  const managers = state.managers.filter((item) => item.active && !assignedIds.has(item.id));
  const dialog = $("#assign-manager-dialog");
  const select = dialog.querySelector("[name=manager_id]");
  const submit = $("#assign-manager-submit");

  dialog.querySelector("[name=team_id]").value = team.id;
  $("#assign-manager-team").textContent = team.name;
  select.innerHTML = option(managers, "id", "display_name", managers.length ? "Choose manager" : "No managers available");
  select.disabled = !managers.length;
  submit.disabled = !managers.length;
  $("#assign-manager-empty").textContent = managers.length ? "" : "Every active manager is already assigned to this team.";
  dialog.showModal();
}

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = data(event.target);
  if (event.target.id === "login-form") {
    try { await api("/api/login", { method: "POST", body: JSON.stringify(values) }); await load(); }
    catch (error) { $("#login-error").textContent = error.message; }
  }
  if (event.target.id === "domain-form") mutate("/api/domains/import", "POST", values);
  if (event.target.id === "manager-form") mutate("/api/managers", "POST", values);
  if (event.target.id === "team-form") mutate("/api/teams", "POST", Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "")));
  if (event.target.id === "assign-manager-form") {
    $("#assign-manager-dialog").close();
    mutate(`/api/teams/${values.team_id}/managers`, "POST", { manager_id: values.manager_id });
  }
  if (event.target.id === "wallet-form") mutate("/api/wallets/import", "POST", values);
  if (event.target.id === "route-form") mutate("/api/notification-routes", "POST", { ...values, team_id: values.team_id || null, enabled: true });
  if (event.target.id === "website-form") mutate("/api/websites", "POST", {
    ...values,
    threshold_usd: optionalNumeric(values.threshold_usd), manager_percent: optionalNumeric(values.manager_percent),
    company_percent: optionalNumeric(values.company_percent), sol_reserve: optionalNumeric(values.sol_reserve)
  });
  if (event.target.id === "settings-form") mutate("/api/settings", "PUT", {
    global_threshold_usd: Number(values.global_threshold_usd), global_manager_percent: Number(values.global_manager_percent),
    global_company_percent: Number(values.global_company_percent), global_sol_reserve: Number(values.global_sol_reserve),
    min_swap_usd: Number(values.min_swap_usd), max_price_impact_pct: Number(values.max_price_impact_pct),
    min_organic_score: Number(values.min_organic_score), discord_manager_role_ids: splitIds(values.discord_manager_role_ids),
    discord_staff_role_ids: splitIds(values.discord_staff_role_ids), swaps_enabled: event.target.swaps_enabled.checked,
    live_payouts_enabled: event.target.live_payouts_enabled.checked, emergency_paused: event.target.emergency_paused.checked
  });
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.page) { page = button.dataset.page; render(); }
  if (button.id === "logout") { await api("/api/logout", { method: "POST" }); location.reload(); }
  if (button.dataset.archiveDomain && confirm("Archive this domain?")) mutate(`/api/domains/${button.dataset.archiveDomain}`, "DELETE");
  if (button.dataset.archiveWebsite && confirm("Archive this website and domain?")) mutate(`/api/websites/${button.dataset.archiveWebsite}`, "DELETE");
  if (button.dataset.archiveManager && confirm("Archive this manager?")) mutate(`/api/managers/${button.dataset.archiveManager}`, "DELETE");
  if (button.dataset.archiveTeam && confirm("Archive this team?")) mutate(`/api/teams/${button.dataset.archiveTeam}`, "PUT", { active: false });
  if (button.dataset.archiveWallet && confirm("Archive this revenue wallet? Existing website assignments will remain active until changed.")) mutate(`/api/wallets/${button.dataset.archiveWallet}`, "DELETE");
  if (button.dataset.testRoute) mutate(`/api/notification-routes/${button.dataset.testRoute}/test`, "POST");
  if (button.dataset.deleteRoute && confirm("Remove this webhook route?")) mutate(`/api/notification-routes/${button.dataset.deleteRoute}`, "DELETE");
  if (button.dataset.teamWallet) {
    const wallet = prompt("New manager payout wallet for this team:");
    if (wallet) mutate(`/api/teams/${button.dataset.teamWallet}`, "PUT", { manager_wallet_address: wallet });
  }
  if (button.dataset.assignManager) openAssignManagerDialog(button.dataset.assignManager);
  if (button.id === "assign-manager-cancel") $("#assign-manager-dialog").close();
  if (button.dataset.removeManager) {
    const team = state.teams.find(t => t.id === button.dataset.removeManager);
    const rows = (team.team_managers || []).map(item => `${item.managers?.display_name}: ${item.manager_id}`).join("\n");
    const manager_id = prompt(`Paste the manager ID to remove:\n\n${rows}`);
    if (manager_id) mutate(`/api/teams/${team.id}/managers/${manager_id}`, "DELETE");
  }
  if (button.dataset.teamChannel) {
    const team = state.teams.find(t => t.id === button.dataset.teamChannel);
    const payout_discord_channel_id = prompt("Team Discord channel ID:", team.payout_discord_channel_id || "");
    if (payout_discord_channel_id === null) return;
    const payout_message = prompt("Team payout message:", team.payout_message || "");
    if (payout_message) mutate(`/api/teams/${team.id}`, "PUT", { payout_discord_channel_id: payout_discord_channel_id || null, payout_message });
  }
  if (button.dataset.editWebsite) {
    const website = state.websites.find(w => w.id === button.dataset.editWebsite);
    const company_wallet_address = prompt("Company wallet:", website.company_wallet_address || "");
    if (company_wallet_address === null) return;
    const wallets = state.wallets.filter(w => w.active).map(w => `${w.label}: ${w.id}`).join("\n");
    const revenue_wallet_id = prompt(`Revenue wallet ID:\n\n${wallets}`, website.revenue_wallet_id);
    if (revenue_wallet_id === null) return;
    const threshold_usd = prompt("Threshold USD override (blank uses global):", website.threshold_usd ?? "");
    if (threshold_usd === null) return;
    const manager_percent = prompt("Manager % override (blank uses global):", website.manager_percent ?? "");
    if (manager_percent === null) return;
    const company_percent = prompt("Company % override (blank uses global):", website.company_percent ?? "");
    if (company_percent === null) return;
    const sol_reserve = prompt("SOL reserve override (blank uses global):", website.sol_reserve ?? "");
    if (sol_reserve === null) return;
    const remarks = prompt("Website remarks:", website.remarks || "");
    if (remarks !== null) mutate(`/api/websites/${website.id}`, "PUT", {
      company_wallet_address, revenue_wallet_id, threshold_usd: optionalNumeric(threshold_usd),
      manager_percent: optionalNumeric(manager_percent), company_percent: optionalNumeric(company_percent),
      sol_reserve: optionalNumeric(sol_reserve), remarks
    });
  }
});

document.addEventListener("change", (event) => {
  if (event.target.dataset.hosted) {
    mutate(`/api/websites/${event.target.dataset.hosted}`, "PUT", { hosted: event.target.checked });
  }
});

renderNav();
load();
