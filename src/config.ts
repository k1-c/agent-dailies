// Where agent-dailies keeps its files and which port the viewer listens on.
// Everything is overridable by environment variables so tests (and people
// running two setups side by side) never touch the real store.

import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const DEFAULT_PORT = 4777;
export const DEFAULT_HOST = "127.0.0.1";

export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
	if (env.AGENT_DAILIES_HOME) return env.AGENT_DAILIES_HOME;
	const xdg = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(xdg, "agent-dailies");
}

export function port(env: NodeJS.ProcessEnv = process.env): number {
	const value = Number(env.AGENT_DAILIES_PORT);
	return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT;
}

export function host(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENT_DAILIES_HOST || DEFAULT_HOST;
}

// The machine name goes into every event so that, once the store syncs between
// machines, each one appends to its own log and the logs never conflict.
export function machine(env: NodeJS.ProcessEnv = process.env): string {
	const name = env.AGENT_DAILIES_MACHINE || hostname() || "local";
	return name.replace(/[^A-Za-z0-9._-]/g, "-");
}

let cachedVersion: string | undefined;

export function version(): string {
	if (cachedVersion) return cachedVersion;
	const url = new URL("../package.json", import.meta.url);
	cachedVersion = (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
	return cachedVersion;
}
