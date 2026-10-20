import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TeamLoadError, normalizeTracking, validateConfig } from "./model.mjs";

export const extensionRoot = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(extensionRoot, "..", "..", "..");

export async function readConfig(path = join(extensionRoot, "config.json")) {
    try {
        return validateConfig(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
        if (error instanceof TeamLoadError) throw error;
        throw new TeamLoadError("invalid_config", `Cannot read Team Load config.json: ${error.message}`);
    }
}

const FORMAT = "tinyclips-team-load-tracking";

// Persists which people and repositories the canvas tracks, plus anything ever added (so it stays in the picker).
export function createTrackingStore(config, home = process.env.COPILOT_HOME || join(homedir(), ".copilot")) {
    const directory = join(home, "extension-data", "tinyclips-team-load");
    const path = join(directory, "tracking.json");
    const defaults = () => ({ people: [...config.people], repos: [...config.repositories], knownPeople: [], knownRepos: [] });
    let queue = Promise.resolve();

    async function read() {
        let raw;
        try { raw = await readFile(path, "utf8"); }
        catch (error) {
            if (error.code === "ENOENT") return defaults();
            throw new TeamLoadError("storage_error", `Cannot read tracking at ${path}: ${error.message}`);
        }
        try {
            const data = JSON.parse(raw);
            if (data.format !== FORMAT || data.version !== 1) throw new Error("unknown format or version");
            const tracking = normalizeTracking({ people: data.people, repos: data.repos });
            const known = normalizeTracking({ people: data.knownPeople ?? [], repos: data.knownRepos ?? [] });
            return { ...tracking, knownPeople: known.people, knownRepos: known.repos };
        } catch (error) {
            throw new TeamLoadError("storage_error", `Tracking file ${path} is invalid (${error.message}). Move or delete it to reset.`);
        }
    }

    function write(next) {
        const operation = queue.then(async () => {
            const current = await read();
            const tracking = normalizeTracking({ people: next.people, repos: next.repos });
            const lower = list => new Set(list.map(value => value.toLowerCase()));
            const defaultsPeople = lower(config.people);
            const defaultsRepos = lower([...config.repositories, ...config.availableRepositories]);
            const knownPeople = [...new Set([...current.knownPeople, ...tracking.people])].filter(login => !defaultsPeople.has(login)).slice(-50);
            const knownRepoMap = new Map([...current.knownRepos, ...tracking.repos].map(repo => [repo.toLowerCase(), repo]));
            const knownRepos = [...knownRepoMap.values()].filter(repo => !defaultsRepos.has(repo.toLowerCase())).slice(-30);
            const value = { ...tracking, knownPeople, knownRepos };
            const temporary = join(directory, `tracking.${randomUUID()}.tmp`);
            let created = false;
            try {
                await mkdir(directory, { recursive: true });
                await writeFile(temporary, `${JSON.stringify({ format: FORMAT, version: 1, ...value }, null, 2)}\n`, { flag: "wx" });
                created = true;
                await rename(temporary, path);
                created = false;
            } catch (error) {
                if (created) await unlink(temporary).catch(() => {});
                throw new TeamLoadError("storage_error", `Cannot save tracking at ${path}: ${error.message}`);
            }
            return value;
        });
        queue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    return { read, write, path };
}
