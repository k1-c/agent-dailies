// What an issue is about, for the viewer's issue card.
//
// agent-dailies does not talk to any tracker itself. The user may name a
// command that prints an issue as JSON — `linear-tui issue show {key} --json`,
// `gh issue view {key} --json title,body,state,url` — in their own config file
// (never a repository's: a repository should not get to run commands here).
// When a post names an issue, the CLI runs it in the background now and then
// and records what came back. Agents can also describe an issue themselves
// with `agent-dailies issue <key> --title … --description …`.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IssueEvent, Store } from "./store.ts";

export const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/;
const REFRESH_AFTER_MS = 30 * 60_000;

export interface IssueInfo {
	title?: string;
	description?: string;
	status?: string;
	url?: string;
	details?: string[];
}

interface Config {
	issueCommand?: string;
	projects?: Record<string, { issueCommand?: string }>;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.AGENT_DAILIES_CONFIG) return env.AGENT_DAILIES_CONFIG;
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-dailies", "config.json");
}

function readConfig(env: NodeJS.ProcessEnv): Config {
	try {
		return JSON.parse(readFileSync(configPath(env), "utf8")) as Config;
	} catch {
		return {};
	}
}

/** The command that prints an issue of this project as JSON, if the user set one. */
export function issueCommandFor(project: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.AGENT_DAILIES_ISSUE_COMMAND) return env.AGENT_DAILIES_ISSUE_COMMAND;
	const config = readConfig(env);
	return (project && config.projects?.[project]?.issueCommand) || config.issueCommand || undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function name(value: unknown): string | undefined {
	if (typeof value === "string") return text(value);
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return text(object.name) ?? text(object.displayName) ?? text(object.login) ?? text(object.title);
	}
	return undefined;
}

/** Reads the common shapes trackers print (Linear via linear-tui, GitHub via gh, Jira-like). */
export function normalizeIssue(raw: unknown): IssueInfo {
	const json = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const fields = (json.fields && typeof json.fields === "object" ? json.fields : {}) as Record<string, unknown>;
	const labels = Array.isArray(json.labels) ? json.labels.map(name).filter((value): value is string => Boolean(value)) : [];
	const details = [name(json.project), name(json.milestone), ...labels, name(json.assignee)].filter((value): value is string => Boolean(value));
	return {
		title: text(json.title) ?? text(fields.summary),
		description: text(json.description) ?? text(json.body) ?? text(fields.description),
		status: name(json.state) ?? name(json.status) ?? name(fields.status),
		url: text(json.url) ?? text(json.html_url),
		details: details.length ? [...new Set(details)] : undefined,
	};
}

/** Runs the issue command for a key and reads its JSON. */
export function fetchIssue(command: string, key: string, cwd?: string): Promise<IssueInfo> {
	if (!ISSUE_KEY.test(key)) return Promise.reject(new Error(`not an issue key: ${key}`));
	// The key is checked above, so it can go into the command as it is.
	const line = command.includes("{key}") ? command.replaceAll("{key}", key) : `${command} ${key}`;
	return new Promise((resolve, reject) => {
		execFile("sh", ["-c", line], { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			if (error) return reject(new Error(`${line}: ${error.message.split("\n")[0]}`));
			try {
				resolve(normalizeIssue(JSON.parse(stdout)));
			} catch {
				reject(new Error(`${line}: did not print JSON`));
			}
		});
	});
}

export function sameIssue(event: IssueEvent | undefined, info: IssueInfo): boolean {
	if (!event) return false;
	return (
		event.title === info.title &&
		event.description === info.description &&
		event.status === info.status &&
		event.url === info.url &&
		JSON.stringify(event.details ?? []) === JSON.stringify(info.details ?? [])
	);
}

// When each issue was last fetched: local bookkeeping, not part of the shared log.
function fetchedPath(store: Store): string {
	return join(store.home, "issues-fetched.json");
}

export function dueForRefresh(store: Store, key: string, now: number = Date.now()): boolean {
	try {
		const fetched = (JSON.parse(readFileSync(fetchedPath(store), "utf8")) as Record<string, string>)[key.toUpperCase()];
		return !fetched || now - Date.parse(fetched) > REFRESH_AFTER_MS;
	} catch {
		return true;
	}
}

export function markFetched(store: Store, key: string, now: Date = new Date()): void {
	let fetched: Record<string, string> = {};
	try {
		fetched = JSON.parse(readFileSync(fetchedPath(store), "utf8")) as Record<string, string>;
	} catch {
		fetched = {};
	}
	fetched[key.toUpperCase()] = now.toISOString();
	mkdirSync(store.home, { recursive: true });
	writeFileSync(fetchedPath(store), `${JSON.stringify(fetched)}\n`);
}
