import { AGENT, computeLoad, loadOf, tone, meterScale, sortRoster, sortForAssign, ago, shortRepo, parseItemUrl, loginPattern, repoPattern } from "/model.mjs";
import { ICONS } from "/icons.mjs";
import { sanitizeHtml } from "/markdown.mjs";

const $ = id => document.getElementById(id);
const root = document.documentElement;
const nonce = document.querySelector('meta[name="team-load-nonce"]').content;
const icon = (name, cls = "") => `<svg class="octicon ${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const keyOf = item => `${item.repository}#${item.number}`;
const splitKey = key => { const i = key.lastIndexOf("#"); return { repository: key.slice(0, i), number: Number(key.slice(i + 1)) }; };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const firstName = person => person.agent ? "Copilot" : (person.name || person.login).split(" ")[0];

// ---- Theme ----
const media = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
    if (root.hasAttribute("data-theme-locked")) return;
    root.dataset.theme = media.matches ? "dark" : "light";
}
applyTheme();
media.addEventListener("change", () => { applyTheme(); paintLabels(document); });

// ---- Server ----
async function post(action, input = {}) {
    const response = await fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json", "x-team-load-nonce": nonce },
        body: JSON.stringify({ action, input }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(body.error || `Request failed (${response.status}).`);
        error.code = body.code;
        throw error;
    }
    return body;
}

// ---- State ----
let S = null;           // server state
let people = [];        // computed roster
let byLogin = new Map();
let unowned = [];
let directory = new Map();
const openRows = new Set();
let openPicker = null;  // item key
let pickQ = "";
const busy = new Set(); // item keys mid-write
let lastError = null;

function compute() {
    if (!S) return;
    directory = new Map(S.directory.people.map(p => [p.login, p]));
    const profiles = Object.fromEntries(S.directory.people.map(p => [p.login, p]));
    const load = computeLoad({ items: S.items, people: S.tracking.people, profiles });
    people = load.people;
    byLogin = new Map(people.map(p => [p.login, p]));
    unowned = load.unowned;
}

const limit = () => S?.limit ?? 6;
const scale = () => meterScale(people.map(p => p.items.length), limit());
const repoLoading = () => S && S.tracking.repos.some(r => (S.repoStatus[r]?.status ?? "loading") === "loading");

// ---- Pieces ----
function avatarHTML(person, size = 32) {
    if (person.agent) return `<span class="avatar avatar--agent avatar-${size}">${icon("copilot")}</span>`;
    const initials = (person.name || person.login).split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();
    const src = person.avatarUrl || `https://avatars.githubusercontent.com/${encodeURIComponent(person.login)}?s=64`;
    return `<img class="avatar avatar-${size}" width="${size}" height="${size}" src="${esc(src)}" alt="" data-initials="${esc(initials)}">`;
}
document.addEventListener("error", event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.initials) return;
    const span = document.createElement("span");
    span.className = `${img.className} avatar--initials`;
    span.textContent = img.dataset.initials;
    img.replaceWith(span);
}, true);

function meterHTML(person, s) {
    const n = person.items.length;
    const t = tone(n, { agent: person.agent, limit: limit() });
    let cells = "";
    for (let i = 1; i <= s; i++) cells += `<span class="cell${i <= n ? " on" : ""}${i === limit() ? " is-limit" : ""}"></span>`;
    return `<span class="meter tone-${t.key}" aria-hidden="true">${cells}</span>`;
}

function labelHTML(label) {
    return `<span class="IssueLabel" data-color="${esc(label.color)}">${esc(label.name)}</span>`;
}
function paintLabels(scope) {
    const dark = root.dataset.theme === "dark";
    for (const el of scope.querySelectorAll(".IssueLabel[data-color]")) {
        const hex = el.dataset.color;
        const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        el.style.setProperty("background", dark ? `rgba(${r},${g},${b},.18)` : `#${hex}`);
        el.style.setProperty("color", dark ? `rgb(${Math.min(255, r + 60)},${Math.min(255, g + 60)},${Math.min(255, b + 60)})` : lum > 0.6 ? "#1f2328" : "#fff");
        el.style.setProperty("border-color", dark ? `rgba(${r},${g},${b},.3)` : "transparent");
    }
}

function kindIcon(item) {
    if (item.kind === "issue") return icon("issue-opened", "ic-issue");
    if (item.kind === "review") return icon("eye", "ic-review");
    return item.isDraft ? icon("git-pull-request-draft", "ic-draft") : icon("git-pull-request", "ic-pr");
}

// ---- Render: header ----
function renderMeta() {
    const np = S.tracking.people.length, nr = S.tracking.repos.length;
    const btn = $("scope-btn");
    btn.innerHTML = `${icon("people")}<b>${np}</b> ${np === 1 ? "person" : "people"}<span class="sep">·</span>${icon("repo")}<b>${nr}</b> ${nr === 1 ? "repo" : "repos"}${icon("triangle-down")}`;
    btn.setAttribute("aria-label", `Tracking ${np} people and ${nr} repos. Change`);
    const time = S.updatedAt ? new Date(S.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    $("updated").textContent = S.refreshing ? " · Updating…" : time ? ` · Updated ${time}` : "";
    const refresh = $("refresh");
    refresh.classList.toggle("is-spinning", !!S.refreshing);
    refresh.disabled = !!S.refreshing;

    const humans = people.filter(p => !p.agent);
    const free = humans.filter(p => p.items.length === 0).map(firstName);
    const over = humans.filter(p => p.items.length > limit()).map(firstName);
    const parts = [];
    if (!repoLoading()) {
        if (free.length) parts.push(`<span><i class="dot dot-free"></i><b>${esc(free.join(", "))}</b> free</span>`);
        if (over.length) parts.push(`<span><i class="dot dot-over"></i><b>${esc(over.join(", "))}</b> over limit</span>`);
    }
    $("insight").innerHTML = parts.join("");

    const failed = S.tracking.repos.filter(r => ["error", "stale"].includes(S.repoStatus[r]?.status));
    const notice = $("notice");
    const messages = [];
    if (lastError) messages.push(esc(lastError));
    for (const r of failed) messages.push(`<b>${esc(shortRepo(r))}</b>: ${esc(S.repoStatus[r].error?.message || "couldn’t load")}${S.repoStatus[r].fetchedAt ? " (showing last good data)" : ""}`);
    notice.hidden = !messages.length;
    notice.innerHTML = messages.length ? `${icon("alert")}<div>${messages.join("<br>")}</div>` : "";
}

// ---- Render: roster ----
function skeletonRows(n) {
    return Array.from({ length: n }, () => `<li class="skel-row" aria-hidden="true"><span class="skeleton round"></span><span class="skeleton"></span><span class="skeleton"></span></li>`).join("");
}

function renderRoster() {
    const el = $("roster");
    const loading = !S.items.length && repoLoading();
    el.setAttribute("aria-busy", String(!!loading));
    if (!people.length) {
        el.innerHTML = `<li class="all-clear"><strong>No one tracked</strong><span>Add people from the tracking menu above.</span></li>`;
        return;
    }
    if (loading) { el.innerHTML = skeletonRows(Math.min(people.length, 6)); return; }
    const s = scale();
    el.innerHTML = sortRoster(people).map(p => {
        const n = p.items.length;
        const t = tone(n, { agent: p.agent, limit: limit() });
        const open = openRows.has(p.login);
        const latest = p.items[0];
        const counts = { issue: 0, pr: 0, review: 0 };
        p.items.forEach(i => counts[i.kind]++);
        const id = `d-${p.login}`;
        return `<li class="person${p.agent ? " is-agent" : ""}${open ? " is-open" : ""}" data-login="${esc(p.login)}">
      <button class="person-row" type="button" aria-expanded="${open}" aria-controls="${id}"
        aria-label="${esc(p.name)}, ${plural(n, "open item")}, ${esc(t.label)}">
        ${avatarHTML(p)}
        <span class="who"><span class="name">${esc(p.name)}</span><span class="state tone-${t.key}">${esc(t.label)}</span></span>
        ${meterHTML(p, s)}
        <span class="count${n ? "" : " is-zero"}">${n}</span>
        <span class="now">${latest ? `<span class="num">#${latest.number}</span> <span class="t">${esc(latest.title)}</span>` : "Nothing assigned"}</span>
        ${icon("chevron-down", "chev")}
      </button>
      <div class="detail" id="${id}" ${open ? "" : "hidden"}>
        ${n ? `<div class="mix">
          ${counts.issue ? `<span>${icon("issue-opened")} ${plural(counts.issue, "issue")}</span>` : ""}
          ${counts.pr ? `<span>${icon("git-pull-request")} ${counts.pr} PR${counts.pr === 1 ? "" : "s"}</span>` : ""}
          ${counts.review ? `<span>${icon("eye")} ${plural(counts.review, "review")}</span>` : ""}
        </div>
        <ul class="items">${p.items.map(i => `<li><a class="item" href="${esc(i.url)}" data-item="${esc(keyOf(i))}">
          ${kindIcon(i)}
          <span class="item-title">${esc(i.title)}</span>
          <span class="item-meta">${esc(shortRepo(i.repository))} #${i.number} · ${ago(i.updatedAt)}</span></a></li>`).join("")}</ul>`
            : `<div class="empty-note">${p.agent ? "No agent sessions running." : "Nothing on their plate right now."}</div>`}
      </div>
    </li>`;
    }).join("");
}

// ---- Render: triage + assign popover ----
function pickListHTML(key) {
    const s = scale();
    const q = pickQ.trim().replace(/^@/, "").toLowerCase();
    const match = p => !q || `${p.login} ${p.name}`.toLowerCase().includes(q);
    const { humans, agent } = sortForAssign(people);
    const row = (p, sub) => {
        const t = tone(p.items.length, { agent: p.agent, limit: limit() });
        return `<li><button class="pick" type="button" data-assign="${esc(p.login)}" data-key="${esc(key)}" aria-label="Assign to ${esc(p.name)}, ${p.items.length} open, ${esc(t.label)}">
      ${avatarHTML(p, 20)}
      <span class="pick-name"><span class="n">${esc(p.name)}${sub ? ` <small>${sub}</small>` : ""}</span></span>
      ${meterHTML(p, s)}<span class="pick-count tone-${t.key}">${p.items.length}</span></button></li>`;
    };
    let html = humans.filter(match).map(p => row(p)).join("");
    if (agent && match(agent)) html += `<li class="pick-sep" role="presentation"></li>${row(agent, "agent")}`;
    if (!q || "start a session myself me".includes(q)) html += `<li class="pick-sep" role="presentation"></li><li><button class="pick pick-plain" type="button" data-session="${esc(key)}">${icon("play")}<span class="pick-name"><span class="n">Start a session myself</span></span></button></li>`;
    return html || `<li class="sp-empty">No one matches</li>`;
}
function pickerHTML(key) {
    return `<div class="picker" role="dialog" aria-label="Assign" data-key="${esc(key)}">
    <div class="picker-head">Assign to · lightest load first</div>
    <div class="sp-search">${icon("search")}<input class="pick-q" type="text" placeholder="Filter people" aria-label="Filter people" autocomplete="off" value="${esc(pickQ)}"></div>
    <ul class="pick-list">${pickListHTML(key)}</ul>
  </div>`;
}

function renderTriage() {
    const el = $("tickets");
    const loading = !S.items.length && repoLoading();
    el.setAttribute("aria-busy", String(!!loading));
    $("triage-count").textContent = loading ? "" : unowned.length;
    if (loading) { el.innerHTML = skeletonRows(3); return; }
    if (!unowned.length) {
        el.innerHTML = `<li class="all-clear">${icon("check-circle")}<strong>Everything has an owner</strong><span>New unassigned work will show up here.</span></li>`;
        return;
    }
    el.innerHTML = unowned.map(it => {
        const key = keyOf(it);
        const open = openPicker === key;
        return `<li class="ticket${open ? " is-picking" : ""}${busy.has(key) ? " is-busy" : ""}" data-key="${esc(key)}">
      ${icon("issue-opened")}
      <div class="ticket-body">
        <a class="ticket-title" href="${esc(it.url)}" data-item="${esc(key)}" title="${esc(it.title)}">${esc(it.title)}</a>
        <div class="ticket-meta"><span>${esc(shortRepo(it.repository))} #${it.number} · ${ago(it.updatedAt)}</span>${it.labels.slice(0, 2).map(labelHTML).join("")}</div>
      </div>
      <div class="ticket-actions">
        <button class="btn-icon tip is-assign" type="button" data-open-picker="${esc(key)}" aria-expanded="${open}" aria-label="Assign">${icon("person-add")}</button>
        <button class="btn-icon tip" type="button" data-assign="${AGENT}" data-key="${esc(key)}" aria-label="Assign to Copilot">${icon("copilot")}</button>
      </div>
      ${open ? pickerHTML(key) : ""}
    </li>`;
    }).join("");
    paintLabels(el);
    wirePicker(el);
}

function wirePicker(scope) {
    const input = scope.querySelector(".picker .pick-q");
    if (!input) return;
    const list = input.closest(".picker").querySelector(".pick-list");
    const key = input.closest(".picker").dataset.key;
    input.addEventListener("input", e => { pickQ = e.target.value; list.innerHTML = pickListHTML(key); });
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); list.querySelector(".pick")?.click(); }
        if (e.key === "ArrowDown") { e.preventDefault(); list.querySelector(".pick")?.focus(); }
    });
}

// Hide the "current item" column when it would be too narrow to read.
function fitNow() {
    const r = $("roster");
    r.classList.remove("no-now");
    const now = r.querySelector(".now");
    if (now && getComputedStyle(now).display !== "none" && now.getBoundingClientRect().width < 200) r.classList.add("no-now");
}
new ResizeObserver(() => fitNow()).observe($("roster"));

function renderAll() {
    if (!S) return;
    compute();
    renderMeta();
    renderRoster();
    renderTriage();
    fitNow();
    if (scope.open) renderScope();
    if (route.item) renderDetailSide();
}

// ---- Data loading ----
let pollTimer = null;
let autoTimer = null;
async function load(action = "get_state", input = {}) {
    try {
        const next = await post(action, input);
        if (!S || next.revision !== S.revision || next.refreshing !== S.refreshing || action !== "get_state") { S = next; renderAll(); }
        lastError = null;
    } catch (error) {
        lastError = error.message;
        if (S) renderMeta(); else showFatal(error.message);
    }
    schedule();
}
function schedule() {
    clearTimeout(pollTimer);
    clearTimeout(autoTimer);
    if (S?.refreshing) { pollTimer = setTimeout(() => load(), 1500); return; }
    const seconds = Math.max(60, S?.refreshSeconds ?? 300);
    autoTimer = setTimeout(() => { if (document.visibilityState === "visible") load("refresh", {}); else schedule(); }, seconds * 1000);
}
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S?.updatedAt && Date.now() - new Date(S.updatedAt) > (S.refreshSeconds ?? 300) * 1000) load("refresh", {});
});
function showFatal(message) {
    $("roster").innerHTML = `<li class="all-clear">${icon("alert")}<strong>Couldn’t load team data</strong><span>${esc(message)}</span></li>`;
    $("tickets").innerHTML = "";
    $("notice").hidden = true;
}

// ---- Toast ----
let toastTimer;
let undoAction = null;
function toast(html, { undo = null, error = false } = {}) {
    const el = $("toast");
    undoAction = undo;
    el.classList.toggle("is-error", error);
    el.innerHTML = `${icon(error ? "alert" : "check")}<span>${html}</span>${undo ? `<button type="button" id="undo">Undo</button>` : ""}`;
    el.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove("is-on"); undoAction = null; }, error ? 7000 : 6000);
}
function hideToast() { $("toast").classList.remove("is-on"); undoAction = null; }

function flash(login) {
    const li = document.querySelector(`.person[data-login="${CSS.escape(login)}"]`);
    if (!li) return;
    li.classList.add("is-flash");
    setTimeout(() => li.classList.remove("is-flash"), 900);
}

// ---- Writes ----
async function assign(key, login, { session = false } = {}) {
    if (busy.has(key)) return;
    const ref = splitKey(key);
    const item = unowned.find(i => keyOf(i) === key);
    const who = login === AGENT ? "Copilot" : directory.get(login)?.name || login;
    busy.add(key);
    openPicker = null;
    renderTriage();
    renderDetailSide();
    try {
        const result = session
            ? await post("start_session", { ...ref, title: item?.title ?? "" })
            : await post("assign", { ...ref, login });
        S = result.state;
        busy.delete(key);
        renderAll();
        const assignee = result.login ?? login;
        flash(assignee);
        const msg = session ? `Session started on <b>#${ref.number}</b>` : login === AGENT ? `Copilot is on <b>#${ref.number}</b>` : `<b>#${ref.number}</b> → ${esc(who)}`;
        toast(msg, { undo: () => unassign(key, assignee) });
        if (route.item === key) openDetail(key, { replace: true, quiet: true });
    } catch (error) {
        busy.delete(key);
        toast(esc(error.message), { error: true });
        await load(error.code === "conflict" ? "refresh" : "get_state", error.code === "conflict" ? { force: true } : {});
    }
}
async function unassign(key, login) {
    hideToast();
    busy.add(key);
    renderTriage();
    try {
        const result = await post("unassign", { ...splitKey(key), login });
        S = result.state;
        busy.delete(key);
        renderAll();
        toast(`Undid assignment on <b>#${splitKey(key).number}</b>`);
        if (route.item === key) openDetail(key, { replace: true, quiet: true });
    } catch (error) {
        busy.delete(key);
        renderTriage();
        toast(esc(error.message), { error: true });
    }
}

// ---- Scope picker (persisted tracking) ----
const scope = { open: false, tab: "people", q: "", order: [], keep: new Set(), saving: false };
const tracked = tab => new Set(tab === "people" ? S.tracking.people : S.tracking.repos);
const dirIds = tab => tab === "people" ? S.directory.people.map(p => p.login) : S.directory.repos.map(r => r.nameWithOwner);

function snapshotOrder() {
    const set = tracked(scope.tab);
    scope.order = dirIds(scope.tab).sort((a, b) => set.has(b) - set.has(a));
    scope.keep = new Set(set);
}

function optHTML(id, set) {
    const on = set.has(id);
    if (scope.tab === "people") {
        const p = directory.get(id) ?? { login: id, name: id };
        const n = loadOf(S.items, id);
        return `<li><button class="opt" type="button" role="option" aria-checked="${on}" data-toggle="${esc(id)}"${scope.saving ? " disabled" : ""}>
      <span class="check">${icon("check")}</span>${avatarHTML(p, 20)}
      <span class="opt-name">${esc(p.name || id)}${p.agent ? "" : `<small>${esc(id)}</small>`}</span>
      <span class="opt-meta">${n ? `${n} open` : ""}</span></button></li>`;
    }
    const repo = S.directory.repos.find(r => r.nameWithOwner === id);
    const [own, name] = id.split("/");
    const meta = repo?.open == null ? "" : repo.open ? `${repo.open} open` : "No open items";
    return `<li><button class="opt" type="button" role="option" aria-checked="${on}" data-toggle="${esc(id)}"${scope.saving ? " disabled" : ""}>
    <span class="check">${icon("check")}</span>${icon("repo", "repo-ic")}
    <span class="opt-name">${esc(name)}<small>${esc(own)}</small></span>
    <span class="opt-meta">${meta}</span></button></li>`;
}

function renderScope() {
    const people = scope.tab === "people";
    for (const t of ["people", "repos"]) {
        const b = $(`tab-${t}`);
        b.setAttribute("aria-selected", String(scope.tab === t));
        b.innerHTML = `${t === "people" ? "People" : "Repos"} <span class="Counter">${tracked(t).size}</span>`;
    }
    const input = $("scope-q");
    input.placeholder = people ? "Filter or add a GitHub user" : "Filter or add owner/repo";
    input.setAttribute("aria-label", input.placeholder);
    const set = tracked(scope.tab);
    const q = scope.q.trim().replace(/^@/, "").toLowerCase();
    const label = id => people ? `${id} ${directory.get(id)?.name ?? ""}` : id;
    const ids = scope.order.filter(id => !q || label(id).toLowerCase().includes(q));
    const on = ids.filter(id => scope.keep.has(id));
    const off = ids.filter(id => !scope.keep.has(id));
    let html = "";
    const exists = scope.order.some(id => id.toLowerCase() === q);
    if (q && !exists && (people ? loginPattern.test(q) : repoPattern.test(q))) {
        html += `<li><button class="opt is-add" type="button" data-add="${esc(q)}"${scope.saving ? " disabled" : ""}>${icon("plus")}<span class="opt-name">Add ${people ? "@" : ""}${esc(q)}</span></button></li>`;
    }
    if (on.length) html += `<li class="sp-group" role="presentation">Tracking</li>${on.map(id => optHTML(id, set)).join("")}`;
    if (off.length) html += `<li class="sp-group" role="presentation">${people ? "Suggested · repo collaborators" : "Available"}</li>${off.map(id => optHTML(id, set)).join("")}`;
    if (!html) html = `<li class="sp-empty">No matches</li>`;
    $("scope-list").innerHTML = html;
}

function openScope(tab = scope.tab) {
    if (!S) return;
    Object.assign(scope, { open: true, tab, q: "" });
    snapshotOrder();
    $("scope-q").value = "";
    $("scope-status").textContent = "";
    $("scope").hidden = false;
    $("scope-backdrop").hidden = false;
    $("scope-btn").setAttribute("aria-expanded", "true");
    renderScope();
    if (!matchMedia("(max-width: 600px)").matches) $("scope-q").focus();
}
function closeScope() {
    if (!scope.open) return;
    scope.open = false;
    $("scope").hidden = true;
    $("scope-backdrop").hidden = true;
    $("scope-btn").setAttribute("aria-expanded", "false");
    $("scope-btn").focus();
}

async function saveTracking(tab, ids, { added = null } = {}) {
    const status = $("scope-status");
    scope.saving = true;
    status.classList.remove("is-error");
    status.textContent = added ? `Checking ${added}…` : "Saving…";
    renderScope();
    try {
        const next = tab === "people" ? { people: ids, repos: S.tracking.repos } : { people: S.tracking.people, repos: ids };
        S = await post("set_tracking", next);
        status.textContent = "";
        if (added) { scope.keep.add(S.tracking[tab].find(id => id.toLowerCase() === added.toLowerCase()) ?? added); scope.order = dirIds(tab).sort((a, b) => scope.keep.has(b) - scope.keep.has(a)); }
    } catch (error) {
        status.classList.add("is-error");
        status.textContent = error.message;
    } finally {
        scope.saving = false;
        renderAll();
        schedule();
    }
}
function toggleTracked(id) {
    const set = tracked(scope.tab);
    if (set.has(id)) set.delete(id); else { set.add(id); scope.keep.add(id); }
    saveTracking(scope.tab, [...set]).then(() => document.querySelector(`[data-toggle="${CSS.escape(id)}"]`)?.focus());
}
function addTracked(id) {
    const set = tracked(scope.tab);
    set.add(id);
    scope.q = "";
    $("scope-q").value = "";
    saveTracking(scope.tab, [...set], { added: id }).then(() => $("scope-q").focus());
}
$("scope-q").addEventListener("input", e => { scope.q = e.target.value; renderScope(); });
$("scope-q").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); document.querySelector("#scope-list .opt:not(:disabled)")?.click(); }
    if (e.key === "ArrowDown") { e.preventDefault(); document.querySelector("#scope-list .opt")?.focus(); }
});
$("scope-backdrop").addEventListener("click", closeScope);

// ---- Detail view (issue / PR inside the canvas) ----
const route = { item: null, data: null, token: 0 };
const detailEl = $("detail");
const homeEl = $("home");

function parseHash() {
    const m = /^#item\/([^/]+)\/([^/]+)\/(\d+)$/.exec(location.hash);
    return m ? `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}#${m[3]}` : null;
}
function hashFor(key) {
    const { repository, number } = splitKey(key);
    const [o, n] = repository.split("/");
    return `#item/${encodeURIComponent(o)}/${encodeURIComponent(n)}/${number}`;
}
let homeScroll = 0;
let cameFromHome = false;
function openDetail(key, { replace = false, quiet = false } = {}) {
    if (!quiet) {
        if (!route.item) { homeScroll = scrollY; cameFromHome = true; }
        const target = hashFor(key);
        if (location.hash !== target) { replace ? history.replaceState(null, "", target) : history.pushState(null, "", target); }
    }
    showRoute(quiet);
}
function goBack() {
    if (cameFromHome && history.length > 1) history.back();
    else { history.replaceState(null, "", location.pathname + location.search); showRoute(); }
}
addEventListener("popstate", () => showRoute());
addEventListener("hashchange", () => showRoute());

function stateBadge(d) {
    if (d.kind === "pr") {
        if (d.state === "merged") return `<span class="State State--merged">${icon("git-merge")}Merged</span>`;
        if (d.state === "closed") return `<span class="State State--prclosed">${icon("git-pull-request-closed")}Closed</span>`;
        if (d.isDraft) return `<span class="State State--draft">${icon("git-pull-request-draft")}Draft</span>`;
        return `<span class="State State--open">${icon("git-pull-request")}Open</span>`;
    }
    if (d.state === "closed") return d.stateReason === "NOT_PLANNED"
        ? `<span class="State State--notplanned">${icon("skip")}Closed</span>`
        : `<span class="State State--closed">${icon("issue-closed")}Closed</span>`;
    return `<span class="State State--open">${icon("issue-opened")}Open</span>`;
}

function peopleList(list, empty) {
    if (!list.length) return `<span class="side-empty">${empty}</span>`;
    return `<ul class="side-people">${list.map(p => `<li>${avatarHTML({ ...p, name: p.name || p.login }, 20)}<span class="n">${esc(p.agent ? "Copilot" : p.login)}</span></li>`).join("")}</ul>`;
}

function renderDetailSide() {
    const side = detailEl.querySelector(".dv-side");
    const d = route.data;
    if (!side || !d) return;
    const key = route.item;
    const isUnowned = d.kind === "issue" && d.state === "open" && !d.assignees.length && S?.tracking.repos.some(r => r.toLowerCase() === d.repository.toLowerCase());
    const pickerOpen = openPicker === `detail:${key}`;
    side.innerHTML = `
      ${isUnowned ? `<div class="side-sec"><h3>Assign</h3><div class="side-actions">
        <button class="btn" type="button" data-open-picker="detail:${esc(key)}" aria-expanded="${pickerOpen}"${busy.has(key) ? " disabled" : ""}>${icon("person-add")}Assign</button>
        <button class="btn" type="button" data-assign="${AGENT}" data-key="${esc(key)}"${busy.has(key) ? " disabled" : ""}>${icon("copilot")}Copilot</button>
        ${pickerOpen ? pickerHTML(key) : ""}
      </div></div>` : ""}
      <div class="side-sec"><h3>Assignees</h3>${peopleList(d.assignees, "No one assigned")}</div>
      <div class="side-sec"><h3>Labels</h3>${d.labels.length ? `<div class="side-labels">${d.labels.map(labelHTML).join("")}</div>` : `<span class="side-empty">None yet</span>`}</div>`;
    paintLabels(side);
    wirePicker(side);
}

function commentHTML(c, first = false) {
    const who = c.author ? (c.author.agent ? "Copilot" : c.author.login) : "ghost";
    return `<article class="comment${first ? " is-first" : ""}">
      <header class="comment-head">${avatarHTML({ ...(c.author ?? { login: "ghost" }), name: who }, 20)}<b>${esc(who)}</b>${first ? "opened" : "commented"}<span class="when" title="${esc(new Date(c.createdAt).toLocaleString())}">${ago(c.createdAt)} ago</span></header>
      <div class="comment-body markdown-body" data-html-slot></div>
    </article>`;
}

function fill(slot, html) {
    if (!html.trim()) { slot.innerHTML = `<p class="no-desc">No description provided.</p>`; return; }
    slot.replaceChildren(sanitizeHtml(html, { parseItemUrl }));
}

function renderDetail() {
    const d = route.data;
    const { repository, number } = splitKey(route.item);
    const bar = `<div class="dv-bar">
      <button class="btn btn-invisible" type="button" id="dv-back">${icon("arrow-left")}Back</button>
      <span class="crumb">${esc(repository)} #${number}</span>
      <a class="btn" href="${esc(d?.url ?? `https://github.com/${repository}/${"issues"}/${number}`)}" target="_blank" rel="noopener noreferrer">${icon("link-external")}<span>Open on GitHub</span></a>
    </div>`;
    if (!d) {
        detailEl.innerHTML = `${bar}<div class="dv-loading" aria-busy="true"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>`;
        return;
    }
    if (d.error) {
        detailEl.innerHTML = `${bar}<div class="dv-error">${icon("alert")} ${esc(d.error)}</div>`;
        return;
    }
    const comments = d.comments.nodes;
    const hidden = Math.max(0, d.comments.total - comments.length);
    detailEl.innerHTML = `${bar}
      <h1 class="dv-title">${esc(d.title)} <span class="num">#${d.number}</span></h1>
      <div class="dv-sub">${stateBadge(d)}<span><b>${esc(d.author ? (d.author.agent ? "Copilot" : d.author.login) : "ghost")}</b> opened ${ago(d.createdAt)} ago · ${plural(d.comments.total, "comment")}</span></div>
      <div class="dv-layout">
        <aside class="dv-side" aria-label="Details"></aside>
        <div class="dv-main">
          ${commentHTML({ author: d.author, createdAt: d.createdAt }, true)}
          ${hidden ? `<div class="more-comments">${icon("comment")}<span>${plural(hidden, "earlier comment")} on <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">GitHub</a></span></div>` : ""}
          ${comments.map(c => commentHTML(c)).join("")}
        </div>
      </div>`;
    const slots = detailEl.querySelectorAll("[data-html-slot]");
    fill(slots[0], d.bodyHTML);
    comments.forEach((c, i) => fill(slots[i + 1], c.bodyHTML));
    renderDetailSide();
}

async function showRoute(quiet = false) {
    const key = parseHash();
    if (!key) {
        if (!route.item) return;
        route.item = null; route.data = null;
        if (openPicker?.startsWith("detail:")) openPicker = null;
        detailEl.hidden = true; detailEl.innerHTML = "";
        homeEl.hidden = false;
        scrollTo(0, homeScroll);
        cameFromHome = false;
        return;
    }
    const changed = route.item !== key;
    route.item = key;
    if (changed) { route.data = null; openPicker = null; }
    homeEl.hidden = true;
    detailEl.hidden = false;
    closeScope();
    if (!quiet || changed) { renderDetail(); if (changed) { scrollTo(0, 0); $("dv-back")?.focus(); } }
    const token = ++route.token;
    try {
        const data = await post("get_item", splitKey(key));
        if (token !== route.token) return;
        route.data = data;
    } catch (error) {
        if (token !== route.token) return;
        route.data = route.data && !route.data.error ? route.data : { error: error.message };
    }
    renderDetail();
}

// ---- Events ----
document.addEventListener("click", event => {
    const link = event.target.closest("a[data-item]");
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
        event.preventDefault();
        const item = link.dataset.item;
        if (openPicker && !openPicker.startsWith("detail:")) openPicker = null;
        openDetail(item);
        return;
    }
    if (openPicker && !event.target.closest(".picker") && !event.target.closest("[data-open-picker]")) {
        openPicker = null;
        if (route.item) renderDetailSide(); else renderTriage();
    }
    const t = event.target.closest("button");
    if (!t || t.disabled) return;
    if (t.id === "undo") { const fn = undoAction; if (fn) fn(); return; }
    if (t.id === "dv-back") return goBack();
    if (t.id === "refresh") { lastError = null; return load("refresh", { force: true }); }
    if (t.id === "scope-btn") return scope.open ? closeScope() : openScope();
    if (t.id === "scope-close") return closeScope();
    if (t.dataset.tab) { scope.tab = t.dataset.tab; scope.q = ""; $("scope-q").value = ""; $("scope-status").textContent = ""; snapshotOrder(); renderScope(); return; }
    if (t.dataset.toggle) return toggleTracked(t.dataset.toggle);
    if (t.dataset.add) return addTracked(t.dataset.add);
    if (t.classList.contains("person-row")) {
        const login = t.closest(".person").dataset.login;
        if (openRows.has(login)) openRows.delete(login); else openRows.add(login);
        renderRoster();
        fitNow();
        document.querySelector(`.person[data-login="${CSS.escape(login)}"] .person-row`)?.focus({ focusVisible: event.detail === 0 });
        return;
    }
    if (t.dataset.openPicker) {
        const next = t.dataset.openPicker;
        openPicker = openPicker === next ? null : next;
        pickQ = "";
        if (next.startsWith("detail:")) renderDetailSide(); else renderTriage();
        (document.querySelector(".picker .pick-q") ?? document.querySelector(`[data-open-picker="${CSS.escape(next)}"]`))?.focus();
        return;
    }
    if (t.dataset.assign) return assign(t.dataset.key, t.dataset.assign);
    if (t.dataset.session) return assign(t.dataset.session, S?.me, { session: true });
});
document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (scope.open) return closeScope();
    if (openPicker) {
        const key = openPicker;
        openPicker = null;
        if (key.startsWith("detail:")) renderDetailSide(); else renderTriage();
        document.querySelector(`[data-open-picker="${CSS.escape(key)}"]`)?.focus();
        return;
    }
    if (route.item && !event.target.closest("input, textarea")) goBack();
});

// ---- Boot ----
document.querySelectorAll("[data-icon]").forEach(b => { b.innerHTML = icon(b.dataset.icon); });
document.querySelectorAll("[data-icon-inline]").forEach(b => b.replaceWith(document.createRange().createContextualFragment(icon(b.dataset.iconInline))));
$("roster").innerHTML = skeletonRows(5);
$("tickets").innerHTML = skeletonRows(3);
showRoute();
load("refresh", {});
