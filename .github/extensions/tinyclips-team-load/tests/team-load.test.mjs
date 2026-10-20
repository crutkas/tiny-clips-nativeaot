import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AGENT, TeamLoadError, canonLogin, cleanTitle, computeLoad, loadOf, tone, meterScale, sortRoster, sortForAssign,
    ago, parseItemUrl, normalizeTracking, validateItemRef, validateConfig,
} from "../model.mjs";
import { readConfig, createTrackingStore } from "../state.mjs";
import { createGitHub, normalizeIssue, normalizePull } from "../github.mjs";
import { createHub } from "../hub.mjs";
import { startServer, perform, statusFor, CSP } from "../server.mjs";
import { renderHtml } from "../renderer.mjs";

const config = await readConfig();
const T = Date.parse("2026-10-20T12:00:00Z");
const iso = hoursAgo => new Date(T - hoursAgo * 3600_000).toISOString();
const page = (nodes, next = null) => ({ nodes, pageInfo: { hasNextPage: !!next, endCursor: next } });

// ---------- model ----------

test("canonLogin folds Copilot identities and lowercases", () => {
    assert.equal(canonLogin("Copilot"), AGENT);
    assert.equal(canonLogin("copilot-swe-agent"), AGENT);
    assert.equal(canonLogin("copilot-swe-agent[bot]"), AGENT);
    assert.equal(canonLogin("BurkeHolland"), "burkeholland");
    assert.equal(canonLogin(""), null);
    assert.equal(canonLogin(undefined), null);
});

test("cleanTitle strips feature and launch prefixes", () => {
    assert.equal(cleanTitle("[Feature]: Add thing"), "Add thing");
    assert.equal(cleanTitle("Feature: Count down"), "Count down");
    assert.equal(cleanTitle("[2.0 Launch] Ship it"), "Ship it");
});

test("computeLoad assigns issues, PRs, reviews and collects unowned issues", () => {
    const items = [
        { kind: "issue", repository: "o/a", number: 1, title: "Owned", url: "u1", updatedAt: iso(5), labels: [], assignees: ["burkeholland", "jamesmontemagno"] },
        { kind: "issue", repository: "o/a", number: 2, title: "Free", url: "u2", updatedAt: iso(1), labels: [{ name: "bug", color: "d73a4a" }], assignees: [] },
        { kind: "issue", repository: "o/a", number: 3, title: "Copilot's", url: "u3", updatedAt: iso(2), labels: [], assignees: ["copilot"] },
        { kind: "issue", repository: "o/a", number: 4, title: "Outsider", url: "u4", updatedAt: iso(2), labels: [], assignees: ["someone"] },
        { kind: "pr", repository: "o/a", number: 10, title: "PR", url: "u10", updatedAt: iso(3), labels: [], assignees: [], author: "burkeholland", reviewers: ["jamesmontemagno", "burkeholland"], isDraft: true },
        { kind: "pr", repository: "o/a", number: 11, title: "Agent PR", url: "u11", updatedAt: iso(4), labels: [], assignees: ["burkeholland"], author: "copilot", reviewers: [] },
    ];
    const { people, unowned } = computeLoad({ items, people: ["burkeholland", "jamesmontemagno", AGENT], profiles: { burkeholland: { name: "Burke Holland", avatarUrl: "https://a/1" } } });
    const by = Object.fromEntries(people.map(p => [p.login, p]));
    assert.deepEqual(by.burkeholland.items.map(i => `${i.kind}${i.number}`), ["pr10", "pr11", "issue1"]);
    assert.equal(by.burkeholland.name, "Burke Holland");
    assert.equal(by.burkeholland.items.find(i => i.number === 10).isDraft, true, "PR author wins over review request");
    assert.deepEqual(by.jamesmontemagno.items.map(i => `${i.kind}${i.number}`), ["review10", "issue1"]);
    assert.deepEqual(by.copilot.items.map(i => `${i.kind}${i.number}`), ["issue3", "pr11"]);
    assert.equal(by.copilot.agent, true);
    assert.equal(by.copilot.avatarUrl, null);
    assert.deepEqual(unowned.map(i => i.number), [2]);
    assert.equal(loadOf(items, "jamesmontemagno"), 2);
    assert.equal(loadOf(items, "someone"), 1);
});

test("tone, scale and sorting", () => {
    assert.equal(tone(0).key, "free");
    assert.equal(tone(3).key, "room");
    assert.equal(tone(4).key, "busy");
    assert.equal(tone(6).label, "At limit");
    assert.deepEqual(tone(10), { key: "over", label: "4 over limit" });
    assert.equal(tone(2, { agent: true }).label, "Agent · 2 running");
    assert.equal(meterScale([1, 2]), 10);
    assert.equal(meterScale([12]), 12);
    assert.equal(meterScale([40]), 16);
    const people = [
        { login: "a", name: "Ann", agent: false, items: [1] },
        { login: AGENT, name: "Copilot", agent: true, items: [1, 2, 3, 4, 5, 6, 7, 8] },
        { login: "b", name: "Bob", agent: false, items: [1, 2, 3] },
        { login: "c", name: "Cy", agent: false, items: [] },
    ];
    assert.deepEqual(sortRoster(people).map(p => p.login), ["b", "a", "c", AGENT]);
    const { humans, agent } = sortForAssign(people);
    assert.deepEqual(humans.map(p => p.login), ["c", "a", "b"]);
    assert.equal(agent.login, AGENT);
});

test("ago formats relative times", () => {
    assert.equal(ago(iso(0.2), T), "now");
    assert.equal(ago(iso(5), T), "5h");
    assert.equal(ago(iso(72), T), "3d");
    assert.equal(ago("nope", T), "");
});

test("parseItemUrl only accepts github.com issue and PR URLs", () => {
    assert.deepEqual(parseItemUrl("https://github.com/jamesmontemagno/tiny-clips/issues/424"), { repository: "jamesmontemagno/tiny-clips", number: 424 });
    assert.deepEqual(parseItemUrl("https://github.com/o/r/pull/7#discussion"), { repository: "o/r", number: 7 });
    assert.equal(parseItemUrl("https://evil.com/o/r/issues/1"), null);
    assert.equal(parseItemUrl("https://github.com/o/r/blob/main/x"), null);
    assert.equal(parseItemUrl("javascript:alert(1)"), null);
});

test("normalizeTracking and validateItemRef validate input", () => {
    assert.deepEqual(normalizeTracking({ people: ["@BurkeHolland", "burkeholland", "Copilot"], repos: ["o/r", "O/R"] }), { people: ["burkeholland", AGENT], repos: ["o/r"] });
    assert.throws(() => normalizeTracking({ people: ["bad login!"], repos: [] }), TeamLoadError);
    assert.throws(() => normalizeTracking({ people: [], repos: ["not-a-repo"] }), TeamLoadError);
    assert.throws(() => normalizeTracking({ people: Array.from({ length: 30 }, (_, i) => `u${i}`), repos: [] }), TeamLoadError);
    assert.deepEqual(validateItemRef({ repository: "o/r", number: 3, login: "@Copilot" }, { login: true }), { repository: "o/r", number: 3, login: AGENT });
    assert.throws(() => validateItemRef({ repository: "o/r", number: 0 }), TeamLoadError);
    assert.throws(() => validateItemRef({ repository: "o/r", number: 1, extra: true }), TeamLoadError);
    assert.throws(() => validateItemRef({ repository: "o/r", number: 1, login: "a b" }, { login: true }), TeamLoadError);
});

test("bundled config is valid and offers tiny-clips-mac", () => {
    assert.ok(config.availableRepositories.includes("jamesmontemagno/tiny-clips-mac"));
    assert.ok(config.people.includes(AGENT));
    assert.throws(() => validateConfig({ ...config, format: "nope" }), TeamLoadError);
});

// ---------- github ----------

function fakeGh(handlers = {}) {
    const calls = [];
    const run = async (args, options) => {
        calls.push(args);
        const query = args.find(a => typeof a === "string" && a.startsWith("query="))?.slice(6) ?? "";
        const vars = Object.fromEntries(args.filter((a, i) => (args[i - 1] === "-f" || args[i - 1] === "-F") && !a.startsWith("query=")).map(a => a.split("=")));
        for (const [match, handler] of Object.entries(handlers)) {
            if (args.join(" ").includes(match) || query.includes(match)) return handler({ args, vars, options, calls });
        }
        throw new Error(`unexpected gh call: ${args.join(" ").slice(0, 120)}`);
    };
    return { run, calls };
}

const issueNode = (number, assignees = [], extra = {}) => ({ number, title: `Issue ${number}`, url: `https://github.com/o/r/issues/${number}`, updatedAt: iso(number), labels: { nodes: [{ name: "bug", color: "zzz" }] }, assignees: { nodes: assignees.map(login => ({ login })) }, ...extra });
const prNode = (number, extra = {}) => ({ number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, updatedAt: iso(number), isDraft: false, author: { login: "copilot-swe-agent" }, labels: { nodes: [] }, assignees: { nodes: [] }, reviewRequests: { nodes: [{ requestedReviewer: { login: "JamesMontemagno" } }, { requestedReviewer: null }] }, ...extra });

test("normalizers canonicalize people and sanitize label colors", () => {
    const issue = normalizeIssue(issueNode(1, ["Copilot", "Burke"]), "o/r");
    assert.deepEqual(issue.assignees, [AGENT, "burke"]);
    assert.equal(issue.labels[0].color, "8c959f");
    const pr = normalizePull(prNode(2), "o/r");
    assert.equal(pr.author, AGENT);
    assert.deepEqual(pr.reviewers, ["jamesmontemagno"]);
});

test("fetchRepo paginates issues and PRs", async () => {
    const { run, calls } = fakeGh({
        "issues(states:OPEN": ({ vars }) => ({ data: { repository: { issues: vars.after ? page([issueNode(2)]) : page([issueNode(1)], "c1") } } }),
        "pullRequests(states:OPEN": () => ({ data: { repository: { pullRequests: page([prNode(3)]) } } }),
    });
    const items = await createGitHub({ run }).fetchRepo("o/r");
    assert.deepEqual(items.map(i => `${i.kind}${i.number}`), ["issue1", "issue2", "pr3"]);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(args => args.includes("--hostname") && args.includes("github.com")));
});

test("fetchRepo reports coverage limits instead of silently truncating", async () => {
    const { run } = fakeGh({
        "issues(states:OPEN": () => ({ data: { repository: { issues: page([issueNode(1)], "more") } } }),
        "pullRequests(states:OPEN": () => ({ data: { repository: { pullRequests: page([]) } } }),
    });
    await assert.rejects(createGitHub({ run }).fetchRepo("o/r"), error => error.code === "coverage_limit");
});

test("profile requests are coalesced and cached; orgs are rejected", async () => {
    let hits = 0;
    const { run } = fakeGh({
        "users/burke": async () => { hits++; await new Promise(r => setTimeout(r, 5)); return { login: "Burke", name: "Burke H", avatar_url: "https://a/b", type: "User" }; },
        "users/acme": () => ({ login: "acme", type: "Organization" }),
    });
    const gh = createGitHub({ run });
    const [a, b] = await Promise.all([gh.profile("burke"), gh.profile("Burke")]);
    assert.equal(hits, 1);
    assert.deepEqual(a, b);
    await gh.profile("burke");
    assert.equal(hits, 1);
    assert.equal((await gh.profile("copilot")).agent, true);
    await assert.rejects(gh.profile("acme"), error => error.code === "not_found");
});

test("graphql errors surface as TeamLoadErrors", async () => {
    const { run } = fakeGh({ "nameWithOwner url": () => ({ errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }) });
    await assert.rejects(createGitHub({ run }).repoInfo("o/missing"), error => error.code === "not_found");
});

function issueServer(initial = []) {
    let assignees = [...initial];
    let state = "open";
    let isPr = false;
    const { run, calls } = fakeGh({
        "repos/o/r/issues/5": () => ({ state, pull_request: isPr ? {} : undefined, assignees: assignees.map(login => ({ login })) }),
        "issue edit": ({ args }) => {
            const login = args[args.length - 1] === "@copilot" ? "Copilot" : args[args.length - 1];
            if (args.includes("--add-assignee")) assignees.push(login);
            else assignees = assignees.filter(l => l !== login);
            return "";
        },
    });
    return { run, calls, set: next => { ({ state = state, isPr = isPr } = next); } };
}

test("assign uses gh issue edit, maps Copilot to @copilot, and verifies", async () => {
    const server = issueServer();
    const gh = createGitHub({ run: server.run });
    assert.deepEqual(await gh.assign({ repository: "o/r", number: 5, login: AGENT }), { assignees: [AGENT] });
    const edit = server.calls.find(args => args[0] === "issue");
    assert.deepEqual(edit, ["issue", "edit", "5", "--repo", "o/r", "--add-assignee", "@copilot"]);
    assert.deepEqual(await gh.unassign({ repository: "o/r", number: 5, login: AGENT }), { assignees: [] });
    assert.ok(server.calls.some(args => args.includes("--remove-assignee") && args.includes("@copilot")));
});

test("assign refuses conflicts: already assigned, closed, or a PR", async () => {
    const taken = issueServer(["jamesmontemagno"]);
    await assert.rejects(createGitHub({ run: taken.run }).assign({ repository: "o/r", number: 5, login: "burkeholland" }), error => error.code === "conflict" && /@jamesmontemagno/.test(error.message));
    assert.ok(!taken.calls.some(args => args[0] === "issue"), "no write after a conflict");
    const closed = issueServer();
    closed.set({ state: "closed" });
    await assert.rejects(createGitHub({ run: closed.run }).assign({ repository: "o/r", number: 5, login: "burkeholland" }), error => error.code === "conflict");
    const pr = issueServer();
    pr.set({ isPr: true });
    await assert.rejects(createGitHub({ run: pr.run }).assign({ repository: "o/r", number: 5, login: "burkeholland" }), error => error.code === "invalid_input");
});

test("assign reports when GitHub silently ignores the assignee", async () => {
    const { run } = fakeGh({
        "repos/o/r/issues/5": () => ({ state: "open", assignees: [] }),
        "issue edit": () => "",
    });
    await assert.rejects(createGitHub({ run }).assign({ repository: "o/r", number: 5, login: AGENT }), error => error.code === "github_error" && /Copilot/.test(error.message));
});

test("writes are never retried; reads retry once on transient errors", async () => {
    let edits = 0, reads = 0;
    const flaky = fakeGh({
        "repos/o/r/issues/5": () => ({ state: "open", assignees: [] }),
        "issue edit": () => { edits++; throw new Error("HTTP 502"); },
    });
    await assert.rejects(createGitHub({ run: flaky.run }).assign({ repository: "o/r", number: 5, login: "x" }));
    assert.equal(edits, 1);
    const read = fakeGh({ "users/x": () => { reads++; if (reads === 1) throw new Error("HTTP 502"); return { login: "x", type: "User" }; } });
    assert.equal((await createGitHub({ run: read.run }).profile("x")).login, "x");
    assert.equal(reads, 2);
});

test("detail normalizes issues and merged PRs", async () => {
    const node = {
        __typename: "PullRequest", number: 9, title: "T", url: "https://github.com/o/r/pull/9", state: "MERGED", merged: true, isDraft: false,
        createdAt: iso(10), updatedAt: iso(1), bodyHTML: "<p>hi</p>", author: { login: "copilot-swe-agent", avatarUrl: "x" },
        labels: { nodes: [] }, assignees: { nodes: [{ login: "Burke", name: "B", avatarUrl: "a" }] },
        comments: { totalCount: 40, nodes: [{ url: "c", createdAt: iso(2), bodyHTML: "<p>c</p>", author: null }] },
    };
    const { run } = fakeGh({ issueOrPullRequest: () => ({ data: { repository: { issueOrPullRequest: node } } }) });
    const d = await createGitHub({ run }).detail({ repository: "o/r", number: 9 });
    assert.equal(d.kind, "pr");
    assert.equal(d.state, "merged");
    assert.equal(d.author.agent, true);
    assert.equal(d.comments.total, 40);
    assert.equal(d.comments.nodes[0].author, null);
});

// ---------- tracking store ----------

test("tracking store defaults, persists atomically, and remembers added entries", async () => {
    const home = await mkdtemp(join(tmpdir(), "team-load-"));
    try {
        const store = createTrackingStore(config, home);
        assert.deepEqual((await store.read()).people, config.people);
        await Promise.all([
            store.write({ people: ["burkeholland", "newperson"], repos: ["jamesmontemagno/tiny-clips", "someone/else"] }),
            store.write({ people: ["burkeholland"], repos: ["jamesmontemagno/tiny-clips-mac"] }),
        ]);
        const saved = JSON.parse(await readFile(store.path, "utf8"));
        assert.equal(saved.format, "tinyclips-team-load-tracking");
        assert.deepEqual(saved.people, ["burkeholland"]);
        assert.deepEqual(saved.repos, ["jamesmontemagno/tiny-clips-mac"]);
        assert.deepEqual(saved.knownPeople, ["newperson"]);
        assert.deepEqual(saved.knownRepos, ["someone/else"]);
        await writeFile(store.path, "{ broken");
        await assert.rejects(store.read(), error => error.code === "storage_error");
    } finally { await rm(home, { recursive: true, force: true }); }
});

test("tracking store still reads after remembering more people than can be tracked", async () => {
    const home = await mkdtemp(join(tmpdir(), "team-load-"));
    try {
        const store = createTrackingStore(config, home);
        for (let i = 0; i < 3; i++) {
            const people = Array.from({ length: 10 }, (_, j) => `person${i * 10 + j}`);
            await store.write({ people, repos: ["jamesmontemagno/tiny-clips"] });
        }
        const read = await store.read();
        assert.equal(read.knownPeople.length, 30);
        await store.write({ people: ["burkeholland"], repos: ["jamesmontemagno/tiny-clips"] });
        assert.equal((await store.read()).knownPeople.length, 30);
    } finally { await rm(home, { recursive: true, force: true }); }
});

// ---------- hub ----------

function hubFixture({ sendPrompt = async () => {}, issues = { "o/r": [issueNode(5)] }, failing = [] } = {}) {
    const cfg = { ...config, people: ["burkeholland", "jamesmontemagno", AGENT], repositories: ["o/r"], availableRepositories: ["o/other"] };
    const store = { data: null, read: async () => store.data ?? { people: cfg.people, repos: cfg.repositories, knownPeople: [], knownRepos: [] }, write: async next => (store.data = { ...normalizeTracking(next), knownPeople: [], knownRepos: [] }) };
    const writes = [];
    const assignees = new Map();
    const github = {
        fetchRepo: async name => { if (failing.includes(name)) throw new TeamLoadError("permission_denied", "no access"); return (issues[name] ?? []).map(node => normalizeIssue({ ...node, assignees: { nodes: (assignees.get(`${name}#${node.number}`) ?? []).map(login => ({ login })) } }, name)); },
        repoInfo: async name => { if (name === "o/missing") throw new TeamLoadError("not_found", "nope"); return { nameWithOwner: name, url: `https://github.com/${name}`, open: 1, actors: [{ login: "Helper", name: "Help", avatarUrl: "h", agent: false }] }; },
        profile: async login => { if (login === "ghost404") throw new TeamLoadError("not_found", "no"); return { login, name: login.toUpperCase(), avatarUrl: null }; },
        me: async () => "burkeholland",
        detail: async ref => ({ ...ref, title: "x" }),
        assign: async ({ repository, number, login }) => { writes.push(["assign", repository, number, login]); assignees.set(`${repository}#${number}`, [login]); return { assignees: [login] }; },
        unassign: async ({ repository, number, login }) => { writes.push(["unassign", repository, number, login]); assignees.set(`${repository}#${number}`, []); return { assignees: [] }; },
    };
    return { hub: createHub(cfg, { store, github, sendPrompt, now: () => T }), writes, store, github };
}

async function settle(hub) {
    for (let i = 0; i < 20 && hub.state().refreshing; i++) await new Promise(r => setTimeout(r, 1));
}

test("hub refresh builds state with directory and per-repo status", async () => {
    const { hub } = hubFixture();
    await hub.refresh();
    await settle(hub);
    const s = hub.state();
    assert.equal(s.refreshing, false);
    assert.equal(s.me, "burkeholland");
    assert.equal(s.repoStatus["o/r"].status, "ready");
    assert.deepEqual(s.items.map(i => i.number), [5]);
    assert.ok(s.directory.people.some(p => p.login === "helper" || p.login === "Helper"));
    assert.ok(s.directory.repos.some(r => r.nameWithOwner === "o/other"));
});

test("hub assign/unassign enforce tracking and return fresh state", async () => {
    const { hub, writes } = hubFixture();
    await hub.refresh(); await settle(hub);
    const result = await hub.assign({ repository: "o/r", number: 5, login: "@Copilot" });
    assert.deepEqual(writes.at(-1), ["assign", "o/r", 5, AGENT]);
    assert.deepEqual(result.state.items[0].assignees, [AGENT]);
    await hub.unassign({ repository: "o/r", number: 5, login: AGENT });
    assert.deepEqual(writes.at(-1), ["unassign", "o/r", 5, AGENT]);
    await assert.rejects(hub.assign({ repository: "o/untracked", number: 5, login: AGENT }), error => error.code === "invalid_input");
    await assert.rejects(hub.assign({ repository: "o/r", number: 5, login: "stranger" }), error => error.code === "invalid_input");
});

test("start_session assigns me, sends the prompt, and rolls back if sending fails", async () => {
    const prompts = [];
    const ok = hubFixture({ sendPrompt: async prompt => prompts.push(prompt) });
    await ok.hub.refresh(); await settle(ok.hub);
    await ok.hub.startSession({ repository: "o/r", number: 5, title: "Fix it" });
    assert.deepEqual(ok.writes, [["assign", "o/r", 5, "burkeholland"]]);
    assert.match(prompts[0], /o\/r issue #5 title="Fix it"/);
    const bad = hubFixture({ sendPrompt: async () => { throw new Error("offline"); } });
    await bad.hub.refresh(); await settle(bad.hub);
    await assert.rejects(bad.hub.startSession({ repository: "o/r", number: 5 }));
    assert.deepEqual(bad.writes, [["assign", "o/r", 5, "burkeholland"], ["unassign", "o/r", 5, "burkeholland"]]);
});

test("start_session reports when the rollback unassign also fails", async () => {
    const f = hubFixture({ sendPrompt: async () => { throw new Error("offline"); } });
    await f.hub.refresh(); await settle(f.hub);
    f.github.unassign = async () => { throw new Error("rate limited"); };
    await assert.rejects(f.hub.startSession({ repository: "o/r", number: 5 }), error => /may still be assigned/.test(error.message) && !/was undone/.test(error.message));
});

test("set_tracking validates new people and repos, then persists", async () => {
    const { hub, store } = hubFixture();
    await hub.refresh(); await settle(hub);
    const s = await hub.setTracking({ people: ["burkeholland", "newbie"], repos: ["o/r", "o/other", "o/brandnew"] });
    assert.deepEqual(store.data.people, ["burkeholland", "newbie"]);
    assert.deepEqual(store.data.repos, ["o/r", "o/other", "o/brandnew"]);
    assert.deepEqual(s.tracking.people, ["burkeholland", "newbie"]);
    await assert.rejects(hub.setTracking({ people: ["ghost404"], repos: ["o/r"] }), error => error.code === "not_found");
    await assert.rejects(hub.setTracking({ people: [], repos: ["o/missing"] }), error => error.code === "not_found");
    assert.deepEqual(store.data.people, ["burkeholland", "newbie"], "failed validation does not persist");
});

test("a failing repo keeps the rest of the dashboard working", async () => {
    const { hub } = hubFixture({ failing: ["o/other"] });
    await hub.setTracking({ people: ["burkeholland"], repos: ["o/r", "o/other"] });
    await settle(hub);
    const s = hub.state();
    assert.equal(s.repoStatus["o/r"].status, "ready");
    assert.equal(s.repoStatus["o/other"].status, "error");
    assert.equal(s.repoStatus["o/other"].error.code, "permission_denied");
    assert.deepEqual(s.items.map(i => i.repository), ["o/r"]);
});

// ---------- server ----------

test("perform validates action names and refresh input", async () => {
    const { hub } = hubFixture();
    await assert.rejects(perform({ hub }, "drop_tables", {}), error => error.code === "invalid_input");
    await assert.rejects(perform({ hub }, "refresh", { force: "yes" }), error => error.code === "invalid_input");
    await assert.rejects(perform({ hub }, "get_state", { extra: 1 }), error => error.code === "invalid_input");
    assert.equal(statusFor(new TeamLoadError("conflict", "x")), 409);
    assert.equal(statusFor(new TeamLoadError("rate_limit", "x")), 429);
    assert.equal(statusFor(new Error("boom")), 500);
});

test("renderer escapes nothing user-controlled and locks theme only for known values", () => {
    assert.match(renderHtml("abc", "dark"), /data-theme="dark" data-theme-locked/);
    assert.doesNotMatch(renderHtml("abc", "<x>"), /data-theme/);
    assert.doesNotMatch(renderHtml("abc"), /<script>(?!<\/script>)/);
});

test("server enforces nonce, host, origin and CSP", async () => {
    const { hub } = hubFixture();
    const server = await startServer(() => ({ hub }));
    try {
        const page = await fetch(server.url);
        assert.equal(page.status, 200);
        assert.equal(page.headers.get("content-security-policy"), CSP);
        assert.doesNotMatch(CSP, /unsafe-inline|frame-ancestors \*/);
        const html = await page.text();
        const nonce = html.match(/name="team-load-nonce" content="([^"]+)"/)[1];
        const call = (headers, body = { action: "get_state", input: {} }) => fetch(new URL("/api/action", server.url), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
        assert.equal((await call({})).status, 403);
        assert.equal((await call({ "x-team-load-nonce": "wrong" })).status, 403);
        assert.equal((await call({ "x-team-load-nonce": nonce, origin: "https://evil.example" })).status, 403);
        const ok = await call({ "x-team-load-nonce": nonce });
        assert.equal(ok.status, 200);
        assert.ok(Array.isArray((await ok.json()).tracking.people));
        assert.equal((await call({ "x-team-load-nonce": nonce }, { action: "assign", input: { repository: "o/r", number: 5, login: "stranger" } })).status, 400);
        for (const asset of ["/app.mjs", "/model.mjs", "/icons.mjs", "/markdown.mjs", "/styles.css"]) assert.equal((await fetch(new URL(asset, server.url))).status, 200, asset);
        assert.equal((await fetch(new URL("/config.json", server.url))).status, 404);
        assert.equal((await fetch(new URL("/../state.mjs", server.url))).status, 404);
    } finally { await server.close(); }
});

test("a write during an in-flight fetch returns post-write state, not the stale fetch", async () => {
    let release;
    const assignees = [];
    let calls = 0;
    const github = {
        fetchRepo: async name => {
            calls++;
            const snapshot = [...assignees];
            if (calls === 2) await new Promise(r => { release = r; });
            return [normalizeIssue({ ...issueNode(5), assignees: { nodes: snapshot.map(login => ({ login })) } }, name)];
        },
        repoInfo: async name => ({ nameWithOwner: name, url: "u", open: 1, actors: [] }),
        profile: async login => ({ login, name: login, avatarUrl: null }),
        me: async () => "burkeholland",
        assign: async ({ login }) => { assignees.push(login); return { assignees: [login] }; },
        unassign: async () => ({ assignees: [] }),
    };
    const cfg = { ...config, people: ["burkeholland"], repositories: ["o/r"], availableRepositories: [] };
    const store = { read: async () => ({ people: cfg.people, repos: cfg.repositories, knownPeople: [], knownRepos: [] }), write: async v => v };
    const gated = createHub(cfg, { store, github, sendPrompt: async () => {}, now: () => T });
    await gated.refresh(); await settle(gated);
    await gated.refresh({ force: true }); // starts fetch #2, which snapshots "unassigned" and hangs
    const write = gated.assign({ repository: "o/r", number: 5, login: "burkeholland" });
    await new Promise(r => setTimeout(r, 5));
    release();
    const result = await write;
    assert.deepEqual(result.state.items[0].assignees, ["burkeholland"]);
    assert.equal(calls, 3, "a fresh fetch ran after the write");
});

test("when every repo fails, status is error (not loading) so the UI can show it", async () => {
    const { hub } = hubFixture({ failing: ["o/r"] });
    await hub.refresh(); await settle(hub);
    const status = hub.state().repoStatus["o/r"];
    assert.equal(status.status, "error");
    assert.equal(status.error.message, "no access");
});
