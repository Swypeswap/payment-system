const pages = ["overview", "revenue", "company", "privacy", "review", "webhooks", "activity", "security", "settings"];
let state = null;
let page = location.hash === "#security" ? "security" : "overview";
let walletMode = "active";
let domainMode = "active";

const $ = (selector) => document.querySelector(selector);
const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[char]));
const short = (value = "") => value ? `${value.slice(0, 5)}...${value.slice(-5)}` : "-";
const date = (value) => value ? new Date(value).toLocaleString() : "-";
const nestedDomain = (record) => record?.websites?.domains?.domain ?? record?.domains?.domain ?? "-";

function clearPasswordInputs() {
  document.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ""; });
}

function showLoginDialog() {
  clearPasswordInputs();
  const dialog = $("#login-dialog");
  if (!dialog.open) dialog.showModal();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLoginDialog();
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
const domainCount = (count) => `${count} domain${count === 1 ? "" : "s"}`;

function walletGroupOptions(selected = "") {
  return `<option value="" ${selected ? "" : "selected"}>Ungrouped</option>${state.walletGroups.map((group) =>
    `<option value="${esc(group.id)}" ${group.id === selected ? "selected" : ""}>${esc(group.name)}</option>`
  ).join("")}`;
}

function domainGroupOptions(selected = "") {
  return `<option value="" ${selected ? "" : "selected"}>Ungrouped</option>${state.domainGroups.map((group) =>
    `<option value="${esc(group.id)}" ${group.id === selected ? "selected" : ""}>${esc(group.name)}</option>`
  ).join("")}`;
}

function legacyOverview() {
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
    </div>
    <div class="grid two" style="margin-top:1rem">
      ${payoutReadinessPanel()}
      ${operationsHealthPanel()}
    </div>`;
}

function readinessLine(label, ready, detail = "") {
  return `<div class="health-row"><span class="chip ${ready ? "good" : "bad"}">${ready ? "READY" : "CHECK"}</span><strong>${esc(label)}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}</div>`;
}

function payoutReadinessPanel() {
  const r = state.operations.readiness;
  const latest = state.operations.health.latest_manual_reconciliation;
  const waiting = latest && ["pending", "processing"].includes(latest.status);
  return `<article class="card"><h3>Payout readiness</h3>
    <div class="stack">
      ${readinessLine("Ubuntu DRY_RUN disabled", r.dry_run_disabled)}
      ${readinessLine("Solana mainnet cluster", r.mainnet_cluster)}
      ${readinessLine("Emergency pause disabled", r.emergency_pause_disabled)}
      ${readinessLine("Guarded SPL swaps enabled", r.swaps_enabled)}
      ${readinessLine("Privacy Cash enabled", r.privacy_cash_enabled)}
      ${readinessLine("Hosted websites", r.hosted_websites.ready, `${r.hosted_websites.count} hosted`)}
      ${readinessLine("Owner wallets", r.owner_wallets.ready, `${r.owner_wallets.configured}/${r.owner_wallets.required} configured`)}
      ${readinessLine("Manager wallets", r.manager_wallets.ready, `${r.manager_wallets.configured}/${r.manager_wallets.required} hosted teams configured`)}
      ${readinessLine("Threshold status", r.threshold_status.ready, `${r.threshold_status.reached}/${r.threshold_status.hosted} hosted wallets currently at or above threshold`)}
      <div class="health-row"><span class="chip ${r.pending_payout_legs ? "warn" : "good"}">${esc(r.pending_payout_legs)}</span><strong>Pending payout legs</strong></div>
      <button class="ghost" data-request-reconciliation ${waiting ? "disabled" : ""}>${waiting ? "Guarded reconciliation queued" : "Run guarded Privacy Cash reconciliation"}</button>
      <small>This asks the worker to run its normal guarded reconciliation immediately. Automatic checks continue on the configured interval.</small>
    </div>
  </article>`;
}

function operationsHealthPanel() {
  const h = state.operations.health;
  const worker = h.worker;
  return `<article class="card"><h3>Operations health</h3>
    <div class="metric-grid">
      <div><strong>${worker?.online ? "Online" : "Offline"}</strong><small>Worker heartbeat</small><small>${worker ? date(worker.last_seen_at) : "No heartbeat yet"}</small></div>
      <div><strong>${esc(h.privacy_cash_queue_depth)}</strong><small>Privacy Cash queue depth</small></div>
      <div><strong>${esc(h.pending_payout_legs)}</strong><small>Pending payout legs</small></div>
      <div><strong>${esc(h.delayed_withdrawals_awaiting_release)}</strong><small>Delayed withdrawals awaiting release</small></div>
      <div><strong>${esc(h.failed_jobs)}</strong><small>Failed or review-required jobs</small></div>
      <div><strong>${h.last_helius_event ? date(h.last_helius_event.created_at) : "-"}</strong><small>Last Helius event</small></div>
      <div><strong>${h.last_successful_swap ? date(h.last_successful_swap.updated_at) : "-"}</strong><small>Last successful swap</small></div>
      <div><strong>${h.latest_manual_reconciliation ? esc(h.latest_manual_reconciliation.status) : "-"}</strong><small>Latest manual reconciliation</small></div>
    </div>
  </article>`;
}

function websites() {
  const pool = state.domains.filter((item) => item.status === "pool");
  const assignedWalletIds = new Set(state.websites.filter((item) => item.active).map((item) => item.revenue_wallet_id));
  const availableWallets = state.wallets.filter((wallet) => wallet.active && !assignedWalletIds.has(wallet.id));
  const releasableDomainIds = new Set();
  const releasableWebsiteIds = new Set();
  for (const website of state.websites) {
    if (!website.active && website.domains?.status === "archived" && !releasableDomainIds.has(website.domain_id)) {
      releasableDomainIds.add(website.domain_id);
      releasableWebsiteIds.add(website.id);
    }
  }
  return `
    <div class="grid two">
      <article class="card"><h3>Assign website</h3>
        <form id="website-form" class="form-grid">
          <label>Domain<select name="domain_id" required>${option(pool, "id", "domain", "Choose pooled domain")}</select></label>
          <label>Team<select name="team_id" required>${option(state.teams.filter(t => t.active), "id", "name", "Choose team")}</select></label>
          <label>Revenue wallet<select name="revenue_wallet_id" required>${option(availableWallets, "id", "label", "Choose available wallet")}</select></label>
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
          <td><div class="actions">${item.active ? `<button class="small ghost" data-edit-website="${item.id}">Edit</button><button class="small ghost danger" data-archive-website="${item.id}">Archive</button>` : releasableWebsiteIds.has(item.id) ? `<button class="small ghost" data-release-domain="${item.id}">Return domain to pool</button>` : "<small>History retained</small>"}</div></td>
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
      <td><span class="labeled-value"><span class="color-dot" style="--label-color:${esc(validColor(wallet.color_label, group.color_label))}"></span><strong>${esc(wallet.label)}</strong></span></td>
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
  const shownDomains = state.domains.filter((domain) => (domain.status !== "archived") === (domainMode === "active"));
  const groups = [
    ...state.domainGroups.map((group) => ({
      ...group,
      domains: shownDomains.filter((domain) => domain.domain_group_id === group.id)
    })),
    {
      id: "",
      name: "Ungrouped",
      color_label: "#8d7a9d",
      domains: shownDomains.filter((domain) => !domain.domain_group_id)
    }
  ].filter((group) => group.domains.length);
  const rowsFor = (group) => group.domains.map((domain) => `
    <tr>
      <td><span class="labeled-value"><span class="color-dot" style="--label-color:${esc(validColor(domain.color_label, group.color_label))}"></span><strong>${esc(domain.domain)}</strong></span></td>
      <td><span class="chip ${domain.status === "archived" ? "bad" : domain.status === "assigned" ? "warn" : "good"}">${esc(domain.status)}</span></td>
      <td><div class="actions">
        <button class="small ghost" data-edit-domain="${domain.id}">Edit</button>
        ${domain.status === "archived"
          ? `<button class="small ghost" data-restore-domain="${domain.id}">Restore</button>`
          : domain.status === "pool"
            ? `<button class="small ghost danger" data-archive-domain="${domain.id}">Archive</button>`
            : ""}
        <button class="small ghost danger" data-delete-domain="${domain.id}">Delete</button>
      </div></td>
    </tr>`).join("");
  const groupCards = groups.map((group) => `
    <article class="card wallet-group" style="--wallet-group-color:${esc(validColor(group.color_label, "#8d7a9d"))}">
      <div class="wallet-group-heading">
        <div><span class="color-dot"></span><strong>${esc(group.name)}</strong><small>${domainCount(group.domains.length)}</small></div>
        ${group.id ? `<button class="small ghost" data-edit-domain-group="${group.id}">Edit group</button>` : ""}
      </div>
      <div class="table-wrap"><table><thead><tr><th>Domain</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rowsFor(group)}</tbody></table></div>
    </article>`).join("");
  return `<div class="grid two">
    <article class="card"><h3>Import domains</h3><p><small>Add domains in batches and label them immediately.</small></p>
      <form id="domain-form" class="stack">
        <label>Domains<textarea name="domains" required placeholder="example.com, another-site.com"></textarea></label>
        <label>Domain color<input name="color_label" type="color" value="#ff315f" required /></label>
        <label>Group<select name="domain_group_id" id="domain-import-group">${domainGroupOptions()}<option value="__new__">+ Create new group</option></select></label>
        <div class="form-grid" id="domain-new-group-fields" hidden>
          <label>New group name<input name="new_group_name" /></label>
          <label>New group color<input name="new_group_color_label" type="color" value="#ff315f" /></label>
        </div>
        <button>Import domains</button>
      </form>
    </article>
    <article class="card"><h3>Domain organization</h3><p><small>Colors can be adjusted per group and per domain after import.</small></p>
      <div class="stack">
        ${state.domainGroups.map((group) => `<div class="wallet-group-summary"><span class="color-dot" style="--label-color:${esc(validColor(group.color_label))}"></span><strong>${esc(group.name)}</strong><small>${domainCount(state.domains.filter((domain) => domain.domain_group_id === group.id).length)}</small><button class="small ghost" data-edit-domain-group="${group.id}">Edit</button></div>`).join("") || "<small>No groups yet. Create one while importing a domain.</small>"}
      </div>
    </article>
    <article class="card full">
      <div class="wallet-toolbar">
        <div class="segmented">
          <button class="${domainMode === "active" ? "active" : ""}" data-domain-mode="active">Active (${state.domains.filter((domain) => domain.status !== "archived").length})</button>
          <button class="${domainMode === "archived" ? "active" : ""}" data-domain-mode="archived">Archived (${state.domains.filter((domain) => domain.status === "archived").length})</button>
        </div>
      </div>
    </article>
    <div class="stack full">${groupCards || `<article class="card"><small>No ${domainMode} domains.</small></article>`}</div>
  </div>`;
}

function legacyWebhooks() {
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

function legacyActivity() {
  return `<div class="grid two"><article class="card"><h3>Deposits</h3>${activityTable(state.deposits, "deposit")}</article>
    <article class="card"><h3>Payouts</h3>${activityTable(state.payouts, "payout")}</article>
    <article class="card"><h3>Privacy Cash legs</h3>${activityTable(state.privacyCashWithdrawals, "withdrawal")}</article>
    <article class="card"><h3>Swap attempts</h3>${activityTable(state.swaps, "swap")}</article>
    <article class="card"><h3>Website requests</h3>${state.websiteRequests.map(item => `<p><strong>${esc(item.teams?.name)}</strong> requested ${item.website_count} website(s)<br /><small>${esc(item.requested_by_username)} &middot; ${date(item.created_at)}</small></p>`).join("") || "<small>No requests yet.</small>"}</article>
    <article class="card full"><h3>Audit trail</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead><tbody>
    ${state.auditLogs.map(item => `<tr><td>${date(item.created_at)}</td><td>${esc(item.actor_type)}: ${esc(item.actor_id)}</td><td>${esc(item.action)}</td><td>${esc(item.entity_type)} ${esc(short(item.entity_id))}</td></tr>`).join("")}</tbody></table></div></article></div>`;
}

function security() {
  const sessions = state.operations.sessions;
  return `<div class="grid two">
    <article class="card full"><div class="wallet-toolbar"><div><h3>Active dashboard sessions</h3>
      <small>Review every signed-in device. Revoking all sessions immediately signs everyone out, including this browser.</small></div>
      <button class="danger-action" data-revoke-all-sessions>Revoke all sessions</button></div>
      <div class="table-wrap" style="margin-top:0.8rem"><table><thead><tr><th>IP address</th><th>Network</th><th>Device</th><th>Created</th><th>Last seen</th><th>Expires</th></tr></thead>
      <tbody>${sessions.map((session) => `<tr><td><code>${esc(session.ip_address)}</code></td><td><code>${esc(session.network_key)}</code></td><td>${esc(session.device)}</td><td>${date(session.created_at)}</td><td>${date(session.last_seen_at)}</td><td>${date(session.expires_at)}</td></tr>`).join("") || '<tr><td colspan="6"><small>No active sessions.</small></td></tr>'}</tbody></table></div>
    </article>
  </div>`;
}

function legacySettings() {
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

const routeKinds = [
  "revenue_deposit_received",
  "revenue_swap_completed",
  "revenue_split_completed",
  "unsafe_spl_detected",
  "awaiting_sol_for_fees",
  "performer_configuration_invalid",
  "swap_failed",
  "company_threshold_reached",
  "company_privacy_cash_deposited",
  "company_privacy_cash_payout_released",
  "company_wallet_rotation_due",
  "company_wallet_rotated",
  "company_wallet_generation_failed",
  "retired_revenue_wallet_deletion_due",
  "retired_revenue_wallet_deleted",
  "retired_revenue_wallet_deletion_expired",
  "erased_revenue_wallet_received_funds",
  "archived_company_wallet_deletion_due",
  "archived_company_wallet_deleted",
  "archived_company_wallet_deletion_expired",
  "security_alert",
  "worker_error"
];

function lamportsToSol(value) {
  return `${(Number(value || 0) / 1_000_000_000).toFixed(6)} SOL`;
}

function money(value) {
  return `$${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function activeCompanyWallet() {
  return state.companyWallets.find((wallet) => wallet.status === "active");
}

function overview() {
  const activeRevenue = state.sourceRevenueWallets.filter((wallet) => wallet.mirror_status === "active");
  const retiredRevenue = state.sourceRevenueWallets.filter((wallet) => wallet.mirror_status === "retired");
  const company = activeCompanyWallet();
  const openReviews = state.reviewItems.filter((item) => item.status === "open").length;
  return `
    <div class="grid stats">
      <article class="card stat"><strong>${activeRevenue.length}</strong><span>Active revenue wallets</span></article>
      <article class="card stat"><strong>${retiredRevenue.length}</strong><span>Retired monitored wallets</span></article>
      <article class="card stat"><strong>${company ? short(company.address) : "Missing"}</strong><span>Active company wallet</span></article>
      <article class="card stat"><strong>${openReviews}</strong><span>Review-required items</span></article>
    </div>
    <div class="grid two" style="margin-top:1rem">
      <article class="card"><h3>New flow</h3><div class="stack">
        <span class="chip ${state.settings.source_sync_enabled ? "good" : "warn"}">External Telegram sync ${state.settings.source_sync_enabled ? "enabled" : "disabled"}</span>
        <span class="chip ${state.settings.swaps_enabled ? "good" : "warn"}">Guarded SPL and USDC swaps ${state.settings.swaps_enabled ? "enabled" : "disabled"}</span>
        <span class="chip ${state.settings.privacy_cash_enabled ? "good" : "warn"}">Company Privacy Cash ${state.settings.privacy_cash_enabled ? "enabled" : "disabled"}</span>
        <span class="chip">Company threshold: ${money(state.settings.company_privacy_cash_threshold_usd)}</span>
        <span class="chip">Revenue reserve: ${esc(state.settings.revenue_wallet_sol_reserve)} SOL</span>
      </div></article>
      ${operationsHealthPanel()}
    </div>`;
}

function revenue() {
  return `<div class="grid two">
    <article class="card full"><h3>Mirrored revenue wallets</h3>
      <p><small>Read-only mirror of Telegram-managed sites. Private keys are stored encrypted for the worker only and are never displayed or exportable.</small></p>
      <div class="table-wrap"><table><thead><tr><th>Domain</th><th>Public wallet</th><th>Performer</th><th>Status</th><th>Balance</th><th>Last seen</th></tr></thead><tbody>
      ${state.sourceRevenueWallets.map((wallet) => `<tr>
        <td>${esc(wallet.domain)}</td>
        <td><code>${esc(short(wallet.address))}</code></td>
        <td>${esc(wallet.external_performer_id || "-")}</td>
        <td><span class="chip ${wallet.mirror_status === "active" ? "good" : wallet.mirror_status === "retired" ? "warn" : "bad"}">${esc(wallet.mirror_status)}</span><br /><small>${esc(wallet.external_status)}</small></td>
        <td>${lamportsToSol(wallet.current_sol_lamports)}<br /><small>${(wallet.current_token_balances || []).length} SPL balances</small></td>
        <td>${date(wallet.last_seen_at)}</td>
      </tr>`).join("") || '<tr><td colspan="6"><small>No mirrored revenue wallets yet.</small></td></tr>'}
      </tbody></table></div>
    </article>
    <article class="card"><h3>Latest deposits</h3>${sourceActivityTable(state.sourceDeposits, "deposit")}</article>
    <article class="card"><h3>Latest splits</h3>${sourceActivityTable(state.sourceSplits, "split")}</article>
  </div>`;
}

function company() {
  const company = activeCompanyWallet();
  return `<div class="grid two">
    <article class="card"><h3>Active company wallet</h3>
      ${company ? `<div class="stack">
        <p><code>${esc(company.address)}</code></p>
        <span class="chip good">Active</span>
        <span class="chip">Received volume: ${money(company.received_volume_usd)}</span>
        <span class="chip">Balance: ${lamportsToSol(company.current_sol_lamports)}</span>
        <div class="actions">
          <button class="ghost" data-reveal-company-key="${company.id}">Reveal private key</button>
          <button class="ghost danger" data-rotate-company-wallet="${company.id}">Rotate wallet</button>
        </div>
        <small>Requires dashboard password re-entry. This key is never sent through Discord.</small>
      </div>` : `<div class="stack"><p>No active company wallet exists yet.</p><button data-generate-company-wallet>Generate initial company wallet</button></div>`}
    </article>
    <article class="card"><h3>Rotation rules</h3><div class="stack">
      <span class="chip">Long age: ${esc(state.settings.company_rotation_long_days)} days</span>
      <span class="chip">High volume: ${money(state.settings.company_rotation_high_volume_usd)}</span>
      <span class="chip">Combined: ${esc(state.settings.company_rotation_short_days)} days and ${money(state.settings.company_rotation_lower_volume_usd)}</span>
    </div></article>
    <article class="card full"><h3>Company wallet history</h3><div class="table-wrap"><table><thead><tr><th>Wallet</th><th>Status</th><th>Volume</th><th>Balance</th><th>Activated</th><th>Archived</th><th>Action</th></tr></thead><tbody>
      ${state.companyWallets.map((wallet) => `<tr>
        <td><code>${esc(short(wallet.address))}</code></td>
        <td><span class="chip ${wallet.status === "active" ? "good" : wallet.status === "archived" ? "warn" : "bad"}">${esc(wallet.status)}</span></td>
        <td>${money(wallet.received_volume_usd)}</td>
        <td>${lamportsToSol(wallet.current_sol_lamports)}<br /><small>${(wallet.current_token_balances || []).length} SPL balances</small></td>
        <td>${date(wallet.activated_at)}</td><td>${date(wallet.archived_at)}</td>
        <td>${wallet.status !== "key_erased" ? `<button class="small ghost" data-reveal-company-key="${wallet.id}">Reveal key</button>` : "<small>Key erased</small>"}</td>
      </tr>`).join("") || '<tr><td colspan="7"><small>No company wallets yet.</small></td></tr>'}
    </tbody></table></div></article>
  </div>`;
}

function privacy() {
  return `<div class="grid two">
    <article class="card"><h3>Company Privacy Cash deposits</h3>${sourceActivityTable(state.companyShields, "shield")}</article>
    <article class="card"><h3>Delayed owner withdrawals</h3>${sourceActivityTable(state.companyWithdrawals, "withdrawal")}</article>
  </div>`;
}

function review() {
  return `<div class="grid two">
    <article class="card full"><h3>Review-required items</h3><div class="table-wrap"><table><thead><tr><th>Created</th><th>Severity</th><th>Wallet</th><th>Message</th><th>Status</th></tr></thead><tbody>
      ${state.reviewItems.map((item) => `<tr>
        <td>${date(item.created_at)}</td>
        <td><span class="chip ${item.severity === "critical" ? "bad" : item.severity === "high" ? "warn" : ""}">${esc(item.severity)}</span></td>
        <td><code>${esc(short(item.external_revenue_wallets?.address || item.company_wallets?.address || ""))}</code></td>
        <td>${esc(item.message)}</td>
        <td>${esc(item.status)}</td>
      </tr>`).join("") || '<tr><td colspan="5"><small>No open review items.</small></td></tr>'}
    </tbody></table></div></article>
    <article class="card full"><h3>One-time Discord approvals</h3><div class="table-wrap"><table><thead><tr><th>Created</th><th>Action</th><th>Target</th><th>Status</th><th>Expires</th></tr></thead><tbody>
      ${state.lifecycleRequests.map((item) => `<tr><td>${date(item.created_at)}</td><td>${esc(item.action)}</td><td>${esc(item.external_revenue_wallets?.domain || short(item.company_wallets?.address || ""))}</td><td>${esc(item.status)}</td><td>${date(item.expires_at)}</td></tr>`).join("") || '<tr><td colspan="5"><small>No lifecycle requests yet.</small></td></tr>'}
    </tbody></table></div></article>
  </div>`;
}

function webhooks() {
  return `<div class="grid two">
    <article class="card"><h3>Save Discord webhook</h3><p><small>Each event is configured separately. Webhook URLs are encrypted at rest.</small></p>
      <form id="route-form" class="stack">
        <label>Event<select name="kind">${routeKinds.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join("")}</select></label>
        <label>Name<input name="name" required /></label>
        <label>Discord webhook URL<input name="webhook_url" type="url" required /></label>
        <label><input name="mention_everyone" type="checkbox" /> Mention @everyone</label>
        <button>Encrypt and save route</button>
      </form></article>
    <article class="card"><h3>Configured routes</h3><div class="table-wrap"><table><thead><tr><th>Event</th><th>Name</th><th>@everyone</th><th>Action</th></tr></thead><tbody>
      ${state.notificationRoutes.map((item) => `<tr><td>${esc(item.kind)}</td><td>${esc(item.name)}</td><td>${item.mention_everyone ? "Yes" : "No"}</td><td><div class="actions"><button class="small ghost" data-test-route="${item.id}">Test</button><button class="small ghost danger" data-delete-route="${item.id}">Remove</button></div></td></tr>`).join("") || '<tr><td colspan="4"><small>No routes configured.</small></td></tr>'}
    </tbody></table></div></article></div>`;
}

function sourceActivityTable(items, type) {
  if (!items.length) return "<small>No records yet.</small>";
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Wallet</th><th>Status</th><th>Details</th></tr></thead><tbody>${items.slice(0, 20).map((item) => `<tr>
    <td>${date(item.created_at || item.scheduled_for)}</td>
    <td>${esc(item.external_revenue_wallets?.domain || short(item.company_wallets?.address || ""))}</td>
    <td>${esc(item.status || type)}</td>
    <td><code>${esc(short(item.signature || item.input_mint || item.recipient_kind || ""))}</code>${item.reason || item.error ? `<br /><small>${esc(item.reason || item.error)}</small>` : ""}</td>
  </tr>`).join("")}</tbody></table></div>`;
}

function activity() {
  return `<div class="grid two">
    <article class="card"><h3>Revenue deposits</h3>${sourceActivityTable(state.sourceDeposits, "deposit")}</article>
    <article class="card"><h3>Revenue swaps</h3>${sourceActivityTable(state.sourceSwaps, "swap")}</article>
    <article class="card"><h3>Revenue splits</h3>${sourceActivityTable(state.sourceSplits, "split")}</article>
    <article class="card"><h3>Company Privacy Cash</h3>${sourceActivityTable(state.companyWithdrawals, "withdrawal")}</article>
    <article class="card full"><h3>Audit trail</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead><tbody>
      ${state.auditLogs.map(item => `<tr><td>${date(item.created_at)}</td><td>${esc(item.actor_type)}: ${esc(item.actor_id)}</td><td>${esc(item.action)}</td><td>${esc(item.entity_type)} ${esc(short(item.entity_id))}</td></tr>`).join("")}
    </tbody></table></div></article></div>`;
}

function settings() {
  const s = state.settings;
  return `<article class="card"><h3>Global defaults and guardrails</h3><form id="settings-form" class="form-grid">
    <label>Company Privacy Cash threshold USD<input name="company_privacy_cash_threshold_usd" type="number" step="0.01" value="${esc(s.company_privacy_cash_threshold_usd)}" /></label>
    <label>Revenue wallet SOL reserve<input name="revenue_wallet_sol_reserve" type="number" step="0.000000001" value="${esc(s.revenue_wallet_sol_reserve)}" /></label>
    <label>Revenue dust threshold USD<input name="revenue_dust_threshold_usd" type="number" step="0.01" value="${esc(s.revenue_dust_threshold_usd)}" /></label>
    <label>Company wallet SOL reserve<input name="company_wallet_sol_reserve" type="number" step="0.000000001" value="${esc(s.company_wallet_sol_reserve)}" /></label>
    <label>Max price impact %<input name="max_price_impact_pct" type="number" step="0.0001" value="${esc(s.max_price_impact_pct)}" /></label>
    <label>Minimum organic score<input name="min_organic_score" type="number" step="0.0001" value="${esc(s.min_organic_score)}" /></label>
    <label>Privacy min delay hours<input name="privacy_min_delay_hours" type="number" min="24" step="1" value="${esc(s.privacy_min_delay_hours)}" /></label>
    <label>Privacy max delay hours<input name="privacy_max_delay_hours" type="number" min="24" step="1" value="${esc(s.privacy_max_delay_hours)}" /></label>
    <label>Company rotate after days<input name="company_rotation_long_days" type="number" min="1" step="1" value="${esc(s.company_rotation_long_days)}" /></label>
    <label>Company rotate after USD<input name="company_rotation_high_volume_usd" type="number" min="1" step="0.01" value="${esc(s.company_rotation_high_volume_usd)}" /></label>
    <label>Company combined days<input name="company_rotation_short_days" type="number" min="1" step="1" value="${esc(s.company_rotation_short_days)}" /></label>
    <label>Company combined USD<input name="company_rotation_lower_volume_usd" type="number" min="1" step="0.01" value="${esc(s.company_rotation_lower_volume_usd)}" /></label>
    <label>Owners Discord server ID<input name="owners_discord_guild_id" value="${esc(s.owners_discord_guild_id || "")}" /></label>
    <label>Owners notification channel ID<input name="owners_notifications_channel_id" value="${esc(s.owners_notifications_channel_id || "")}" /></label>
    <label>Manager role IDs<input name="discord_manager_role_ids" value="${esc((s.discord_manager_role_ids || []).join(","))}" placeholder="legacy comma-separated" /></label>
    <label>Staff role IDs<input name="discord_staff_role_ids" value="${esc((s.discord_staff_role_ids || []).join(","))}" placeholder="comma-separated" /></label>
    <label><input name="source_sync_enabled" type="checkbox" ${s.source_sync_enabled ? "checked" : ""}/> Enable external Telegram sync</label>
    <label><input name="swaps_enabled" type="checkbox" ${s.swaps_enabled ? "checked" : ""}/> Enable guarded SPL and USDC swaps</label>
    <label><input name="privacy_cash_enabled" type="checkbox" ${s.privacy_cash_enabled ? "checked" : ""}/> Enable company Privacy Cash</label>
    <label><input name="live_payouts_enabled" type="checkbox" ${s.live_payouts_enabled ? "checked" : ""}/> Enable live payouts</label>
    <label><input name="emergency_paused" type="checkbox" ${s.emergency_paused ? "checked" : ""}/> Emergency pause</label>
    <input type="hidden" name="global_threshold_usd" value="${esc(s.global_threshold_usd)}" />
    <input type="hidden" name="global_sol_reserve" value="${esc(s.global_sol_reserve)}" />
    <input type="hidden" name="min_swap_usd" value="${esc(s.min_swap_usd)}" />
    <input type="hidden" name="rotation_warn_after_days" value="${esc(s.rotation_warn_after_days)}" />
    <input type="hidden" name="rotation_warn_after_legs" value="${esc(s.rotation_warn_after_legs)}" />
    <input type="hidden" name="rotation_warn_after_usd" value="${esc(s.rotation_warn_after_usd)}" />
    <input type="hidden" name="rotation_warn_after_weekly_legs" value="${esc(s.rotation_warn_after_weekly_legs)}" />
    <button class="full">Save settings</button>
  </form></article>`;
}

function render() {
  renderNav();
  $("#system-status").textContent = state.settings.emergency_paused ? "PAUSED" :
    state.settings.live_payouts_enabled ? "LIVE" : "DRY RUN";
  $("#system-status").className = `status-pill ${state.settings.emergency_paused ? "bad" : state.settings.live_payouts_enabled ? "good" : "warn"}`;
  $("#content").innerHTML = ({ overview, revenue, company, privacy, review, webhooks, activity, security, settings }[page])();
}

async function load() {
  try {
    state = await api("/api/bootstrap");
    $("#login-dialog").close();
    clearPasswordInputs();
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

function syncDomainImportGroup() {
  const select = $("#domain-import-group");
  const fields = $("#domain-new-group-fields");
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
  dialog.querySelector("[name=dashboard_export_secret]").value = "";
  $("#wallet-private-key-label").textContent = wallet.label;
  dialog.showModal();
}

function openCompanyKeyAuthDialog(companyWalletId) {
  const dialog = $("#company-key-auth-dialog");
  dialog.querySelector("[name=company_wallet_id]").value = companyWalletId;
  dialog.querySelector("[name=dashboard_access_secret]").value = "";
  dialog.showModal();
}

function openCompanyRotateAuthDialog(companyWalletId) {
  const dialog = $("#company-rotate-auth-dialog");
  dialog.querySelector("[name=company_wallet_id]").value = companyWalletId;
  dialog.querySelector("[name=dashboard_access_secret]").value = "";
  dialog.showModal();
}

function openDomainEditDialog(domainId) {
  const domain = state.domains.find((item) => item.id === domainId);
  const dialog = $("#domain-edit-dialog");
  dialog.querySelector("[name=domain_id]").value = domain.id;
  dialog.querySelector("[name=domain]").value = domain.domain;
  dialog.querySelector("[name=domain_group_id]").innerHTML = domainGroupOptions(domain.domain_group_id || "");
  dialog.querySelector("[name=color_label]").value = validColor(domain.color_label, "#ff315f");
  dialog.showModal();
}

function openDomainGroupDialog(groupId) {
  const group = state.domainGroups.find((item) => item.id === groupId);
  const dialog = $("#domain-group-dialog");
  dialog.querySelector("[name=domain_group_id]").value = group.id;
  dialog.querySelector("[name=name]").value = group.name;
  dialog.querySelector("[name=color_label]").value = validColor(group.color_label, "#ff315f");
  dialog.showModal();
}

async function downloadAttachment(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status === 401) {
    showLoginDialog();
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
    try { await api("/api/login", { method: "POST", body: JSON.stringify({ password: values.dashboard_access_secret }) }); await load(); }
    catch (error) { $("#login-error").textContent = error.message; }
    finally { clearPasswordInputs(); }
  }
  if (event.target.id === "domain-form") {
    const creatingGroup = values.domain_group_id === "__new__";
    mutate("/api/domains/import", "POST", {
      domains: values.domains,
      color_label: values.color_label,
      domain_group_id: creatingGroup ? null : values.domain_group_id || null,
      ...(creatingGroup ? {
        new_group_name: values.new_group_name,
        new_group_color_label: values.new_group_color_label
      } : {})
    });
  }
  if (event.target.id === "domain-edit-form") {
    $("#domain-edit-dialog").close();
    mutate(`/api/domains/${values.domain_id}`, "PUT", {
      domain: values.domain,
      domain_group_id: values.domain_group_id || null,
      color_label: values.color_label
    });
  }
  if (event.target.id === "domain-group-form") {
    $("#domain-group-dialog").close();
    mutate(`/api/domain-groups/${values.domain_group_id}`, "PUT", {
      name: values.name,
      color_label: values.color_label
    });
  }
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
      clearPasswordInputs();
      return notice("Wallet label confirmation does not match.", "error");
    }
    try {
      await downloadAttachment(`/api/wallets/${wallet.id}/export-private-key`, { password: values.dashboard_export_secret });
      $("#wallet-private-key-dialog").close();
      clearPasswordInputs();
      notice("Private key downloaded. Store it securely and remove extra copies.");
      await load();
    } catch (error) {
      notice(error.message, "error");
    } finally {
      clearPasswordInputs();
    }
  }
  if (event.target.id === "company-key-auth-form") {
    try {
      const result = await api(`/api/company-wallets/${values.company_wallet_id}/reveal-private-key`, {
        method: "POST",
        body: JSON.stringify({ password: values.dashboard_access_secret })
      });
      $("#company-key-auth-dialog").close();
      const dialog = $("#company-key-dialog");
      dialog.querySelector("[name=company_private_key]").value = result.private_key;
      $("#company-key-address").textContent = result.address;
      dialog.showModal();
      notice("Company private key revealed. It was not sent through Discord.");
    } catch (error) {
      notice(error.message, "error");
    } finally {
      clearPasswordInputs();
    }
  }
  if (event.target.id === "company-rotate-auth-form") {
    try {
      const result = await api(`/api/company-wallets/${values.company_wallet_id}/rotate`, {
        method: "POST",
        body: JSON.stringify({ password: values.dashboard_access_secret })
      });
      $("#company-rotate-auth-dialog").close();
      notice(`Company wallet rotated. New active wallet: ${result.address}`);
      await load();
    } catch (error) {
      notice(error.message, "error");
    } finally {
      clearPasswordInputs();
    }
  }
  if (event.target.id === "route-form") mutate("/api/notification-routes", "POST", {
    ...values,
    team_id: null,
    enabled: true,
    mention_everyone: event.target.mention_everyone.checked
  });
  if (event.target.id === "website-form") mutate("/api/websites", "POST", {
    ...values,
    threshold_usd: optionalNumeric(values.threshold_usd), sol_reserve: optionalNumeric(values.sol_reserve)
  });
  if (event.target.id === "settings-form") mutate("/api/settings", "PUT", {
    global_threshold_usd: Number(values.global_threshold_usd), global_sol_reserve: Number(values.global_sol_reserve),
    company_privacy_cash_threshold_usd: Number(values.company_privacy_cash_threshold_usd),
    revenue_wallet_sol_reserve: Number(values.revenue_wallet_sol_reserve),
    revenue_dust_threshold_usd: Number(values.revenue_dust_threshold_usd),
    company_wallet_sol_reserve: Number(values.company_wallet_sol_reserve),
    company_rotation_long_days: Number(values.company_rotation_long_days),
    company_rotation_high_volume_usd: Number(values.company_rotation_high_volume_usd),
    company_rotation_short_days: Number(values.company_rotation_short_days),
    company_rotation_lower_volume_usd: Number(values.company_rotation_lower_volume_usd),
    source_sync_enabled: event.target.source_sync_enabled.checked,
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
  if (button.dataset.page) {
    page = button.dataset.page;
    if (page === "security") location.hash = "security";
    else if (location.hash) history.replaceState(null, "", location.pathname);
    render();
  }
  if (button.id === "logout") { await api("/api/logout", { method: "POST" }); location.reload(); }
  if (button.dataset.generateCompanyWallet !== undefined && confirm("Generate the initial company wallet? Store the private key securely after revealing it from the dashboard.")) {
    mutate("/api/company-wallets/generate-initial", "POST");
  }
  if (button.dataset.revealCompanyKey) {
    openCompanyKeyAuthDialog(button.dataset.revealCompanyKey);
  }
  if (button.dataset.rotateCompanyWallet) {
    openCompanyRotateAuthDialog(button.dataset.rotateCompanyWallet);
  }
  if (button.id === "company-key-auth-cancel") { $("#company-key-auth-dialog").close(); clearPasswordInputs(); }
  if (button.id === "company-rotate-auth-cancel") { $("#company-rotate-auth-dialog").close(); clearPasswordInputs(); }
  if (button.id === "company-key-copy") {
    const value = $("#company-key-dialog").querySelector("[name=company_private_key]").value;
    await navigator.clipboard.writeText(value);
    notice("Company private key copied.");
  }
  if (button.id === "company-key-close") {
    $("#company-key-dialog").querySelector("[name=company_private_key]").value = "";
    $("#company-key-dialog").close();
  }
  if (button.dataset.archiveDomain && confirm("Archive this domain?")) mutate(`/api/domains/${button.dataset.archiveDomain}/archive`, "POST");
  if (button.dataset.restoreDomain && confirm("Restore this domain to the active list?")) mutate(`/api/domains/${button.dataset.restoreDomain}`, "PUT", { status: "pool" });
  if (button.dataset.deleteDomain && confirm("Permanently delete this domain? Domains with website history must be archived instead.")) mutate(`/api/domains/${button.dataset.deleteDomain}`, "DELETE");
  if (button.dataset.editDomain) openDomainEditDialog(button.dataset.editDomain);
  if (button.dataset.editDomainGroup) openDomainGroupDialog(button.dataset.editDomainGroup);
  if (button.dataset.domainMode) { domainMode = button.dataset.domainMode; render(); }
  if (button.dataset.archiveWebsite && confirm("Archive this website and domain?")) mutate(`/api/websites/${button.dataset.archiveWebsite}`, "DELETE");
  if (button.dataset.releaseDomain && confirm("Return this archived domain to the assignment pool? Its existing website history will be preserved.")) mutate(`/api/websites/${button.dataset.releaseDomain}/release-domain`, "POST");
  if (button.dataset.archiveManager && confirm("Archive this manager?")) mutate(`/api/managers/${button.dataset.archiveManager}`, "DELETE");
  if (button.dataset.archiveTeam && confirm("Archive this team?")) mutate(`/api/teams/${button.dataset.archiveTeam}`, "PUT", { active: false });
  if (button.dataset.archiveWallet && confirm("Archive this revenue wallet? Existing website assignments will remain active until changed.")) mutate(`/api/wallets/${button.dataset.archiveWallet}`, "DELETE");
  if (button.dataset.restoreWallet && confirm("Restore this revenue wallet to the active list?")) mutate(`/api/wallets/${button.dataset.restoreWallet}`, "PUT", { active: true });
  if (button.dataset.editWallet) openWalletEditDialog(button.dataset.editWallet);
  if (button.dataset.editWalletGroup) openWalletGroupDialog(button.dataset.editWalletGroup);
  if (button.dataset.exportPrivateKey) openPrivateKeyDialog(button.dataset.exportPrivateKey);
  if (button.dataset.walletMode) { walletMode = button.dataset.walletMode; render(); }
  if (button.dataset.requestReconciliation !== undefined && confirm("Run the normal guarded Privacy Cash reconciliation now? Existing pauses, thresholds, locks, and idempotency checks remain enforced.")) {
    mutate("/api/reconciliation-requests", "POST");
  }
  if (button.dataset.revokeAllSessions !== undefined && confirm("Revoke every dashboard session, including this browser?")) {
    try {
      await api("/api/sessions/revoke-all", { method: "POST" });
      location.reload();
    } catch (error) {
      notice(error.message, "error");
    }
  }
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
  if (button.id === "wallet-private-key-cancel") { $("#wallet-private-key-dialog").close(); clearPasswordInputs(); }
  if (button.id === "domain-edit-cancel") $("#domain-edit-dialog").close();
  if (button.id === "domain-group-cancel") $("#domain-group-dialog").close();
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
    const usedWalletIds = new Set(state.websites.filter(w => w.active && w.id !== website.id).map(w => w.revenue_wallet_id));
    const wallets = state.wallets.filter(w => w.active && !usedWalletIds.has(w.id)).map(w => `${w.label}: ${w.id}`).join("\n");
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
  if (event.target.id === "domain-import-group") syncDomainImportGroup();
  if (event.target.dataset.hosted) {
    mutate(`/api/websites/${event.target.dataset.hosted}`, "PUT", { hosted: event.target.checked });
  }
});

renderNav();
clearPasswordInputs();
window.addEventListener("pageshow", clearPasswordInputs);
setTimeout(clearPasswordInputs, 0);
load();
