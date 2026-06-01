const pages = ["overview", "websites", "teams", "wallets", "domains", "webhooks", "activity", "settings"];
let state = null;
let page = "overview";
let walletMode = "active";

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

function validColor(value, fallback = "#64f5b5") {
  return /^#[0-9a-fA-F]{6}$/.test(value || "") ? value : fallback;
}

const walletCount = (count) => `${count} wallet${count === 1 ? "" : "s"}`;

function walletGroupOptions(selected = "") {
  return `<option value="" ${selected ? "" : "selected"}>Ungrouped</option>${state.walletGroups.map((group) =>
    `<option value="${esc(group.id)}" ${group.id === selected ? "selected" : ""}>${esc(group.name)}</option>`
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
          <span class="chip ${state.settings.privacy_cash_enabled ? "good" : "warn"}">Privacy Cash ${state.settings.privacy_cash_enabled ? "enabled" : "disabled"}</span>
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
          <label>Threshold override<input name="threshold_usd" type="number" step="0.01" placeholder="Use global" /></label>
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
    <article class="card"><h3>Add owner</h3><p><small>Each owner is linked to one Discord ID and can update only their own SOL payout wallet from the owners server.</small></p>
      <form id="owner-form" class="form-grid"><label>Name<input name="display_name" required /></label>
      <label>Discord user ID<input name="discord_user_id" required /></label><label>Discord username<input name="discord_username" /></label>
      <label>Solana wallet<input name="solana_wallet_address" placeholder="Can be added by the owner later" /></label><button class="full">Add owner</button></form>
      <div class="stack" style="margin-top:1rem">${state.owners.map(owner => `<div class="actions"><small>${esc(owner.display_name)} &middot; ${esc(owner.discord_user_id)} &middot; <code>${esc(short(owner.solana_wallet_address))}</code></small></div>`).join("") || "<small>No owner profiles yet.</small>"}</div>
      <h3 style="margin-top:1.2rem">Add manager</h3><form id="manager-form" class="form-grid">
      <label>Name<input name="display_name" required /></label><label>Discord user ID<input name="discord_user_id" required /></label>
      <label>Discord username<input name="discord_username" /></label><button>Add manager</button></form>
      <div class="stack" style="margin-top:1rem">${state.managers.map(manager => `<div class="actions"><small>${esc(manager.display_name)} &middot; ${esc(manager.discord_user_id)}</small>${manager.active ? `<button class="small ghost danger" data-archive-manager="${manager.id}">Archive</button>` : '<small>Archived</small>'}</div>`).join("")}</div>
      <h3 style="margin-top:1.2rem">Add team</h3><form id="team-form" class="form-grid">
      <label>Name<input name="name" required /></label><label>Initial manager wallet<input name="manager_wallet_address" placeholder="Can be added later" /></label>
      <label>Team Discord channel ID<input name="payout_discord_channel_id" /></label><label class="full">Team payout message<input name="payout_message" value="New payout for the team. GG! 💸 🎉" /></label>
      <button class="full">Add team</button></form></article>
    <article class="card"><h3>Teams and assigned managers</h3>
      <div class="stack">${state.teams.map((team) => `<div class="card">
        <strong>${esc(team.name)}</strong> ${team.active ? '<span class="chip good">Active</span>' : '<span class="chip bad">Archived</span>'}
        <p><small>Wallet: <code>${esc(team.manager_wallet_address || "Not set")}</code><br />Channel: ${esc(team.payout_discord_channel_id || "Not set")}</small></p>
        <p><small>Managers: ${(team.team_managers || []).map((item) => esc(item.managers?.display_name)).join(", ") || "None"}</small></p>
        <div class="actions"><button class="small ghost" data-assign-manager="${team.id}">Assign manager</button><button class="small ghost" data-remove-manager="${team.id}">Remove manager</button><button class="small ghost" data-team-wallet="${team.id}">Request wallet update</button><button class="small ghost" data-team-channel="${team.id}">Edit message/channel</button>${team.active ? `<button class="small ghost danger" data-archive-team="${team.id}">Archive</button>` : ""}</div>
      </div>`).join("")}</div>
      <h3 style="margin-top:1.2rem">Pending manager wallet requests</h3>
      <div class="stack">${state.managerWalletRequests.filter(item => item.status === "pending").map(item => `<div class="card">
        <strong>${esc(item.teams?.name)}</strong><p><small>Requested wallet: <code>${esc(short(item.new_wallet_address))}</code><br />Requested: ${date(item.created_at)}</small></p>
        <div class="actions"><button class="small ghost" data-approve-manager-wallet="${item.id}">Approve</button><button class="small ghost danger" data-reject-manager-wallet="${item.id}">Reject</button></div>
      </div>`).join("") || "<small>No pending requests.</small>"}</div>
    </article></div>`;
}

function wallets() {
  const shownWallets = state.wallets.filter((wallet) => wallet.active === (walletMode === "active"));
  const groups = [
    ...state.walletGroups.map((group) => ({
      ...group,
      wallets: shownWallets.filter((wallet) => wallet.wallet_group_id === group.id)
    })),
    {
      id: "",
      name: "Ungrouped",
      color_label: "#8da8a2",
      wallets: shownWallets.filter((wallet) => !wallet.wallet_group_id)
    }
  ].filter((group) => group.wallets.length);
  const rowsFor = (group) => group.wallets.map((wallet) => `
    <tr>
      <td><span class="color-dot" style="--label-color:${esc(validColor(wallet.color_label, group.color_label))}"></span><strong>${esc(wallet.label)}</strong></td>
      <td><code>${esc(wallet.address)}</code></td>
      <td>${wallet.active ? '<span class="chip good">Active</span>' : '<span class="chip bad">Archived</span>'}</td>
      <td><div class="actions">
        <button class="small ghost" data-edit-wallet="${wallet.id}">Edit</button>
        <button class="small ghost" data-export-private-key="${wallet.id}">Export private key</button>
        ${wallet.active
          ? `<button class="small ghost danger" data-archive-wallet="${wallet.id}">Archive</button>`
          : `<button class="small ghost" data-restore-wallet="${wallet.id}">Restore</button>`}
      </div></td>
    </tr>`).join("");
  const groupCards = groups.map((group) => `
    <article class="card wallet-group" style="--wallet-group-color:${esc(validColor(group.color_label, "#8da8a2"))}">
      <div class="wallet-group-heading">
        <div><span class="color-dot"></span><strong>${esc(group.name)}</strong><small>${walletCount(group.wallets.length)}</small></div>
        ${group.id ? `<button class="small ghost" data-edit-wallet-group="${group.id}">Edit group</button>` : ""}
      </div>
      <div class="table-wrap"><table><thead><tr><th>Label</th><th>Address</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rowsFor(group)}</tbody></table></div>
    </article>`).join("");
  return `<div class="grid two">
    <article class="card"><h3>Import revenue wallet</h3><p><small>The private key is encrypted immediately. Group and color labels help separate wallet batches without exposing secrets.</small></p>
      <form id="wallet-form" class="stack">
        <label>Label<input name="label" required /></label>
        <label>Wallet color<input name="color_label" type="color" value="#64f5b5" required /></label>
        <label>Group<select name="wallet_group_id" id="wallet-import-group">${walletGroupOptions()}<option value="__new__">+ Create new group</option></select></label>
        <div class="form-grid" id="wallet-new-group-fields" hidden>
          <label>New group name<input name="new_group_name" /></label>
          <label>New group color<input name="new_group_color_label" type="color" value="#64f5b5" /></label>
        </div>
        <label>Private key<textarea name="private_key" required placeholder="Base58, base64, or JSON byte array"></textarea></label>
        <button>Encrypt and import</button>
      </form>
    </article>
    <article class="card"><h3>Wallet organization</h3><p><small>Colors can be adjusted per group and per wallet after import.</small></p>
      <div class="stack">
        ${state.walletGroups.map((group) => `<div class="wallet-group-summary"><span class="color-dot" style="--label-color:${esc(validColor(group.color_label))}"></span><strong>${esc(group.name)}</strong><small>${walletCount(state.wallets.filter((wallet) => wallet.wallet_group_id === group.id).length)}</small><button class="small ghost" data-edit-wallet-group="${group.id}">Edit</button></div>`).join("") || "<small>No groups yet. Create one while importing a wallet.</small>"}
      </div>
    </article>
    <article class="card full">
      <div class="wallet-toolbar">
        <div class="segmented">
          <button class="${walletMode === "active" ? "active" : ""}" data-wallet-mode="active">Active (${state.wallets.filter((wallet) => wallet.active).length})</button>
          <button class="${walletMode === "archived" ? "active" : ""}" data-wallet-mode="archived">Archived (${state.wallets.filter((wallet) => !wallet.active).length})</button>
        </div>
        <div class="actions wallet-export">
          <select id="wallet-export-status" aria-label="Wallet CSV export status">
            <option value="active">Active wallets</option>
            <option value="archived">Archived wallets</option>
            <option value="both">Active and archived wallets</option>
          </select>
          <button class="ghost" data-export-wallet-csv>Export CSV</button>
        </div>
      </div>
    </article>
    <div class="stack full">${groupCards || `<article class="card"><small>No ${walletMode} wallets.</small></article>`}</div>
  </div>`;
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
    <article class="card"><h3>Privacy Cash legs</h3>${activityTable(state.privacyCashWithdrawals, "withdrawal")}</article>
    <article class="card"><h3>Swap attempts</h3>${activityTable(state.swaps, "swap")}</article>
    <article class="card"><h3>Website requests</h3>${state.websiteRequests.map(item => `<p><strong>${esc(item.teams?.name)}</strong> requested ${item.website_count} website(s)<br /><small>${esc(item.requested_by_username)} &middot; ${date(item.created_at)}</small></p>`).join("") || "<small>No requests yet.</small>"}</article>
    <article class="card full"><h3>Audit trail</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead><tbody>
    ${state.auditLogs.map(item => `<tr><td>${date(item.created_at)}</td><td>${esc(item.actor_type)}: ${esc(item.actor_id)}</td><td>${esc(item.action)}</td><td>${esc(item.entity_type)} ${esc(short(item.entity_id))}</td></tr>`).join("")}</tbody></table></div></article></div>`;
}

function settings() {
  const s = state.settings;
  return `<article class="card"><h3>Global defaults and guardrails</h3><form id="settings-form" class="form-grid">
    <label>Threshold USD<input name="global_threshold_usd" type="number" step="0.01" value="${esc(s.global_threshold_usd)}" /></label>
    <label>SOL reserve<input name="global_sol_reserve" type="number" step="0.000000001" value="${esc(s.global_sol_reserve)}" /></label>
    <label>Minimum swap USD<input name="min_swap_usd" type="number" step="0.01" value="${esc(s.min_swap_usd)}" /></label>
    <label>Max price impact %<input name="max_price_impact_pct" type="number" step="0.0001" value="${esc(s.max_price_impact_pct)}" /></label>
    <label>Minimum organic score<input name="min_organic_score" type="number" step="0.0001" value="${esc(s.min_organic_score)}" /></label>
    <label>Minimum private delay hours<input name="privacy_min_delay_hours" type="number" min="24" step="1" value="${esc(s.privacy_min_delay_hours)}" /></label>
    <label>Maximum private delay hours<input name="privacy_max_delay_hours" type="number" min="24" step="1" value="${esc(s.privacy_max_delay_hours)}" /></label>
    <label>Owners Discord server ID<input name="owners_discord_guild_id" value="${esc(s.owners_discord_guild_id || "")}" /></label>
    <label>Owners notification channel ID<input name="owners_notifications_channel_id" value="${esc(s.owners_notifications_channel_id || "")}" /></label>
    <label>Rotate after days<input name="rotation_warn_after_days" type="number" min="1" step="1" value="${esc(s.rotation_warn_after_days)}" /></label>
    <label>Rotate after payout legs<input name="rotation_warn_after_legs" type="number" min="1" step="1" value="${esc(s.rotation_warn_after_legs)}" /></label>
    <label>Rotate after received USD<input name="rotation_warn_after_usd" type="number" min="1" step="0.01" value="${esc(s.rotation_warn_after_usd)}" /></label>
    <label>Rotate after weekly legs<input name="rotation_warn_after_weekly_legs" type="number" min="1" step="1" value="${esc(s.rotation_warn_after_weekly_legs)}" /></label>
    <label>Manager role IDs<input name="discord_manager_role_ids" value="${esc((s.discord_manager_role_ids || []).join(","))}" placeholder="comma-separated" /></label>
    <label>Staff role IDs<input name="discord_staff_role_ids" value="${esc((s.discord_staff_role_ids || []).join(","))}" placeholder="comma-separated" /></label>
    <label><input name="swaps_enabled" type="checkbox" ${s.swaps_enabled ? "checked" : ""}/> Enable guarded SPL swaps</label>
    <label><input name="privacy_cash_enabled" type="checkbox" ${s.privacy_cash_enabled ? "checked" : ""}/> Enable Privacy Cash SOL payouts</label>
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
  if (page === "wallets") syncWalletImportGroup();
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

function syncWalletImportGroup() {
  const select = $("#wallet-import-group");
  const fields = $("#wallet-new-group-fields");
  if (!select || !fields) return;
  const creating = select.value === "__new__";
  fields.hidden = !creating;
  fields.querySelector("[name=new_group_name]").required = creating;
}

function openWalletEditDialog(walletId) {
  const wallet = state.wallets.find((item) => item.id === walletId);
  const dialog = $("#wallet-edit-dialog");
  dialog.querySelector("[name=wallet_id]").value = wallet.id;
  dialog.querySelector("[name=label]").value = wallet.label;
  dialog.querySelector("[name=wallet_group_id]").innerHTML = walletGroupOptions(wallet.wallet_group_id || "");
  dialog.querySelector("[name=color_label]").value = validColor(wallet.color_label);
  dialog.showModal();
}

function openWalletGroupDialog(groupId) {
  const group = state.walletGroups.find((item) => item.id === groupId);
  const dialog = $("#wallet-group-dialog");
  dialog.querySelector("[name=wallet_group_id]").value = group.id;
  dialog.querySelector("[name=name]").value = group.name;
  dialog.querySelector("[name=color_label]").value = validColor(group.color_label);
  dialog.showModal();
}

function openPrivateKeyDialog(walletId) {
  const wallet = state.wallets.find((item) => item.id === walletId);
  const dialog = $("#wallet-private-key-dialog");
  dialog.querySelector("[name=wallet_id]").value = wallet.id;
  dialog.querySelector("[name=confirm_label]").value = "";
  dialog.querySelector("[name=password]").value = "";
  $("#wallet-private-key-label").textContent = wallet.label;
  dialog.showModal();
}

async function downloadAttachment(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status === 401) {
    $("#login-dialog").showModal();
    throw new Error("Please sign in");
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = match?.[1] || "download.txt";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

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
  if (event.target.id === "owner-form") mutate("/api/owners", "POST", Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "")));
  if (event.target.id === "manager-form") mutate("/api/managers", "POST", values);
  if (event.target.id === "team-form") mutate("/api/teams", "POST", Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "")));
  if (event.target.id === "assign-manager-form") {
    $("#assign-manager-dialog").close();
    mutate(`/api/teams/${values.team_id}/managers`, "POST", { manager_id: values.manager_id });
  }
  if (event.target.id === "wallet-form") {
    const creatingGroup = values.wallet_group_id === "__new__";
    mutate("/api/wallets/import", "POST", {
      label: values.label,
      private_key: values.private_key,
      color_label: values.color_label,
      wallet_group_id: creatingGroup ? null : values.wallet_group_id || null,
      ...(creatingGroup ? {
        new_group_name: values.new_group_name,
        new_group_color_label: values.new_group_color_label
      } : {})
    });
  }
  if (event.target.id === "wallet-edit-form") {
    $("#wallet-edit-dialog").close();
    mutate(`/api/wallets/${values.wallet_id}`, "PUT", {
      label: values.label,
      wallet_group_id: values.wallet_group_id || null,
      color_label: values.color_label
    });
  }
  if (event.target.id === "wallet-group-form") {
    $("#wallet-group-dialog").close();
    mutate(`/api/wallet-groups/${values.wallet_group_id}`, "PUT", {
      name: values.name,
      color_label: values.color_label
    });
  }
  if (event.target.id === "wallet-private-key-form") {
    const wallet = state.wallets.find((item) => item.id === values.wallet_id);
    if (values.confirm_label !== wallet.label) {
      return notice("Wallet label confirmation does not match.", "error");
    }
    try {
      await downloadAttachment(`/api/wallets/${wallet.id}/export-private-key`, { password: values.password });
      $("#wallet-private-key-dialog").close();
      notice("Private key downloaded. Store it securely and remove extra copies.");
      await load();
    } catch (error) {
      notice(error.message, "error");
    }
  }
  if (event.target.id === "route-form") mutate("/api/notification-routes", "POST", { ...values, team_id: values.team_id || null, enabled: true });
  if (event.target.id === "website-form") mutate("/api/websites", "POST", {
    ...values,
    threshold_usd: optionalNumeric(values.threshold_usd), sol_reserve: optionalNumeric(values.sol_reserve)
  });
  if (event.target.id === "settings-form") mutate("/api/settings", "PUT", {
    global_threshold_usd: Number(values.global_threshold_usd), global_sol_reserve: Number(values.global_sol_reserve),
    min_swap_usd: Number(values.min_swap_usd), max_price_impact_pct: Number(values.max_price_impact_pct),
    min_organic_score: Number(values.min_organic_score), discord_manager_role_ids: splitIds(values.discord_manager_role_ids),
    discord_staff_role_ids: splitIds(values.discord_staff_role_ids), privacy_cash_enabled: event.target.privacy_cash_enabled.checked,
    privacy_min_delay_hours: Number(values.privacy_min_delay_hours), privacy_max_delay_hours: Number(values.privacy_max_delay_hours),
    owners_discord_guild_id: values.owners_discord_guild_id || null, owners_notifications_channel_id: values.owners_notifications_channel_id || null,
    rotation_warn_after_days: Number(values.rotation_warn_after_days), rotation_warn_after_legs: Number(values.rotation_warn_after_legs),
    rotation_warn_after_usd: Number(values.rotation_warn_after_usd), rotation_warn_after_weekly_legs: Number(values.rotation_warn_after_weekly_legs),
    swaps_enabled: event.target.swaps_enabled.checked,
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
  if (button.dataset.restoreWallet && confirm("Restore this revenue wallet to the active list?")) mutate(`/api/wallets/${button.dataset.restoreWallet}`, "PUT", { active: true });
  if (button.dataset.editWallet) openWalletEditDialog(button.dataset.editWallet);
  if (button.dataset.editWalletGroup) openWalletGroupDialog(button.dataset.editWalletGroup);
  if (button.dataset.exportPrivateKey) openPrivateKeyDialog(button.dataset.exportPrivateKey);
  if (button.dataset.walletMode) { walletMode = button.dataset.walletMode; render(); }
  if (button.dataset.exportWalletCsv !== undefined) {
    try {
      await downloadAttachment("/api/wallets/export-csv", { status: $("#wallet-export-status").value });
      notice("Wallet CSV downloaded.");
      await load();
    } catch (error) {
      notice(error.message, "error");
    }
  }
  if (button.id === "wallet-edit-cancel") $("#wallet-edit-dialog").close();
  if (button.id === "wallet-group-cancel") $("#wallet-group-dialog").close();
  if (button.id === "wallet-private-key-cancel") $("#wallet-private-key-dialog").close();
  if (button.dataset.testRoute) mutate(`/api/notification-routes/${button.dataset.testRoute}/test`, "POST");
  if (button.dataset.deleteRoute && confirm("Remove this webhook route?")) mutate(`/api/notification-routes/${button.dataset.deleteRoute}`, "DELETE");
  if (button.dataset.approveManagerWallet && confirm("Approve this manager payout wallet?")) mutate(`/api/manager-wallet-requests/${button.dataset.approveManagerWallet}/approved`, "POST");
  if (button.dataset.rejectManagerWallet && confirm("Reject this manager payout wallet?")) mutate(`/api/manager-wallet-requests/${button.dataset.rejectManagerWallet}/rejected`, "POST");
  if (button.dataset.teamWallet) {
    const wallet = prompt("Request a new manager payout wallet for this team:");
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
    const wallets = state.wallets.filter(w => w.active).map(w => `${w.label}: ${w.id}`).join("\n");
    const revenue_wallet_id = prompt(`Revenue wallet ID:\n\n${wallets}`, website.revenue_wallet_id);
    if (revenue_wallet_id === null) return;
    const threshold_usd = prompt("Threshold USD override (blank uses global):", website.threshold_usd ?? "");
    if (threshold_usd === null) return;
    const sol_reserve = prompt("SOL reserve override (blank uses global):", website.sol_reserve ?? "");
    if (sol_reserve === null) return;
    const remarks = prompt("Website remarks:", website.remarks || "");
    if (remarks !== null) mutate(`/api/websites/${website.id}`, "PUT", {
      revenue_wallet_id, threshold_usd: optionalNumeric(threshold_usd),
      sol_reserve: optionalNumeric(sol_reserve), remarks
    });
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "wallet-import-group") syncWalletImportGroup();
  if (event.target.dataset.hosted) {
    mutate(`/api/websites/${event.target.dataset.hosted}`, "PUT", { hosted: event.target.checked });
  }
});

renderNav();
load();
