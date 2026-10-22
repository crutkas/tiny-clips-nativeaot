import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT, TeamLoadError, canonLogin, momentumStart, repoPattern } from "./model.mjs";
import { repoRoot } from "./state.mjs";

const exec = promisify(execFile);
const redact = text => String(text).replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[redacted]").slice(0, 1200);
const env = () => ({ ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "", GH_HOST: "github.com", NO_COLOR: "1" });

export async function runGh(args, { json = true, input = null } = {}) {
    try {
        const pending = exec("gh", args, {
            cwd: repoRoot, windowsHide: true, encoding: "utf8", timeout: 45_000, maxBuffer: 16 * 1024 * 1024, env: env(),
        });
        // Request bodies go over stdin (`--input -`) so long comments never hit command-line length limits.
        // gh can exit before draining stdin (auth failure, timeout); swallow EPIPE so the exit code reports it instead of crashing.
        pending.child.stdin?.on("error", () => {});
        if (input !== null) pending.child.stdin.end(input); else pending.child.stdin?.end();
        const result = await pending;
        return json ? JSON.parse(result.stdout) : result.stdout;
    } catch (error) {
        if (error.code === "ENOENT") throw new TeamLoadError("missing_gh", "GitHub CLI (gh) is not installed or is not on PATH.");
        if (error instanceof SyntaxError) throw new TeamLoadError("github_error", "GitHub returned a response that was not JSON.");
        const message = redact(error.stderr || error.message);
        if (/rate limit|RATE_LIMITED/i.test(message)) {
            let retryAt = new Date(Date.now() + 300_000).toISOString();
            try {
                const result = await exec("gh", ["api", "--hostname", "github.com", "rate_limit"], { cwd: repoRoot, windowsHide: true, encoding: "utf8", timeout: 10_000, env: env() });
                const exhausted = Object.values(JSON.parse(result.stdout).resources).filter(value => value.remaining === 0);
                if (exhausted.length) retryAt = new Date(Math.max(...exhausted.map(value => value.reset)) * 1000).toISOString();
            } catch { /* keep the default retry time */ }
            throw new TeamLoadError("rate_limit", `GitHub rate limit reached. ${message}`, retryAt);
        }
        if (/HTTP 404|Could not resolve to a|not found/i.test(message)) throw new TeamLoadError("not_found", `GitHub could not find that. ${message}`);
        throw new TeamLoadError(/auth|HTTP 401|HTTP 403|permission|scope|not have permission/i.test(message) ? "permission_denied" : "github_error",
            `GitHub request failed. ${message}`);
    }
}

const PAGE_LIMIT = 10;
const labelFields = "labels(first:20){nodes{name color}}";
const issuesQuery = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){
  issues(states:OPEN,first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor}
    nodes{number title url updatedAt ${labelFields} assignees(first:20){nodes{login}}}
  }}}`;
const pullsQuery = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){
  pullRequests(states:OPEN,first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor}
    nodes{number title url updatedAt isDraft author{login} ${labelFields} assignees(first:20){nodes{login}}
      reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Bot{login}}}}}
  }}}`;
const infoQuery = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
  nameWithOwner url openIssues:issues(states:OPEN){totalCount} openPulls:pullRequests(states:OPEN){totalCount}
  suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){nodes{__typename login avatarUrl(size:64) ... on User{name}}}
}}`;
const actorFields = "login avatarUrl(size:64) ... on User{name}";
const commentFields = `databaseId url createdAt bodyHTML viewerCanDelete viewerDidAuthor author{${actorFields}}`;
const detailQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
  issueOrPullRequest(number:$number){
    __typename
    ... on Issue{number title url state stateReason createdAt updatedAt bodyHTML author{${actorFields}} ${labelFields}
      assignees(first:20){nodes{login avatarUrl(size:64) name}}
      comments(last:30){totalCount nodes{${commentFields}}}}
    ... on PullRequest{number title url state isDraft merged createdAt updatedAt bodyHTML author{${actorFields}} ${labelFields}
      assignees(first:20){nodes{login avatarUrl(size:64) name}}
      comments(last:30){totalCount nodes{${commentFields}}}}
  }}}`;
const repoLabelsQuery = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){
  labels(first:100,after:$after,orderBy:{field:NAME,direction:ASC}){pageInfo{hasNextPage endCursor} nodes{name color description}}}}`;

// Activity history for the momentum chart: lightweight reads, newest first, so paging can stop at the window start.
const historyCommitsQuery = `query($owner:String!,$name:String!,$since:GitTimestamp!,$after:String){repository(owner:$owner,name:$name){
  defaultBranchRef{target{... on Commit{history(first:100,since:$since,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{oid committedDate author{user{login}}}
  }}}}}}`;
const historyPullsQuery = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){
  pullRequests(first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor}
    nodes{number createdAt updatedAt mergedAt author{login}}
  }}}`;
const historyIssuesQuery = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){
  issues(first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
    pageInfo{hasNextPage endCursor}
    nodes{number createdAt updatedAt closedAt state stateReason author{login} assignees(first:20){nodes{login}}}
  }}}`;

const split = nwo => {
    if (!repoPattern.test(nwo)) throw new TeamLoadError("invalid_input", "Repository must look like owner/name.");
    return nwo.split("/");
};
const labels = connection => (connection?.nodes ?? []).map(label => ({ name: String(label.name), color: /^[0-9a-f]{6}$/i.test(label.color) ? label.color : "8c959f" }));
const logins = connection => [...new Set((connection?.nodes ?? []).map(node => canonLogin(node?.login)).filter(Boolean))];
const actor = node => node ? { login: canonLogin(node.login) === AGENT ? AGENT : node.login, name: node.name || null, avatarUrl: node.avatarUrl || null, agent: canonLogin(node.login) === AGENT } : null;

export function normalizeIssue(node, repository) {
    return { kind: "issue", repository, number: node.number, title: node.title, url: node.url, updatedAt: node.updatedAt, labels: labels(node.labels), assignees: logins(node.assignees), author: null, reviewers: [], isDraft: false };
}
export function normalizePull(node, repository) {
    return {
        kind: "pr", repository, number: node.number, title: node.title, url: node.url, updatedAt: node.updatedAt, labels: labels(node.labels),
        assignees: logins(node.assignees), author: canonLogin(node.author?.login), isDraft: !!node.isDraft,
        reviewers: [...new Set((node.reviewRequests?.nodes ?? []).map(request => canonLogin(request?.requestedReviewer?.login)).filter(Boolean))],
    };
}

// Momentum events. `actors` are canonical logins; an empty list means no GitHub account is attached.
const loginList = login => [canonLogin(login)].filter(Boolean);
export const commitEvent = (node, repository) => ({ type: "commit", at: node.committedDate, repository, key: `${repository}@${node.oid}`, actors: loginList(node.author?.user?.login) });
export function pullEvents(node, repository) {
    const base = { repository, key: `${repository}#${node.number}`, actors: loginList(node.author?.login) };
    return [{ ...base, type: "prOpened", at: node.createdAt }, ...(node.mergedAt ? [{ ...base, type: "prMerged", at: node.mergedAt }] : [])];
}
export function issueEvents(node, repository) {
    const key = `${repository}#${node.number}`;
    const completed = node.state === "CLOSED" && node.stateReason === "COMPLETED" && node.closedAt;
    return [
        { type: "issueOpened", at: node.createdAt, repository, key, actors: loginList(node.author?.login) },
        ...(completed ? [{ type: "issueCompleted", at: node.closedAt, repository, key, actors: logins(node.assignees) }] : []),
    ];
}

export function createGitHub({ run = runGh, now = () => Date.now(), log = () => {} } = {}) {
    let active = 0;
    const waiting = [];
    const profiles = new Map();
    const profileRequests = new Map();
    const infos = new Map();
    let viewer = null;

    async function limited(args, options) {
        if (active >= 3) await new Promise(resolve => waiting.push(resolve));
        else active++;
        try {
            try { return await run(args, options); }
            catch (error) {
                const write = args.includes("--method") || args[0] === "issue" || args[0] === "pr";
                if (write || !/HTTP 50[234]|timed out|ETIMEDOUT|ECONNRESET/i.test(error.message)) throw error;
                try { log(`Retrying a transient GitHub read once: ${error.message}`); } catch {}
                await new Promise(resolve => setTimeout(resolve, 500));
                return await run(args, options);
            }
        } finally {
            const next = waiting.shift();
            if (next) next();
            else active--;
        }
    }

    async function gql(query, variables) {
        const args = ["api", "--hostname", "github.com", "graphql", "-f", `query=${query}`];
        for (const [key, value] of Object.entries(variables)) {
            if (value === undefined || value === null) continue;
            args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
        }
        const response = await limited(args);
        if (response?.errors?.length) {
            const message = response.errors.map(error => error.message).join("; ");
            throw new TeamLoadError(response.errors.some(error => error.type === "NOT_FOUND") ? "not_found" : "github_error", message);
        }
        if (!response?.data) throw new TeamLoadError("github_error", "GitHub returned no data.");
        return response.data;
    }

    async function paginate(query, nwo, field, normalize) {
        const [owner, name] = split(nwo);
        const items = [];
        let after;
        for (let page = 0; page < PAGE_LIMIT; page++) {
            const data = await gql(query, { owner, name, after });
            const connection = data.repository?.[field];
            if (!connection) throw new TeamLoadError("not_found", `${nwo} is not available.`);
            items.push(...connection.nodes.filter(Boolean).map(node => normalize(node, nwo)));
            if (!connection.pageInfo.hasNextPage) return items;
            after = connection.pageInfo.endCursor;
        }
        const description = field === "labels" ? "labels" : `open ${field}`;
        throw new TeamLoadError("coverage_limit", `${nwo} has more than ${PAGE_LIMIT * 100} ${description}; results would be incomplete.`);
    }

    async function fetchRepo(nwo) {
        const [issues, pulls] = await Promise.all([
            paginate(issuesQuery, nwo, "issues", normalizeIssue),
            paginate(pullsQuery, nwo, "pullRequests", normalizePull),
        ]);
        return [...issues, ...pulls];
    }

    // Pull requests and issues, newest-updated first. Anything last updated before `since` cannot have a
    // create/merge/close event inside the window, so paging stops once a page runs past it.
    async function pageSince(query, nwo, field, since) {
        const [owner, name] = split(nwo);
        const nodes = [];
        let after;
        for (let page = 0; page < PAGE_LIMIT; page++) {
            const data = await gql(query, { owner, name, after });
            const connection = data.repository?.[field];
            if (!connection) throw new TeamLoadError("not_found", `${nwo} is not available.`);
            const batch = connection.nodes.filter(Boolean);
            nodes.push(...batch.filter(node => Date.parse(node.updatedAt) >= since));
            const last = batch.at(-1);
            if (!connection.pageInfo.hasNextPage || !last || Date.parse(last.updatedAt) < since) return { nodes, truncated: false };
            after = connection.pageInfo.endCursor;
        }
        return { nodes, truncated: true };
    }

    async function pageCommits(nwo, since) {
        const [owner, name] = split(nwo);
        const nodes = [];
        let after;
        for (let page = 0; page < PAGE_LIMIT; page++) {
            const data = await gql(historyCommitsQuery, { owner, name, since: new Date(since).toISOString(), after });
            if (!data.repository) throw new TeamLoadError("not_found", `${nwo} is not available.`);
            const connection = data.repository.defaultBranchRef?.target?.history;
            if (!connection) return { nodes, truncated: false };
            nodes.push(...connection.nodes.filter(Boolean));
            if (!connection.pageInfo.hasNextPage) return { nodes, truncated: false };
            after = connection.pageInfo.endCursor;
        }
        return { nodes, truncated: true };
    }

    // Default-branch commits plus PR and issue lifecycle events for the last `days` UTC days.
    async function history(nwo, { days }) {
        const since = momentumStart(days, now());
        const [commits, pulls, issues] = await Promise.all([
            pageCommits(nwo, since),
            pageSince(historyPullsQuery, nwo, "pullRequests", since),
            pageSince(historyIssuesQuery, nwo, "issues", since),
        ]);
        return {
            events: [
                ...commits.nodes.map(node => commitEvent(node, nwo)),
                ...pulls.nodes.flatMap(node => pullEvents(node, nwo)),
                ...issues.nodes.flatMap(node => issueEvents(node, nwo)),
            ],
            truncated: commits.truncated || pulls.truncated || issues.truncated,
        };
    }

    async function repoInfo(nwo, { force = false } = {}) {
        const key = nwo.toLowerCase();
        const cached = infos.get(key);
        if (!force && cached && now() - cached.at < 10 * 60_000) return cached.value;
        const [owner, name] = split(nwo);
        const data = await gql(infoQuery, { owner, name });
        const repo = data.repository;
        if (!repo) throw new TeamLoadError("not_found", `${nwo} was not found or you lack access.`);
        const value = {
            nameWithOwner: repo.nameWithOwner, url: repo.url,
            open: (repo.openIssues?.totalCount ?? 0) + (repo.openPulls?.totalCount ?? 0),
            actors: (repo.suggestedActors?.nodes ?? []).map(actor).filter(Boolean),
        };
        for (const person of value.actors) if (!person.agent) remember(person);
        infos.set(key, { at: now(), value });
        return value;
    }

    function remember(person) {
        const login = canonLogin(person.login);
        if (!login || login === AGENT) return;
        const previous = profiles.get(login)?.value;
        profiles.set(login, { at: now(), value: { login: person.login, name: person.name || previous?.name || null, avatarUrl: person.avatarUrl || previous?.avatarUrl || null } });
    }

    function profile(login) {
        const key = canonLogin(login);
        if (key === AGENT) return Promise.resolve({ login: AGENT, name: "Copilot", avatarUrl: null, agent: true });
        const cached = profiles.get(key);
        if (cached && now() - cached.at < 24 * 3600_000) return Promise.resolve(cached.value);
        if (profileRequests.has(key)) return profileRequests.get(key);
        const request = limited(["api", "--hostname", "github.com", `users/${key}`])
            .then(user => {
                if (!user?.login || user.type === "Organization") throw new TeamLoadError("not_found", `@${key} is not a GitHub user.`);
                const value = { login: user.login, name: user.name || null, avatarUrl: user.avatar_url || null };
                profiles.set(key, { at: now(), value });
                return value;
            })
            .finally(() => profileRequests.delete(key));
        profileRequests.set(key, request);
        return request;
    }

    async function me() {
        if (!viewer) viewer = canonLogin((await limited(["api", "--hostname", "github.com", "user"])).login);
        return viewer;
    }

    async function detail({ repository, number }) {
        const [owner, name] = split(repository);
        const data = await gql(detailQuery, { owner, name, number });
        const node = data.repository?.issueOrPullRequest;
        if (!node) throw new TeamLoadError("not_found", `${repository}#${number} was not found.`);
        const pr = node.__typename === "PullRequest";
        return {
            kind: pr ? "pr" : "issue", repository, number: node.number, title: node.title, url: node.url,
            state: pr && node.merged ? "merged" : String(node.state).toLowerCase(), stateReason: node.stateReason ?? null, isDraft: !!node.isDraft,
            createdAt: node.createdAt, updatedAt: node.updatedAt, author: actor(node.author), labels: labels(node.labels),
            assignees: (node.assignees?.nodes ?? []).map(actor).filter(Boolean),
            bodyHTML: node.bodyHTML || "",
            comments: { total: node.comments?.totalCount ?? 0, nodes: (node.comments?.nodes ?? []).map(comment => ({ id: comment.databaseId ?? null, url: comment.url, createdAt: comment.createdAt, bodyHTML: comment.bodyHTML || "", author: actor(comment.author), canDelete: comment.viewerCanDelete === true && comment.viewerDidAuthor === true })) },
        };
    }

    // Fresh REST read, used to guard and verify writes.
    async function readIssue({ repository, number }) {
        split(repository);
        const issue = await limited(["api", "--hostname", "github.com", `repos/${repository}/issues/${number}`]);
        return { isPr: !!issue.pull_request, merged: !!issue.pull_request?.merged_at, state: issue.state, labels: (issue.labels ?? []).map(label => String(label.name)), assignees: (issue.assignees ?? []).map(user => canonLogin(user.login)).filter(Boolean) };
    }

    const handle = login => login === AGENT ? "@copilot" : login;
    const api = (method, path, body) => limited(["api", "--hostname", "github.com", "--method", method, path, ...(body ? ["--input", "-"] : [])], body ? { input: JSON.stringify(body) } : {});
    // `gh issue edit` is what starts the Copilot coding agent; PR assignees go through REST, which `gh issue edit` does not cover.
    async function editAssignee({ repository, number, login, isPr = false }, flag) {
        split(repository);
        if (isPr) await api(flag === "--add-assignee" ? "POST" : "DELETE", `repos/${repository}/issues/${number}/assignees`, { assignees: [login] });
        else await limited(["issue", "edit", String(number), "--repo", repository, flag, handle(login)], { json: false });
    }

    // `additional: false` is the triage guard (only an unowned issue can be claimed). `additional: true` adds
    // alongside existing assignees and is a no-op when the login is already assigned.
    async function assign({ repository, number, login, additional = false, issuesOnly = false, rollbackOnFailure = false }) {
        const before = await readIssue({ repository, number });
        if (before.isPr && issuesOnly) throw new TeamLoadError("invalid_input", `${repository}#${number} is a pull request. Sessions can only be started for issues.`);
        if (before.isPr && (login === AGENT || !additional)) throw new TeamLoadError("invalid_input", login === AGENT ? "Copilot can only be assigned to issues." : "Only issues can be triaged from Team Load.");
        if (before.state !== "open") throw new TeamLoadError("conflict", `${repository}#${number} is closed.`);
        if (additional && before.assignees.includes(login)) return { assignees: before.assignees, added: false };
        if (!additional && before.assignees.length) throw new TeamLoadError("conflict", `${repository}#${number} is already assigned to ${before.assignees.map(l => l === AGENT ? "Copilot" : `@${l}`).join(", ")}.`);
        try {
            await editAssignee({ repository, number, login, isPr: before.isPr }, "--add-assignee");
            const after = await readIssue({ repository, number });
            if (!after.assignees.includes(login)) throw new TeamLoadError("github_error", `GitHub accepted the change but ${login === AGENT ? "Copilot" : `@${login}`} is not assigned to ${repository}#${number}. Copilot may not be enabled for this repository.`);
            return { assignees: after.assignees, added: true };
        } catch (error) {
            if (!rollbackOnFailure) throw error;
            try {
                // The pre-write checks guarantee this login was not already assigned. Compensate even if the write response was lost.
                await editAssignee({ repository, number, login, isPr: before.isPr }, "--remove-assignee");
                const restored = await readIssue({ repository, number });
                if (restored.assignees.includes(login)) throw new TeamLoadError("github_error", `@${login} is still assigned.`);
            } catch (cleanup) {
                throw new TeamLoadError("write_uncertain", `Could not claim ${repository}#${number}, and undoing the claim could not be verified. @${login} may still be assigned; check it on GitHub. ${error.message} Rollback: ${cleanup.message}`);
            }
            throw error;
        }
    }

    async function unassign({ repository, number, login }) {
        const before = await readIssue({ repository, number });
        if (!before.assignees.includes(login)) return { assignees: before.assignees };
        await editAssignee({ repository, number, login, isPr: before.isPr }, "--remove-assignee");
        const after = await readIssue({ repository, number });
        if (after.assignees.includes(login)) throw new TeamLoadError("github_error", `Could not unassign ${login} from ${repository}#${number}.`);
        return { assignees: after.assignees };
    }

    async function reassign({ repository, number, from, login }) {
        if (from === login) throw new TeamLoadError("invalid_input", "Choose a different assignee to move the issue to.");
        const before = await readIssue({ repository, number });
        if (before.isPr) throw new TeamLoadError("invalid_input", "Only issues can be moved from Team Load.");
        if (before.state !== "open") throw new TeamLoadError("conflict", `${repository}#${number} is closed.`);
        if (!before.assignees.includes(from)) throw new TeamLoadError("conflict", `${repository}#${number} is no longer assigned to ${from}. Refresh before moving it.`);
        // Verify the new owner before removing the old one, so a rejected assignment never leaves the issue unowned.
        const assigned = await assign({ repository, number, login, additional: true });
        try {
            const result = await unassign({ repository, number, login: from });
            if (!result.assignees.includes(login)) throw new TeamLoadError("github_error", `${login} is no longer assigned.`);
            return { ...result, added: assigned.added };
        } catch (error) {
            throw new TeamLoadError("write_uncertain", `Could not verify the move of ${repository}#${number}. ${login} was assigned, but ${from} may still be assigned too. Refresh and check the assignees before trying again. ${error.message}`);
        }
    }

    const restComment = c => ({
        id: c.id, url: c.html_url, createdAt: c.created_at, bodyHTML: c.body_html || "", canDelete: true,
        author: actor(c.user ? { login: c.user.login, avatarUrl: c.user.avatar_url } : null),
    });

    async function comment({ repository, number, body }) {
        split(repository);
        const created = await limited(["api", "--hostname", "github.com", "--method", "POST", "-H", "Accept: application/vnd.github.html+json",
            `repos/${repository}/issues/${number}/comments`, "--input", "-"], { input: JSON.stringify({ body }) });
        return restComment(created);
    }

    // Only the viewer's own comments, and only on the item the canvas is showing.
    async function deleteComment({ repository, number, commentId }) {
        split(repository);
        const path = `repos/${repository}/issues/comments/${commentId}`;
        const existing = await limited(["api", "--hostname", "github.com", path]);
        if (!String(existing.issue_url ?? "").toLowerCase().endsWith(`/repos/${repository.toLowerCase()}/issues/${number}`)) {
            throw new TeamLoadError("invalid_input", `That comment is not on ${repository}#${number}.`);
        }
        if (canonLogin(existing.user?.login) !== await me()) throw new TeamLoadError("permission_denied", "You can only delete your own comments.");
        await limited(["api", "--hostname", "github.com", "--method", "DELETE", path], { json: false });
        return { deleted: commentId };
    }

    const labelCache = new Map();
    async function repoLabels(repository, { force = false } = {}) {
        const cached = labelCache.get(repository.toLowerCase());
        if (cached && !force && now() - cached.at < 5 * 60_000) return cached.labels;
        const list = await paginate(repoLabelsQuery, repository, "labels", label => ({ ...labels({ nodes: [label] })[0], description: label.description || "" }));
        labelCache.set(repository.toLowerCase(), { at: now(), labels: list });
        return list;
    }

    // Labels are checked against the repository's list first, because POSTing an unknown name would create a new label.
    async function editLabel({ repository, number, label, add }) {
        const known = (await repoLabels(repository)).find(l => l.name.toLowerCase() === label.toLowerCase())
            ?? (add ? (await repoLabels(repository, { force: true })).find(l => l.name.toLowerCase() === label.toLowerCase()) : null);
        if (add && !known) throw new TeamLoadError("invalid_input", `${repository} has no label named "${label}".`);
        const name = known?.name ?? label;
        const before = await readIssue({ repository, number });
        const has = before.labels.some(l => l.toLowerCase() === name.toLowerCase());
        if (add !== has) {
            if (add) await api("POST", `repos/${repository}/issues/${number}/labels`, { labels: [name] });
            else await api("DELETE", `repos/${repository}/issues/${number}/labels/${encodeURIComponent(name)}`);
        }
        const after = await readIssue({ repository, number });
        if (after.labels.some(l => l.toLowerCase() === name.toLowerCase()) !== add) throw new TeamLoadError("github_error", `Could not ${add ? "add" : "remove"} the ${name} label.`);
        const colors = new Map((await repoLabels(repository)).map(l => [l.name.toLowerCase(), l.color]));
        return { labels: after.labels.map(n => ({ name: n, color: colors.get(n.toLowerCase()) ?? "8c959f" })) };
    }

    async function setState({ repository, number, state }) {
        const before = await readIssue({ repository, number });
        if (before.merged) throw new TeamLoadError("conflict", `${repository}#${number} is merged.`);
        if (before.state !== state) {
            await limited([before.isPr ? "pr" : "issue", state === "closed" ? "close" : "reopen", String(number), "--repo", repository], { json: false });
            const after = await readIssue({ repository, number });
            if (after.state !== state) throw new TeamLoadError("github_error", `Could not ${state === "closed" ? "close" : "reopen"} ${repository}#${number}.`);
        }
        return { itemState: state };
    }

    return { fetchRepo, history, repoInfo, profile, remember, me, detail, readIssue, assign, unassign, reassign, comment, deleteComment, repoLabels, editLabel, setState };
}
