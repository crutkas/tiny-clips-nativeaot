// Pure, dependency-free logic shared by the extension (Node) and the canvas page (browser).

export class TeamLoadError extends Error {
    constructor(code, message, retryAt = null) {
        super(message);
        this.code = code;
        this.retryAt = retryAt;
    }
}

export const AGENT = "copilot";
const AGENT_LOGINS = new Set(["copilot", "copilot-swe-agent", "copilot-swe-agent[bot]"]);
export const loginPattern = /^(?!-)[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
export const repoPattern = /^[a-z\d](?:[a-z\d-]{0,38})\/[\w.-]{1,100}$/i;
export const MAX_PEOPLE = 25;
export const MAX_REPOS = 15;

export const canonLogin = login => {
    if (typeof login !== "string" || !login) return null;
    const lower = login.toLowerCase();
    return AGENT_LOGINS.has(lower) ? AGENT : lower;
};
export const isAgent = login => canonLogin(login) === AGENT;
export const shortRepo = nwo => String(nwo).split("/")[1] ?? String(nwo);
export const cleanTitle = title => String(title ?? "")
    .replace(/^\s*\[?Feature\]?:\s*/i, "")
    .replace(/^\s*\[2\.0 Launch\]\s*/i, "")
    .trim() || String(title ?? "");

export function validateConfig(value) {
    const fail = message => { throw new TeamLoadError("invalid_config", `Team Load config.json: ${message}`); };
    if (!value || typeof value !== "object" || value.format !== "tinyclips-team-load-config" || value.version !== 1) fail("unknown format or version.");
    const repos = list => Array.isArray(list) && list.every(r => typeof r === "string" && repoPattern.test(r));
    if (!repos(value.repositories) || !value.repositories.length) fail("repositories must be a non-empty owner/name list.");
    if (value.availableRepositories !== undefined && !repos(value.availableRepositories)) fail("availableRepositories must be owner/name entries.");
    if (!Array.isArray(value.people) || !value.people.every(p => typeof p === "string" && loginPattern.test(p))) fail("people must be GitHub logins.");
    if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 20) fail("limit must be an integer from 1 to 20.");
    if (!Number.isInteger(value.refreshSeconds) || value.refreshSeconds < 30) fail("refreshSeconds must be an integer of at least 30.");
    return {
        repositories: value.repositories,
        availableRepositories: value.availableRepositories ?? [],
        people: value.people.map(canonLogin),
        limit: value.limit,
        refreshSeconds: value.refreshSeconds,
    };
}

const uniq = list => [...new Set(list)];
export function normalizeTracking(value) {
    const fail = message => { throw new TeamLoadError("invalid_input", message); };
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("Provide people and repos lists.");
    const extra = Object.keys(value).filter(key => !["people", "repos"].includes(key));
    if (extra.length) fail(`Unknown tracking field: ${extra[0]}.`);
    if (!Array.isArray(value.people) || !Array.isArray(value.repos)) fail("people and repos must be lists.");
    if (!value.people.every(p => typeof p === "string" && loginPattern.test(p.replace(/^@/, "")))) fail("Every person must be a valid GitHub login.");
    if (!value.repos.every(r => typeof r === "string" && repoPattern.test(r))) fail("Every repository must look like owner/name.");
    const people = uniq(value.people.map(p => canonLogin(p.replace(/^@/, ""))));
    const seen = new Map();
    for (const repo of value.repos) if (!seen.has(repo.toLowerCase())) seen.set(repo.toLowerCase(), repo);
    const repos = [...seen.values()];
    if (people.length > MAX_PEOPLE) fail(`Track at most ${MAX_PEOPLE} people.`);
    if (repos.length > MAX_REPOS) fail(`Track at most ${MAX_REPOS} repositories.`);
    return { people, repos };
}

export function validateItemRef(input, { title = false, login = false } = {}) {
    const fail = message => { throw new TeamLoadError("invalid_input", message); };
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("Provide an item.");
    const allowed = ["repository", "number", ...(title ? ["title"] : []), ...(login ? ["login"] : [])];
    const extra = Object.keys(input).filter(key => !allowed.includes(key));
    if (extra.length) fail(`Unknown field: ${extra[0]}.`);
    if (typeof input.repository !== "string" || !repoPattern.test(input.repository)) fail("repository must look like owner/name.");
    if (!Number.isInteger(input.number) || input.number < 1) fail("number must be a positive integer.");
    if (title && input.title !== undefined && (typeof input.title !== "string" || input.title.length > 300)) fail("title must be a short string.");
    if (login && (typeof input.login !== "string" || !loginPattern.test(input.login.replace(/^@/, "")))) fail("login must be a valid GitHub login.");
    return { ...input, ...(login ? { login: canonLogin(input.login.replace(/^@/, "")) } : {}) };
}

// Build each tracked person's current load from the open items in the tracked repositories.
export function computeLoad({ items = [], people = [], profiles = {} }) {
    const roster = people.map(login => {
        const profile = profiles[login] ?? {};
        return {
            login,
            agent: login === AGENT,
            name: login === AGENT ? "Copilot" : profile.name || profile.login || login,
            avatarUrl: login === AGENT ? null : profile.avatarUrl || `https://avatars.githubusercontent.com/${login}?s=64`,
            items: [],
        };
    });
    const byLogin = new Map(roster.map(person => [person.login, person]));
    const unowned = [];
    for (const item of items) {
        const base = { repository: item.repository, number: item.number, title: cleanTitle(item.title), url: item.url, updatedAt: item.updatedAt, labels: item.labels ?? [] };
        if (item.kind === "issue") {
            const owners = uniq((item.assignees ?? []).map(canonLogin).filter(Boolean));
            if (!owners.length) { unowned.push({ ...base, kind: "issue" }); continue; }
            for (const login of owners) byLogin.get(login)?.items.push({ ...base, kind: "issue" });
            continue;
        }
        const roles = new Map();
        for (const login of (item.reviewers ?? []).map(canonLogin)) if (login) roles.set(login, "review");
        for (const login of [item.author, ...(item.assignees ?? [])].map(canonLogin)) if (login) roles.set(login, "pr");
        for (const [login, kind] of roles) byLogin.get(login)?.items.push({ ...base, kind, isDraft: !!item.isDraft });
    }
    const recent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
    for (const person of roster) person.items.sort(recent);
    unowned.sort(recent);
    return { people: roster, unowned };
}

// Open-item count for any login (tracked or not), for the pickers.
export function loadOf(items, login) {
    const target = canonLogin(login);
    let count = 0;
    for (const item of items) {
        const who = new Set([...(item.assignees ?? []), ...(item.kind === "pr" ? [item.author, ...(item.reviewers ?? [])] : [])].map(canonLogin));
        if (who.has(target)) count++;
    }
    return count;
}

export function tone(count, { agent = false, limit = 6 } = {}) {
    if (agent) return { key: "agent", label: count ? `Agent · ${count} running` : "Agent · idle" };
    if (count === 0) return { key: "free", label: "Free" };
    if (count <= Math.floor(limit / 2)) return { key: "room", label: "Has room" };
    if (count <= limit) return { key: "busy", label: count === limit ? "At limit" : "Busy" };
    return { key: "over", label: `${count - limit} over limit` };
}

export const meterScale = (counts, limit = 6) => Math.min(16, Math.max(limit + 4, ...counts));

export function sortRoster(people) {
    const humans = people.filter(p => !p.agent).sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
    return [...humans, ...people.filter(p => p.agent)];
}

export function sortForAssign(people) {
    const humans = people.filter(p => !p.agent).sort((a, b) => a.items.length - b.items.length || a.name.localeCompare(b.name));
    return { humans, agent: people.find(p => p.agent) ?? null };
}

export function ago(iso, now = Date.now()) {
    const hours = Math.max(0, (now - new Date(iso).getTime()) / 36e5);
    if (!Number.isFinite(hours)) return "";
    if (hours < 1) return "now";
    if (hours < 24) return `${Math.round(hours)}h`;
    if (hours < 24 * 60) return `${Math.round(hours / 24)}d`;
    return `${Math.round(hours / 24 / 30)}mo`;
}

// Parse a github.com issue/PR URL into an in-canvas reference.
export function parseItemUrl(href) {
    let url;
    try { url = new URL(href, "https://github.com"); } catch { return null; }
    if (url.hostname !== "github.com") return null;
    const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\/?$/);
    if (!match) return null;
    const repository = `${match[1]}/${match[2]}`;
    return repoPattern.test(repository) ? { repository, number: Number(match[3]) } : null;
}
