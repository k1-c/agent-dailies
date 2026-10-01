#!/usr/bin/env node
// agent-dailies: a live review page for what a coding agent makes.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import * as config from "./config.ts";
import { baseUrl, Client, ensureServer, openBrowser } from "./client.ts";
import { describeFeedback, hasComment, markDelivered, orphanedIn, pendingFor, postedBy, readSession, writeSession } from "./feedback.ts";
import { guideText, preToolUse } from "./hook.ts";
import { DailiesServer, type Context } from "./server.ts";
import {
	buildPost,
	Store,
	type Catalog,
	type CommentEvent,
	type Item,
	type PostInput,
	type PostView,
	type Selection,
	type VerdictEvent,
} from "./store.ts";
import { detectWhere } from "./where.ts";

const HELP = `agent-dailies ${config.version()} — a live review page for what your coding agent makes

Usage:
  agent-dailies show <file>… [--title T] [--note N] [--tag X]… [--issue ID] [--lane L] [--no-open] [--json]
      Put files at the top of the viewer (images, videos, audio, GLB, PDF, text…).
      Starts the viewer if needed; opens the browser only when no viewer tab is open.
  agent-dailies context [--json]      What the user selected in the viewer (or the newest post)
  agent-dailies feedback [--since 2h|ISO] [--all] [--json]
                                      The user's marks and comments, for this worktree (or --all)
  agent-dailies list [--limit N] [--all] [--json]
                                      Recent posts, for this worktree (or --all)
  agent-dailies watch [--session ID] [--timeout 110m]
                                      Wait until the user comments on this session's posts, print it, exit.
                                      Run it in the background: its exit wakes the agent up.
  agent-dailies get <item-id|post-id:n> [--to PATH]
                                      Print a stored file's path, or copy it to PATH
  agent-dailies open                  Open the viewer in the browser
  agent-dailies status [--json]       Whether the viewer runs, and where the store is
  agent-dailies serve [--port P] [--host H]
                                      Run the viewer in the foreground
  agent-dailies stop                  Stop the background viewer
  agent-dailies guide                 Instructions for coding agents
  agent-dailies hook pre-tool-use     Claude Code / Codex hook: stop opening media in windows
  agent-dailies hook session-start    Claude Code / Codex hook: print the guide and unread feedback
  agent-dailies hook user-prompt-submit  Claude Code hook: pass on feedback with the user's next message
  agent-dailies hook stop             Claude Code hook: hand over comments before the agent stops

Environment:
  AGENT_DAILIES_HOME   store location (default: $XDG_DATA_HOME/agent-dailies)
  AGENT_DAILIES_PORT   viewer port (default: ${config.DEFAULT_PORT})
  AGENT_DAILIES_HOST   address to listen on (default: ${config.DEFAULT_HOST}; 0.0.0.0 to reach it from other machines)
  AGENT_DAILIES_NO_OPEN=1   never open a browser from \`show\`
  AGENT_DAILIES_BROWSER     command to open URLs with
`;

type Values = Record<string, string | boolean | string[] | undefined>;

function parse(args: string[], options: ParseArgsConfig["options"]): { values: Values; positionals: string[] } {
	const { values, positionals } = parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true });
	return { values: values as Values, positionals };
}

function out(text: string): void {
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

// Ends the process once stdout has drained. `watch` needs this: an aborted
// event stream can leave a socket that would otherwise keep it alive, and its
// exit is what wakes the agent.
function finish(text: string): Promise<never> {
	return new Promise(() => {
		process.stdout.write(text.endsWith("\n") ? text : `${text}\n`, () => process.exit(0));
	});
}

function store(): Store {
	return new Store(config.dataHome(), config.machine());
}

function client(): Client {
	return new Client(baseUrl(config.host(), config.port()));
}

function ago(at: string, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

function since(value: string | undefined, fallbackMs: number): string {
	if (!value) return new Date(Date.now() - fallbackMs).toISOString();
	const relative = /^(\d+)\s*(m|min|h|d)$/.exec(value);
	if (relative) {
		const unit = relative[2] === "d" ? 86_400_000 : relative[2] === "h" ? 3_600_000 : 60_000;
		return new Date(Date.now() - Number(relative[1]) * unit).toISOString();
	}
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) throw new Error(`--since: not a time or duration: ${value}`);
	return new Date(parsed).toISOString();
}

async function show(args: string[]): Promise<void> {
	const { values, positionals } = parse(args, {
		title: { type: "string", short: "t" },
		note: { type: "string", short: "n" },
		tag: { type: "string", multiple: true },
		issue: { type: "string" },
		lane: { type: "string" },
		project: { type: "string" },
		"no-open": { type: "boolean" },
		json: { type: "boolean" },
	});
	if (values.help || positionals.length === 0) return out("Usage: agent-dailies show <file>… [--title T] [--note N] [--tag X]… [--issue ID] [--no-open] [--json]");
	const missing = positionals.filter((file) => !existsSync(file));
	if (missing.length) throw new Error(`no such file: ${missing.join(", ")}`);

	const target = store();
	const items: Item[] = [];
	for (const file of positionals) items.push(await target.addFile(resolve(file)));
	const where = detectWhere();
	const input: PostInput = {
		...where,
		project: (values.project as string | undefined) ?? where.project,
		lane: (values.lane as string | undefined) ?? where.lane,
		issue: (values.issue as string | undefined) ?? where.issue,
		title: values.title as string | undefined,
		note: values.note as string | undefined,
		tags: (values.tag as string[] | undefined) ?? [],
		items,
	};

	let post: PostView;
	let url: string;
	let viewers = 0;
	let live = true;
	try {
		const viewer = await ensureServer({ host: config.host(), port: config.port(), home: target.home });
		const result = await viewer.post<{ post: PostView; viewers: number; url: string }>("api/posts", input);
		post = result.post;
		url = result.url;
		viewers = result.viewers;
	} catch (error) {
		// Keep the post even when the viewer cannot run; it shows up once it does.
		const event = buildPost(input, target.machine);
		target.append(event);
		post = { ...event, items: event.items.map((item) => ({ ...item, verdict: null })), comments: [] };
		url = `${baseUrl(config.host(), config.port())}#${post.id}`;
		live = false;
		process.stderr.write(`agent-dailies: the viewer is not running (${error instanceof Error ? error.message : error}); the post is saved.\n`);
	}
	const shouldOpen = live && viewers === 0 && !values["no-open"] && process.env.AGENT_DAILIES_NO_OPEN !== "1";
	if (shouldOpen) openBrowser(url);

	if (values.json) return out(JSON.stringify({ post, url, viewers, opened: shouldOpen }, null, 2));
	const lines = [`Shown ${items.length === 1 ? "1 file" : `${items.length} files`} in the viewer: ${url}`];
	post.items.forEach((item, index) => lines.push(`  ${index + 1}. ${item.name}  (${item.id})`));
	if (!live) lines.push("The viewer is not running, so nobody sees it yet.");
	else if (shouldOpen) lines.push("No viewer tab was open, so it was opened in the browser.");
	else if (viewers > 0) lines.push(`The viewer is open in ${viewers === 1 ? "1 tab" : `${viewers} tabs`}; it updated in place. No need to open anything.`);
	if (live && where.session) {
		lines.push("To hear the user's comments on it, keep `agent-dailies watch` running in the background (it exits, waking you, when they comment).");
	}
	out(lines.join("\n"));
}

// Reads the context from the running viewer, or from the store when it is down.
async function readContext(): Promise<{ context: Context; running: boolean; catalog?: Catalog }> {
	const viewer = client();
	const target = store();
	const health = await viewer.health();
	if (health && health.home === target.home) return { context: await viewer.get<Context>("api/context"), running: true };
	const catalog = target.load();
	const selection: Selection | null = target.readSelection();
	const selected = selection ? catalog.post(selection.post) : undefined;
	const post = selected ?? catalog.posts[catalog.posts.length - 1];
	return {
		context: {
			viewers: 0,
			url: baseUrl(config.host(), config.port()),
			selection: selected ? selection : null,
			post: post ? catalog.view(post) : null,
			selected: Boolean(selected),
		},
		running: false,
		catalog,
	};
}

function describePost(post: PostView): string {
	const where = [post.lane, post.issue].filter(Boolean).join(" · ");
	return `${post.title ? `"${post.title}"` : post.items.map((item) => item.name).join(", ")} (${post.id}; ${where}; ${ago(post.at)})`;
}

async function context(args: string[]): Promise<void> {
	const { values } = parse(args, { json: { type: "boolean" } });
	const { context: ctx, running } = await readContext();
	const target = store();
	if (values.json) {
		const post = ctx.post && {
			...ctx.post,
			items: ctx.post.items.map((item) => ({ ...item, path: target.blobPath(item.sha256, item.ext) })),
		};
		return out(JSON.stringify({ ...ctx, post, running }, null, 2));
	}
	const lines = ["# What the user is looking at in agent-dailies", ""];
	lines.push(
		running
			? `Viewer: ${ctx.viewers ? `open in ${ctx.viewers === 1 ? "1 tab" : `${ctx.viewers} tabs`}` : "running, but no tab is open"} — ${ctx.url}`
			: "Viewer: not running (this is what was selected last).",
	);
	if (!ctx.post) {
		lines.push("", "Nothing has been shown yet.");
		return out(lines.join("\n"));
	}
	lines.push(ctx.selected ? `Selected post: ${describePost(ctx.post)}` : `Nothing is selected; the newest post is ${describePost(ctx.post)}`);
	if (ctx.post.note) lines.push(`Note: ${ctx.post.note}`);
	lines.push("", "## Files");
	ctx.post.items.forEach((item, index) => {
		const selected = ctx.selection?.item === item.id ? " ← selected" : "";
		const verdict = item.verdict ? ` — ${item.verdict}` : "";
		lines.push(`${index + 1}. ${item.name} (${item.id})${selected}${verdict}`);
		lines.push(`   ${target.blobPath(item.sha256, item.ext)}`);
	});
	if (ctx.post.comments.length) {
		lines.push("", "## Comments");
		const names = new Map(ctx.post.items.map((item) => [item.id, item.name]));
		for (const comment of ctx.post.comments) {
			const on = comment.item ? ` on ${names.get(comment.item) ?? comment.item}` : "";
			lines.push(`- ${comment.by}, ${ago(comment.at)}${on}: ${comment.text}`);
		}
	}
	out(lines.join("\n"));
}

async function loadCatalog(): Promise<Catalog> {
	return store().load();
}

async function feedback(args: string[]): Promise<void> {
	const { values } = parse(args, { since: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } });
	const catalog = await loadCatalog();
	const from = since(values.since as string | undefined, 7 * 86_400_000);
	const where = detectWhere();
	const entries = catalog.history.filter((event) => {
		if (event.at <= from || event.by !== "human") return false;
		if (values.all) return true;
		const post = catalog.post(event.post);
		return post?.project === where.project && post.lane === where.lane;
	});
	if (values.json) return out(JSON.stringify({ since: from, history: entries }, null, 2));
	const scope = values.all ? "all worktrees" : `${where.project} › ${where.lane}`;
	if (!entries.length) return out(`No marks or comments from the user since ${from} (${scope}).`);
	const lines = [`# The user's feedback (${scope}, since ${from})`, ""];
	for (const event of [...entries].reverse()) {
		const post = catalog.post(event.post);
		const item = post?.items.find((candidate) => candidate.id === (event as VerdictEvent | CommentEvent).item);
		const about = `${item ? `${item.name} (${item.id}) in ` : ""}${post ? describePost(catalog.view(post)) : event.post}`;
		if (event.type === "verdict") lines.push(`- ${ago(event.at)}: ${event.verdict ?? "cleared the mark on"} ${about}`);
		else lines.push(`- ${ago(event.at)}: commented on ${about}: ${event.text}`);
	}
	out(lines.join("\n"));
}

async function list(args: string[]): Promise<void> {
	const { values } = parse(args, { limit: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } });
	const catalog = await loadCatalog();
	const where = detectWhere();
	const posts = catalog.list({
		limit: Number(values.limit) || 10,
		...(values.all ? {} : { project: where.project, lane: where.lane }),
	});
	if (values.json) return out(JSON.stringify(posts, null, 2));
	if (!posts.length) return out("Nothing shown here yet.");
	const lines: string[] = [];
	for (const post of posts) {
		lines.push(`- ${describePost(post)}`);
		post.items.forEach((item, index) => lines.push(`    ${index + 1}. ${item.name} (${item.id})${item.verdict ? ` — ${item.verdict}` : ""}`));
	}
	out(lines.join("\n"));
}

async function get(args: string[]): Promise<void> {
	const { values, positionals } = parse(args, { to: { type: "string" } });
	const ref = positionals[0];
	if (!ref) throw new Error("Usage: agent-dailies get <item-id|post-id:n> [--to PATH]");
	const target = store();
	const catalog = target.load();
	let item: Item | undefined;
	const numbered = /^(p_[a-z0-9]+):(\d+)$/.exec(ref);
	if (numbered) item = catalog.post(numbered[1]!)?.items[Number(numbered[2]) - 1];
	else item = catalog.postOfItem(ref)?.items.find((candidate) => candidate.id === ref);
	if (!item) throw new Error(`no item ${ref}`);
	const path = target.blobPath(item.sha256, item.ext);
	if (values.to) {
		const to = resolve(values.to as string);
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(path, to);
		return out(to);
	}
	out(path);
}

function sessionOf(value: unknown): string | undefined {
	return (typeof value === "string" && value) || process.env.CLAUDE_CODE_SESSION_ID || process.env.AGENT_DAILIES_SESSION || undefined;
}

function duration(value: string | undefined, fallbackMs: number): number {
	if (!value) return fallbackMs;
	const match = /^(\d+)\s*(s|m|min|h)?$/.exec(value);
	if (!match) throw new Error(`not a duration: ${value}`);
	const unit = match[2] === "h" ? 3_600_000 : match[2] === "s" ? 1000 : 60_000;
	return Number(match[1]) * unit;
}

const WATCH_AGAIN = "When you have dealt with it, start `agent-dailies watch` in the background again to hear the next comment.";

async function watch(args: string[]): Promise<void> {
	const { values } = parse(args, { session: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean" } });
	const session = sessionOf(values.session);
	if (!session) throw new Error("no agent session (CLAUDE_CODE_SESSION_ID); pass --session ID");
	const target = store();
	const timeoutMs = duration(values.timeout as string | undefined, 110 * 60_000);

	const deliver = async (): Promise<void> => {
		const catalog = target.load();
		const pending = pendingFor(catalog, target, session);
		if (!hasComment(pending)) return;
		markDelivered(target, session, pending);
		await finish(
			values.json
				? JSON.stringify({ session, feedback: pending }, null, 2)
				: ["The user left feedback in agent-dailies:", ...describeFeedback(catalog, pending), "", WATCH_AGAIN].join("\n"),
		);
	};
	await deliver();

	const deadline = Date.now() + timeoutMs;
	const viewer = await ensureServer({ host: config.host(), port: config.port(), home: target.home });
	const { watching } = await viewer.get<{ watching: number }>(`api/watchers?session=${encodeURIComponent(session)}`);
	if (watching > 0) await finish("Already watching for this session in another process; nothing else to start.");

	while (Date.now() < deadline) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), deadline - Date.now());
		try {
			const response = await fetch(new URL(`api/watch?session=${encodeURIComponent(session)}`, viewer.base), { signal: controller.signal });
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of response.body) {
				buffer += decoder.decode(chunk as Uint8Array, { stream: true });
				if (!buffer.includes("event: feedback")) {
					buffer = buffer.slice(-64);
					continue;
				}
				// Comments often come in a burst; give the rest a moment to land.
				await new Promise((done) => setTimeout(done, 2000));
				await deliver();
				buffer = "";
			}
		} catch (error) {
			if (controller.signal.aborted && Date.now() >= deadline) break;
			void error;
		} finally {
			clearTimeout(timer);
		}
		// The viewer went away (an upgrade, a restart): bring it back and keep waiting.
		if (Date.now() < deadline) {
			await new Promise((done) => setTimeout(done, 1000));
			await ensureServer({ host: config.host(), port: config.port(), home: target.home }).catch(() => undefined);
		}
	}
	await finish(`No comments in ${Math.round(timeoutMs / 60_000)} min. Start \`agent-dailies watch\` in the background again if you still want to hear them.`);
}

async function status(args: string[]): Promise<void> {
	const { values } = parse(args, { json: { type: "boolean" } });
	const health = await client().health();
	const target = store();
	const info = {
		version: config.version(),
		home: target.home,
		machine: target.machine,
		url: baseUrl(config.host(), config.port()),
		running: Boolean(health),
		viewers: health?.viewers ?? 0,
		pid: health?.pid,
		posts: target.load().posts.length,
	};
	if (values.json) return out(JSON.stringify(info, null, 2));
	out(
		[
			`agent-dailies ${info.version}`,
			`store:   ${info.home} (${info.posts} posts, machine ${info.machine})`,
			`viewer:  ${info.running ? `running at ${info.url} (pid ${info.pid}, ${info.viewers} tab${info.viewers === 1 ? "" : "s"} open)` : "not running"}`,
		].join("\n"),
	);
}

async function serve(args: string[]): Promise<void> {
	const { values } = parse(args, { port: { type: "string" }, host: { type: "string" } });
	const port = values.port ? Number(values.port) : config.port();
	const host = (values.host as string | undefined) ?? config.host();
	const server = new DailiesServer(store(), {
		host,
		allowedHosts: (process.env.AGENT_DAILIES_ALLOWED_HOSTS ?? "").split(",").filter(Boolean),
	});
	try {
		await server.listen(port);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new Error(code === "EADDRINUSE" ? `port ${port} is in use; set AGENT_DAILIES_PORT to another port` : String(error));
	}
	out(`agent-dailies ${config.version()} viewer at ${server.url} (store ${server.store.home})`);
	const stop = () => void server.close().then(() => process.exit(0));
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

async function stop(): Promise<void> {
	const viewer = client();
	if (!(await viewer.health())) return out("The viewer is not running.");
	await viewer.post("api/shutdown", {});
	out("Stopped the viewer.");
}

async function openViewer(): Promise<void> {
	const target = store();
	await ensureServer({ host: config.host(), port: config.port(), home: target.home });
	const url = baseUrl(config.host(), config.port());
	openBrowser(url);
	out(url);
}

interface HookInput {
	session_id?: string;
	cwd?: string;
	stop_hook_active?: boolean;
	[key: string]: unknown;
}

const REMIND_WITHIN_MS = 12 * 3_600_000;

// Exit code 2 from a hook blocks the step (a tool call, or stopping) and hands
// stderr to the agent; plain stdout from SessionStart and UserPromptSubmit is
// added to the agent's context.
async function hook(args: string[]): Promise<void> {
	const kind = args[0];
	let input: HookInput = {};
	try {
		input = JSON.parse(process.stdin.isTTY ? "{}" : readFileSync(0, "utf8") || "{}") as HookInput;
	} catch {
		input = {};
	}
	const target = store();
	switch (kind) {
		case "pre-tool-use": {
			const decision = preToolUse(input);
			if (decision.block) {
				process.stderr.write(`${decision.message}\n`);
				process.exitCode = 2;
			}
			return;
		}
		case "session-start": {
			const lines = [guideText()];
			const where = detectWhere(input.cwd || process.cwd());
			const catalog = target.load();
			const live = new Set<string>();
			const viewer = client();
			if (await viewer.health()) {
				for (const session of new Set(catalog.posts.map((post) => post.session).filter((value): value is string => Boolean(value)))) {
					const { watching } = await viewer.get<{ watching: number }>(`api/watchers?session=${encodeURIComponent(session)}`).catch(() => ({ watching: 0 }));
					if (watching) live.add(session);
				}
			}
			const orphaned = orphanedIn(catalog, target, where.project, where.lane, input.session_id).filter(
				(event) => !live.has(catalog.post(event.post)?.session ?? ""),
			);
			if (orphaned.length) {
				lines.push("", "Feedback the user left in this worktree's viewer that no session has read yet:", ...describeFeedback(catalog, orphaned));
				const bySession = new Map<string, typeof orphaned>();
				for (const event of orphaned) {
					const session = catalog.post(event.post)?.session;
					if (session) bySession.set(session, [...(bySession.get(session) ?? []), event]);
				}
				for (const [session, events] of bySession) markDelivered(target, session, events);
			}
			return out(lines.join("\n"));
		}
		case "user-prompt-submit": {
			const session = input.session_id;
			if (!session) return;
			const catalog = target.load();
			const pending = pendingFor(catalog, target, session);
			if (!pending.length) return;
			markDelivered(target, session, pending);
			return out(["Feedback from the agent-dailies viewer since you last heard (marks and comments on what you showed):", ...describeFeedback(catalog, pending)].join("\n"));
		}
		case "stop": {
			const session = input.session_id;
			if (!session) return;
			const catalog = target.load();
			const shown = postedBy(catalog, session);
			if (!shown.length) return;
			const pending = pendingFor(catalog, target, session);
			if (hasComment(pending)) {
				markDelivered(target, session, pending);
				process.stderr.write(`${["The user commented in agent-dailies while you were working:", ...describeFeedback(catalog, pending)].join("\n")}\n`);
				process.exitCode = 2;
				return;
			}
			if (input.stop_hook_active || process.env.AGENT_DAILIES_AUTO_WATCH === "0") return;
			const latest = postedBy(catalog, session, REMIND_WITHIN_MS).at(-1);
			if (!latest || readSession(target, session).reminded === latest.id) return;
			const viewer = client();
			const health = await viewer.health();
			if (!health || health.home !== target.home) return;
			const { watching } = await viewer.get<{ watching: number }>(`api/watchers?session=${encodeURIComponent(session)}`);
			writeSession(target, session, { reminded: latest.id });
			if (watching > 0) return;
			process.stderr.write(
				"You showed the user something in agent-dailies and nothing is listening for their comments. " +
					"Start `agent-dailies watch` with run_in_background (timeout 7200000) so a comment wakes you, then finish.\n",
			);
			process.exitCode = 2;
			return;
		}
		default:
			throw new Error("Usage: agent-dailies hook <pre-tool-use|session-start|user-prompt-submit|stop>");
	}
}

async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	switch (command) {
		case "show":
			return show(rest);
		case "context":
			return context(rest);
		case "feedback":
			return feedback(rest);
		case "list":
			return list(rest);
		case "get":
			return get(rest);
		case "watch":
			return watch(rest);
		case "status":
			return status(rest);
		case "serve":
			return serve(rest);
		case "stop":
			return stop();
		case "open":
			return openViewer();
		case "guide":
			return out(guideText());
		case "hook":
			return hook(rest);
		case "--version":
		case "-v":
		case "version":
			return out(config.version());
		case undefined:
		case "help":
		case "--help":
		case "-h":
			return out(HELP);
		default:
			throw new Error(`unknown command: ${command}\n\n${HELP}`);
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`agent-dailies: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
