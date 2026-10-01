// Talks to the viewer server, starting it in the background when it is not
// running, so an agent never has to think about it: the first `show` brings the
// viewer up.

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "./config.ts";

export interface Health {
	ok: boolean;
	version: string;
	pid: number;
	viewers: number;
	home: string;
}

export class Client {
	readonly base: string;

	constructor(base: string) {
		this.base = base.endsWith("/") ? base : `${base}/`;
	}

	async health(): Promise<Health | null> {
		try {
			const response = await fetch(new URL("api/health", this.base), { signal: AbortSignal.timeout(1500) });
			if (!response.ok) return null;
			const body = (await response.json()) as Health;
			return body.ok ? body : null;
		} catch {
			return null;
		}
	}

	async get<T>(path: string): Promise<T> {
		const response = await fetch(new URL(path, this.base), { signal: AbortSignal.timeout(10_000) });
		return (await parse(response)) as T;
	}

	async post<T>(path: string, body: unknown): Promise<T> {
		const response = await fetch(new URL(path, this.base), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		return (await parse(response)) as T;
	}
}

async function parse(response: Response): Promise<unknown> {
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
	return body;
}

export function baseUrl(host: string, port: number): string {
	const name = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	return `http://${name}:${port}/`;
}

function cliPath(): string {
	const self = import.meta.url;
	return fileURLToPath(new URL(self.endsWith(".ts") ? "./cli.ts" : "./cli.js", self));
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

/**
 * Returns a client for a running server of this version over this store,
 * starting (or restarting) one in the background when needed.
 */
export async function ensureServer(options: { host: string; port: number; home: string; env?: NodeJS.ProcessEnv }): Promise<Client> {
	const client = new Client(baseUrl(options.host, options.port));
	const health = await client.health();
	if (health) {
		if (health.home !== options.home) {
			throw new Error(
				`port ${options.port} is used by an agent-dailies viewer over another store (${health.home}); set AGENT_DAILIES_PORT to use another port`,
			);
		}
		if (health.version === version()) return client;
		// An older viewer from before an upgrade: replace it so the page matches the CLI.
		await client.post("api/shutdown", {}).catch(() => undefined);
		for (let tries = 0; tries < 30 && (await client.health()); tries++) await sleep(100);
	}
	mkdirSync(options.home, { recursive: true });
	const log = openSync(join(options.home, "server.log"), "a");
	const child = spawn(process.execPath, [...process.execArgv, cliPath(), "serve", "--port", String(options.port), "--host", options.host], {
		detached: true,
		stdio: ["ignore", log, log],
		env: options.env ?? process.env,
	});
	child.unref();
	for (let tries = 0; tries < 50; tries++) {
		await sleep(100);
		if (await client.health()) return client;
	}
	throw new Error(`the viewer did not start; see ${join(options.home, "server.log")}`);
}

/** Opens a URL in the default browser without waiting for it. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): void {
	const custom = env.AGENT_DAILIES_BROWSER;
	const [command, args] = custom
		? [custom, [url]]
		: process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	try {
		spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
	} catch {
		// No browser to open; the URL is printed anyway.
	}
}
