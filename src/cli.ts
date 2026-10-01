#!/usr/bin/env node
// agent-dailies: a live review page for what a coding agent makes.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import * as config from "./config.ts";
import { baseUrl, Client, ensureServer, openBrowser } from "./client.ts";
import { collect, commitsBetween, headOf, keepTranscript, repositoryRoot, splitSections, summaryMarkdown, transcriptDir } from "./devlog.ts";
import { describeAnswer, describeFeedback, hasMessage, markDelivered, orphanedIn, pendingFor, postedBy, readSession, writeSession } from "./feedback.ts";
import { guideText, preToolUse } from "./hook.ts";
import { dueForRefresh, fetchIssue, ISSUE_KEY, issueCommandFor, markFetched, sameIssue, type IssueInfo } from "./issues.ts";
import { DailiesServer, type Context } from "./server.ts";
import {
	buildPost,
	newId,
	Store,
	type AnswerEvent,
	type Catalog,
	type CommitRef,
	type CutEvent,
	type IssueEvent,
	type CommentEvent,
	type Item,
	type PostInput,
	type PostView,
	type Question,
	type Selection,
	type VerdictEvent,
} from "./store.ts";
import { detectWhere } from "./where.ts";

const HELP = `agent-dailies ${config.version()} — a live review page for what your coding agent makes

Usage:
  agent-dailies show <file>… [--title T] [--note N] [--tag X]… [--issue ID] [--lane L] [--no-open] [--json]
      Put files at the top of the viewer (images, videos, audio, GLB, PDF, text…).
      Starts the viewer if needed; opens the browser only when no viewer tab is open.
  agent-dailies ask "<question>" [file…] [--option TEXT]… [--why TEXT] [--multi] [--wait] [--json]
  agent-dailies ask --file questions.json [--wait] [--json]
      Ask the user to decide: files and/or sentences become options A, B, C… they pick from in
      the viewer. --file takes several questions (a review sheet). --wait blocks until answered.
  agent-dailies wait <post-id> [--timeout 110m]
                                      Wait until a question post is answered (run it in the background)
  agent-dailies context [--json]      What the user selected in the viewer (or the newest post)
  agent-dailies feedback [--since 2h|ISO] [--all] [--json]
                                      The user's marks and comments, for this worktree (or --all)
  agent-dailies list [--limit N] [--all] [--json]
                                      Recent posts, for this worktree (or --all)
  agent-dailies watch [--session ID] [--timeout 110m]
                                      Wait until the user comments on this session's posts, print it, exit.
                                      Run it in the background: its exit wakes the agent up.
  agent-dailies issue [KEY] [--refresh] [--title T] [--description TEXT|-] [--status S] [--url U]
                                      Show or set what an issue is about (the viewer's issue card).
                                      --refresh runs your issueCommand (config file) for it.
  agent-dailies devlog <add|list|summary|cut|sweep> …
                                      The devlog: record what changed (with before/after), and gather a
                                      period's entries, decisions, commits and transcripts for a summary
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
  agent-dailies hook stop             Claude Code hook: hand over comments; suggest a devlog entry after commits
  agent-dailies hook session-end      Claude Code hook: keep the session's transcript

Environment:
  AGENT_DAILIES_HOME   store location (default: $XDG_DATA_HOME/agent-dailies)
  AGENT_DAILIES_PORT   viewer port (default: ${config.DEFAULT_PORT})
  AGENT_DAILIES_HOST   address to listen on (default: ${config.DEFAULT_HOST}; 0.0.0.0 to reach it from other machines)
  AGENT_DAILIES_NO_OPEN=1   never open a browser from \`show\`
  AGENT_DAILIES_BROWSER     command to open URLs with
  AGENT_DAILIES_ISSUE_COMMAND  command printing an issue as JSON ({key} is replaced), e.g.
                            "linear-tui issue show {key} --json" — or set "issueCommand" in
                            $XDG_CONFIG_HOME/agent-dailies/config.json (per project: "projects")
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

interface Published {
	post: PostView;
	url: string;
	viewers: number;
	live: boolean;
	opened: boolean;
}

const WHERE_OPTIONS = {
	title: { type: "string", short: "t" },
	note: { type: "string", short: "n" },
	tag: { type: "string", multiple: true },
	issue: { type: "string" },
	lane: { type: "string" },
	project: { type: "string" },
	"no-open": { type: "boolean" },
	json: { type: "boolean" },
} as const;

function postInput(values: Values, items: Item[], extra: Partial<PostInput> = {}): PostInput {
	const where = detectWhere();
	return {
		...where,
		project: (values.project as string | undefined) ?? where.project,
		lane: (values.lane as string | undefined) ?? where.lane,
		issue: (values.issue as string | undefined) ?? where.issue,
		title: values.title as string | undefined,
		note: values.note as string | undefined,
		tags: (values.tag as string[] | undefined) ?? [],
		items,
		...extra,
	};
}

// Hands a post to the viewer (starting it if needed) and opens the browser
// when no tab is open. Keeps the post even when the viewer cannot run.
async function publish(target: Store, input: PostInput, values: Values): Promise<Published> {
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
		const event = buildPost(input, target.machine);
		target.append(event);
		post = { ...event, items: event.items.map((item) => ({ ...item, verdict: null })), comments: [], answers: {} };
		url = `${baseUrl(config.host(), config.port())}#${post.id}`;
		live = false;
		process.stderr.write(`agent-dailies: the viewer is not running (${error instanceof Error ? error.message : error}); the post is saved.\n`);
	}
	const opened = live && viewers === 0 && !values["no-open"] && process.env.AGENT_DAILIES_NO_OPEN !== "1";
	if (opened) openBrowser(url);
	refreshIssueLater(target, input);
	return { post, url, viewers, live, opened };
}

// Fetches the post's issue from the tracker in the background, now and then,
// when the user configured an issue command (see src/issues.ts).
function refreshIssueLater(target: Store, input: PostInput): void {
	const key = input.issue?.toUpperCase();
	if (!key || !ISSUE_KEY.test(key) || !issueCommandFor(input.project) || !dueForRefresh(target, key)) return;
	markFetched(target, key);
	const cli = fileURLToPath(import.meta.url);
	spawn(process.execPath, [...process.execArgv, cli, "issue", key, "--refresh", "--quiet", "--project", input.project], {
		cwd: input.cwd && existsSync(input.cwd) ? input.cwd : undefined,
		detached: true,
		stdio: "ignore",
	}).unref();
}

async function recordIssue(target: Store, body: Record<string, unknown>): Promise<IssueEvent> {
	try {
		const viewer = await ensureServer({ host: config.host(), port: config.port(), home: target.home });
		return await viewer.post<IssueEvent>("api/issues", body);
	} catch {
		// No viewer: write it down directly; it shows once the viewer runs.
		const catalog = target.load();
		const key = String(body.key).toUpperCase();
		const current = catalog.issue(key);
		const info = body as IssueInfo;
		const merged = body.merge && current ? { ...current, ...Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) } : info;
		if (current && sameIssue(current, merged)) return current;
		const event: IssueEvent = {
			type: "issue",
			id: newId("s"),
			at: new Date().toISOString(),
			machine: target.machine,
			key,
			title: merged.title,
			description: merged.description,
			status: merged.status,
			url: merged.url,
			details: merged.details,
			by: "agent",
		};
		target.append(event);
		return event;
	}
}

async function issue(args: string[]): Promise<void> {
	const { values, positionals } = parse(args, {
		refresh: { type: "boolean" },
		title: { type: "string" },
		description: { type: "string" },
		status: { type: "string" },
		url: { type: "string" },
		detail: { type: "string", multiple: true },
		project: { type: "string" },
		quiet: { type: "boolean" },
		json: { type: "boolean" },
	});
	const key = (positionals[0] ?? detectWhere().issue ?? "").toUpperCase();
	if (!ISSUE_KEY.test(key)) {
		throw new Error(
			"Usage: agent-dailies issue <KEY> [--refresh] [--title T] [--description TEXT|-] [--status S] [--url U] [--detail X]… [--json]",
		);
	}
	const target = store();
	let event: IssueEvent | undefined;
	if (values.refresh) {
		const project = (values.project as string | undefined) ?? detectWhere().project;
		const command = issueCommandFor(project);
		if (!command) throw new Error(`no issue command is set; put "issueCommand" in ${configPathText()}`);
		markFetched(target, key);
		const info = await fetchIssue(command, key, process.cwd());
		event = await recordIssue(target, { key, ...info, by: "agent" });
	} else if (values.title || values.description || values.status || values.url || values.detail) {
		const description = values.description === "-" ? readFileSync(0, "utf8") : (values.description as string | undefined);
		event = await recordIssue(target, {
			key,
			title: values.title,
			description,
			status: values.status,
			url: values.url,
			details: values.detail,
			merge: true,
			by: "agent",
		});
	} else {
		event = target.load().issue(key);
	}
	if (values.quiet) return;
	if (values.json) return out(JSON.stringify(event ?? null, null, 2));
	if (!event) return out(`Nothing is known about ${key} yet. Describe it with --title/--description, or set an issue command and use --refresh.`);
	const lines = [`${event.key}${event.title ? ` ${event.title}` : ""}`];
	if (event.status || event.details?.length) lines.push([event.status, ...(event.details ?? [])].filter(Boolean).join(" · "));
	if (event.url) lines.push(event.url);
	if (event.description) lines.push("", event.description);
	out(lines.join("\n"));
}

function configPathText(): string {
	return process.env.AGENT_DAILIES_CONFIG || "$XDG_CONFIG_HOME/agent-dailies/config.json";
}

function viewerLine(published: Published): string | undefined {
	if (!published.live) return "The viewer is not running, so nobody sees it yet.";
	if (published.opened) return "No viewer tab was open, so it was opened in the browser.";
	if (published.viewers > 0) {
		return `The viewer is open in ${published.viewers === 1 ? "1 tab" : `${published.viewers} tabs`}; it updated in place. No need to open anything.`;
	}
	return undefined;
}

async function show(args: string[]): Promise<void> {
	const { values, positionals } = parse(args, WHERE_OPTIONS);
	if (values.help || positionals.length === 0) return out("Usage: agent-dailies show <file>… [--title T] [--note N] [--tag X]… [--issue ID] [--no-open] [--json]");
	const missing = positionals.filter((file) => !existsSync(file));
	if (missing.length) throw new Error(`no such file: ${missing.join(", ")}`);

	const target = store();
	const items: Item[] = [];
	for (const file of positionals) items.push(await target.addFile(resolve(file)));
	const input = postInput(values, items);
	const published = await publish(target, input, values);

	if (values.json) return out(JSON.stringify({ post: published.post, url: published.url, viewers: published.viewers, opened: published.opened }, null, 2));
	const lines = [`Shown ${items.length === 1 ? "1 file" : `${items.length} files`} in the viewer: ${published.url}`];
	published.post.items.forEach((item, index) => lines.push(`  ${index + 1}. ${item.name}  (${item.id})`));
	const viewerState = viewerLine(published);
	if (viewerState) lines.push(viewerState);
	if (published.live && input.session) {
		lines.push("To hear the user's comments on it, keep `agent-dailies watch` running in the background (it exits, waking you, when they comment).");
	}
	out(lines.join("\n"));
}

const KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

interface AskSpec {
	title?: string;
	note?: string;
	tags?: string[];
	questions: {
		id?: string;
		text: string;
		why?: string;
		multi?: boolean;
		files?: string[];
		options: (string | { label?: string; body?: string; files?: string[] })[];
	}[];
}

// Turns a question spec (from the command line or a JSON file) into items and
// questions, storing every file it names.
async function buildQuestions(target: Store, spec: AskSpec, base: string): Promise<{ items: Item[]; questions: Question[] }> {
	if (!Array.isArray(spec.questions) || !spec.questions.length) throw new Error("no questions to ask");
	const items: Item[] = [];
	const add = async (files: string[] | undefined): Promise<string[]> => {
		const ids: string[] = [];
		for (const file of files ?? []) {
			const path = resolve(base, file);
			if (!existsSync(path)) throw new Error(`no such file: ${file}`);
			const item = await target.addFile(path);
			items.push(item);
			ids.push(item.id);
		}
		return ids;
	};
	const questions: Question[] = [];
	for (const [index, entry] of spec.questions.entries()) {
		if (!entry || !String(entry.text ?? "").trim()) throw new Error(`question ${index + 1} has no text`);
		if (!Array.isArray(entry.options) || entry.options.length < 1) throw new Error(`question ${index + 1} has no options`);
		const question: Question = {
			id: entry.id ? String(entry.id) : `q${index + 1}`,
			text: String(entry.text).trim(),
			why: entry.why ? String(entry.why) : undefined,
			multi: entry.multi ? true : undefined,
			items: await add(entry.files),
			options: [],
		};
		for (const [optionIndex, raw] of entry.options.entries()) {
			const option = typeof raw === "string" ? { label: raw } : raw;
			question.options.push({
				id: `o${optionIndex + 1}`,
				key: KEYS[optionIndex] ?? String(optionIndex + 1),
				label: option.label ? String(option.label) : undefined,
				body: option.body ? String(option.body) : undefined,
				items: await add(option.files),
			});
		}
		questions.push(question);
	}
	return { items, questions };
}

async function ask(args: string[]): Promise<void> {
	// Order matters here (files after --pattern belong to it), so read the tokens.
	const { values: parsed, positionals, tokens } = parseArgs({
		args,
		options: {
			...WHERE_OPTIONS,
			option: { type: "string", short: "o", multiple: true },
			pattern: { type: "string", short: "p", multiple: true },
			why: { type: "string" },
			multi: { type: "boolean" },
			file: { type: "string", short: "f" },
			wait: { type: "boolean" },
			timeout: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
		tokens: true,
	});
	const values = parsed as Values;
	if (values.help || (!values.file && positionals.length === 0)) {
		return out(
			[
				'Usage: agent-dailies ask "<question>" [file…] [--pattern LABEL file…]… [--option TEXT]… [--why TEXT] [--multi] [--wait] [--json]',
				"       agent-dailies ask --file questions.json [--wait] [--json]",
				"Options, A, B, C… in order: each file on its own; --pattern LABEL with the files after it (one option with",
				"several reference files); --option TEXT (a sentence). The user picks one per question and presses Send.",
			].join("\n"),
		);
	}
	const target = store();
	let spec: AskSpec;
	let base = process.cwd();
	if (values.file) {
		const path = resolve(values.file as string);
		spec = JSON.parse(readFileSync(path, "utf8")) as AskSpec;
		base = dirname(path);
	} else {
		let text: string | undefined;
		const options: { label?: string; files?: string[] }[] = [];
		let pattern: { label?: string; files: string[] } | undefined;
		for (const token of tokens) {
			if (token.kind === "positional") {
				if (text === undefined) text = token.value;
				else if (pattern) pattern.files.push(token.value);
				else options.push({ files: [token.value] });
			} else if (token.kind === "option" && token.name === "pattern") {
				pattern = { label: token.value, files: [] };
				options.push(pattern);
			} else if (token.kind === "option" && token.name === "option") {
				pattern = undefined;
				options.push({ label: token.value });
			}
		}
		spec = { questions: [{ text: text!, why: values.why as string | undefined, multi: Boolean(values.multi), options }] };
	}
	const { items, questions } = await buildQuestions(target, spec, base);
	const input = postInput(values, items, {
		title: (values.title as string | undefined) ?? spec.title ?? (questions.length === 1 ? questions[0]!.text : undefined),
		note: (values.note as string | undefined) ?? spec.note,
		tags: [...((values.tag as string[] | undefined) ?? []), ...(spec.tags ?? [])],
		questions,
	});
	const published = await publish(target, input, values);

	if (!values.wait) {
		if (values.json) return out(JSON.stringify({ post: published.post, url: published.url, viewers: published.viewers, opened: published.opened }, null, 2));
		const lines = [`Asked in the viewer: ${published.url}`, ...describeQuestions(published.post)];
		const viewerState = viewerLine(published);
		if (viewerState) lines.push(viewerState);
		if (published.live) {
			lines.push(
				`To get the answer, run \`agent-dailies wait ${published.post.id}\` in the background (it exits, waking you, when the user answers), or keep \`agent-dailies watch\` running.`,
			);
		}
		return out(lines.join("\n"));
	}
	if (!values.json) process.stdout.write(`Asked in the viewer: ${published.url}\nWaiting for the answer…\n`);
	await waitForAnswers(target, published.post.id, values);
}

function describeQuestions(post: PostView): string[] {
	const lines: string[] = [];
	const names = new Map(post.items.map((item) => [item.id, item.name]));
	for (const question of post.questions ?? []) {
		lines.push(`- ${question.text}${question.multi ? " (more than one may be chosen)" : ""}  [${question.id}]`);
		for (const option of question.options) {
			const files = option.items.map((id) => names.get(id)).filter(Boolean).join(", ");
			lines.push(`    ${option.key}. ${[option.label, files].filter(Boolean).join(" — ")}`);
		}
		const answer = post.answers[question.id];
		if (answer) lines.push(`    → answered: ${answerText(question, answer, names)}`);
	}
	return lines;
}

function answerText(question: Question, answer: AnswerEvent, names: Map<string, string>): string {
	const chosen = answer.choices.map((id) => {
		const option = question.options.find((candidate) => candidate.id === id);
		if (!option) return id;
		const label = option.label ?? option.items.map((item) => names.get(item)).filter(Boolean).join(", ");
		return `${option.key}${label ? ` (${label})` : ""}`;
	});
	return [chosen.join(" + "), answer.text ? `"${answer.text}"` : ""].filter(Boolean).join(" — ") || "(nothing)";
}

// Waits until every question of a post has an answer, or the user comments on
// it, then prints what they said and exits.
async function waitForAnswers(target: Store, postId: string, values: Values): Promise<void> {
	const started = new Date().toISOString();
	const check = async (): Promise<void> => {
		const catalog = target.load();
		const post = catalog.post(postId);
		if (!post) throw new Error(`no post ${postId}`);
		const comments = catalog.history.filter((event) => event.type === "comment" && event.post === postId && event.by === "human" && event.at > started);
		if (catalog.openQuestions(post).length && !comments.length) return;
		const view = catalog.view(post);
		if (post.session) markDelivered(target, post.session, pendingFor(catalog, target, post.session).filter((event) => event.post === postId));
		await finish(
			values.json
				? JSON.stringify({ post: postId, questions: post.questions, answers: view.answers, comments }, null, 2)
				: [
						`The user answered in agent-dailies (${post.title ?? postId}):`,
						...describeQuestions(view),
						...describeFeedback(catalog, comments),
					].join("\n"),
		);
	};
	await check();
	await streamUntil(`api/watch?post=${encodeURIComponent(postId)}`, target, values, check);
	await finish(`No answer in ${Math.round(duration(values.timeout as string | undefined, 110 * 60_000) / 60_000)} min. Run \`agent-dailies wait ${postId}\` again to keep waiting.`);
}

async function wait(args: string[]): Promise<void> {
	const { values, positionals } = parse(args, { timeout: { type: "string" }, json: { type: "boolean" } });
	const postId = positionals[0];
	if (!postId) throw new Error("Usage: agent-dailies wait <post-id> [--timeout 110m] [--json]");
	const target = store();
	if (!target.load().post(postId)) throw new Error(`no post ${postId}`);
	await waitForAnswers(target, postId, values);
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
	const known = ctx.post.issue ? target.load().issue(ctx.post.issue) : undefined;
	if (known) lines.push(`Issue: ${known.key}${known.title ? ` ${known.title}` : ""}${known.status ? ` (${known.status})` : ""}`);
	lines.push("", "## Files");
	ctx.post.items.forEach((item, index) => {
		const selected = ctx.selection?.item === item.id ? " ← selected" : "";
		const verdict = item.verdict ? ` — ${item.verdict}` : "";
		lines.push(`${index + 1}. ${item.name} (${item.id})${selected}${verdict}`);
		lines.push(`   ${target.blobPath(item.sha256, item.ext)}`);
	});
	if (ctx.post.questions?.length) {
		lines.push("", "## Questions", ...describeQuestions(ctx.post));
	}
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
	if (!entries.length) return out(`No marks, comments or answers from the user since ${from} (${scope}).`);
	const lines = [`# The user's feedback (${scope}, since ${from})`, ""];
	for (const event of [...entries].reverse()) {
		const post = catalog.post(event.post);
		const item = post?.items.find((candidate) => candidate.id === (event as VerdictEvent | CommentEvent).item);
		const about = `${item ? `${item.name} (${item.id}) in ` : ""}${post ? describePost(catalog.view(post)) : event.post}`;
		if (event.type === "verdict") lines.push(`- ${ago(event.at)}: ${event.verdict ?? "cleared the mark on"} ${about}`);
		else if (event.type === "answer") lines.push(`- ${ago(event.at)}: answered in ${about}: ${describeAnswer(catalog, event)}`);
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

// Listens on a watch stream until `check` finishes the process or time runs out.
// The stream says something happened; `check` reads the store to decide.
async function streamUntil(path: string, target: Store, values: Values, check: () => Promise<void>): Promise<void> {
	const deadline = Date.now() + duration(values.timeout as string | undefined, 110 * 60_000);
	while (Date.now() < deadline) {
		const viewer = await ensureServer({ host: config.host(), port: config.port(), home: target.home }).catch(() => undefined);
		if (!viewer) {
			await new Promise((done) => setTimeout(done, 2000));
			continue;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), deadline - Date.now());
		try {
			const response = await fetch(new URL(path, viewer.base), { signal: controller.signal });
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of response.body) {
				buffer += decoder.decode(chunk as Uint8Array, { stream: true });
				if (!buffer.includes("event: feedback")) {
					buffer = buffer.slice(-64);
					continue;
				}
				buffer = "";
				// People often answer and then add a line; give the rest a moment to land.
				await new Promise((done) => setTimeout(done, 2000));
				await check();
			}
		} catch {
			// The stream ended: the viewer went away (an upgrade, a restart) or time ran out.
		} finally {
			clearTimeout(timer);
		}
		if (Date.now() < deadline) await new Promise((done) => setTimeout(done, 1000));
	}
}

async function watch(args: string[]): Promise<void> {
	const { values } = parse(args, { session: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean" } });
	const session = sessionOf(values.session);
	if (!session) throw new Error("no agent session (CLAUDE_CODE_SESSION_ID); pass --session ID");
	const target = store();

	const deliver = async (): Promise<void> => {
		const catalog = target.load();
		const pending = pendingFor(catalog, target, session);
		if (!hasMessage(pending)) return;
		markDelivered(target, session, pending);
		await finish(
			values.json
				? JSON.stringify({ session, feedback: pending }, null, 2)
				: ["The user left feedback in agent-dailies:", ...describeFeedback(catalog, pending), "", WATCH_AGAIN].join("\n"),
		);
	};
	await deliver();

	const viewer = await ensureServer({ host: config.host(), port: config.port(), home: target.home });
	const { watching } = await viewer.get<{ watching: number }>(`api/watchers?session=${encodeURIComponent(session)}`);
	if (watching > 0) await finish("Already watching for this session in another process; nothing else to start.");
	await streamUntil(`api/watch?session=${encodeURIComponent(session)}`, target, values, deliver);
	await finish(`No comments in ${Math.round(duration(values.timeout as string | undefined, 110 * 60_000) / 60_000)} min. Start \`agent-dailies watch\` in the background again if you still want to hear them.`);
}


// ---- devlog ----

const DEVLOG_HELP = `Usage:
  agent-dailies devlog add --title T --summary TEXT|- [--craft TEXT] [--struggle TEXT] [--decided TEXT]
                           [--before FILE|ITEM…] [--after FILE|ITEM…] [FILE…]
                           [--issue KEY] [--commits auto|none|A..B] [--open] [--json]
      Record what changed, looking back over the session: what changed for the people using it and
      why (summary), what was done well (craft, 工夫), what was hard — what failed first, what was
      tried (struggle, 苦労), and what was decided. The summary may carry these as "## 工夫",
      "## 苦労", "## 決めたこと" sections instead. Before/after (required when the change can be
      seen) take files or the ids of files already shown (i_…). Commits default to this session's.
  agent-dailies devlog list [--since 7d|DATE] [--all] [--json]
  agent-dailies devlog summary [--since cut|7d|DATE] [--until DATE] [--all] [--json]
      Everything recorded since the last cut (or the given time): entries, decisions, commits,
      transcripts — the material to write an update or a devlog post from.
  agent-dailies devlog cut [--name N] [--all]      Mark that a summary went out; the next starts here.
  agent-dailies devlog sweep [--quiet]             Copy this project's Claude Code transcripts into the store.`;

// A file to attach, or the id of a file already in the store (reused, not copied again).
async function itemFrom(target: Store, catalog: Catalog, ref: string): Promise<Item> {
	if (/^i_[a-z0-9]+$/.test(ref)) {
		const known = catalog.postOfItem(ref)?.items.find((item) => item.id === ref);
		if (known) return { ...known, id: newId("i") };
	}
	if (!existsSync(ref)) throw new Error(`no such file or item: ${ref}`);
	return target.addFile(resolve(ref));
}

function sessionCommits(target: Store, where: ReturnType<typeof detectWhere>, mode: string): CommitRef[] {
	if (mode === "none") return [];
	const cwd = where.cwd ?? process.cwd();
	if (mode.includes("..")) {
		const [from, to] = mode.split("..");
		return commitsBetween(cwd, from!, to || "HEAD");
	}
	const start = where.session ? readSession(target, where.session).start : undefined;
	return start?.head ? commitsBetween(cwd, start.head) : [];
}

async function devlogAdd(args: string[]): Promise<void> {
	const { values: parsed, tokens } = parseArgs({
		args,
		options: {
			...WHERE_OPTIONS,
			summary: { type: "string", short: "s" },
			craft: { type: "string" },
			struggle: { type: "string" },
			decided: { type: "string" },
			before: { type: "boolean" },
			after: { type: "boolean" },
			commits: { type: "string" },
			open: { type: "boolean" },
		},
		allowPositionals: true,
		tokens: true,
	});
	const values = parsed as Values;
	const target = store();
	const catalog = target.load();
	const refs: Record<"plain" | "before" | "after", string[]> = { plain: [], before: [], after: [] };
	let bucket: keyof typeof refs = "plain";
	for (const token of tokens) {
		if (token.kind === "option" && (token.name === "before" || token.name === "after")) bucket = token.name;
		else if (token.kind === "positional") refs[bucket].push(token.value);
	}
	const raw = values.summary === "-" ? readFileSync(0, "utf8") : (values.summary as string | undefined);
	const sections = splitSections(raw ?? "");
	const summary = sections.summary;
	const craft = (values.craft as string | undefined) ?? sections.craft;
	const struggle = (values.struggle as string | undefined) ?? sections.struggle;
	const decided = (values.decided as string | undefined) ?? sections.decided;
	if (!values.title && !summary) throw new Error(`a devlog entry needs --title or --summary\n\n${DEVLOG_HELP}`);
	const items: Item[] = [];
	const ids: Record<"before" | "after", string[]> = { before: [], after: [] };
	for (const kind of ["before", "after", "plain"] as const) {
		for (const ref of refs[kind]) {
			const item = await itemFrom(target, catalog, ref);
			items.push(item);
			if (kind !== "plain") ids[kind].push(item.id);
		}
	}
	const where = detectWhere();
	const commits = sessionCommits(target, where, (values.commits as string | undefined) ?? "auto");
	const input = postInput({ ...values, "no-open": !values.open }, items, {
		kind: "devlog",
		devlog: { summary, craft, struggle, decided, before: ids.before, after: ids.after, commits },
	});
	const published = await publish(target, input, { ...values, "no-open": !values.open });
	if (values.json) return out(JSON.stringify({ post: published.post, url: published.url }, null, 2));
	const lines = [`Recorded a devlog entry: ${published.url}`];
	if (ids.before.length || ids.after.length) lines.push(`  before ${ids.before.length} · after ${ids.after.length}`);
	if (commits.length) lines.push(`  ${commits.length} commit${commits.length === 1 ? "" : "s"}: ${commits.map((commit) => commit.sha.slice(0, 8)).join(" ")}`);
	const missing = [!craft && "craft (工夫)", !struggle && "struggle (苦労)"].filter(Boolean);
	if (missing.length) lines.push(`No ${missing.join(" or ")} written. If there was any, add it: these are what devlog videos are made of.`);
	if (!ids.before.length || !ids.after.length) {
		lines.push("No before/after pair. If the change can be seen (looks, motion, UI, feel), add both: --before <file|i_…> --after <file|i_…>.");
	}
	out(lines.join("\n"));
}

function summaryStart(catalog: Catalog, value: string | undefined, project: string | undefined): string {
	if (!value || value === "cut") return catalog.lastCut(project)?.at ?? since(undefined, 7 * 86_400_000);
	return since(value, 0);
}

async function devlog(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	const target = store();
	switch (sub) {
		case "add":
			return devlogAdd(rest);
		case "list": {
			const { values } = parse(rest, { since: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } });
			const where = detectWhere();
			const entries = target.load().list({
				kind: "devlog",
				since: since(values.since as string | undefined, 30 * 86_400_000),
				...(values.all ? {} : { project: where.project }),
			});
			if (values.json) return out(JSON.stringify(entries, null, 2));
			if (!entries.length) return out("No devlog entries in that period.");
			return out(
				entries
					.map((entry) => `- ${entry.at.slice(0, 16)} ${entry.issue ? `${entry.issue} ` : ""}${entry.title ?? "(untitled)"} (${entry.id})`)
					.join("\n"),
			);
		}
		case "summary": {
			const { values } = parse(rest, { since: { type: "string" }, until: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } });
			const catalog = target.load();
			const project = values.all ? undefined : detectWhere().project;
			const summary = collect(catalog, target, {
				since: summaryStart(catalog, values.since as string | undefined, project),
				until: values.until ? since(values.until as string, 0) : undefined,
				project,
			});
			return out(values.json ? JSON.stringify(summary, null, 2) : summaryMarkdown(catalog, target, summary));
		}
		case "cut": {
			const { values } = parse(rest, { name: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } });
			const body = { name: values.name, project: values.all ? undefined : detectWhere().project, by: "agent" };
			let event: CutEvent;
			try {
				const viewer = await ensureServer({ host: config.host(), port: config.port(), home: target.home });
				event = await viewer.post<CutEvent>("api/cuts", body);
			} catch {
				event = { type: "cut", id: newId("x"), at: new Date().toISOString(), machine: target.machine, name: body.name as string | undefined, project: body.project, by: "agent" };
				target.append(event);
			}
			return out(values.json ? JSON.stringify(event, null, 2) : `Cut the devlog at ${event.at}${event.name ? ` (${event.name})` : ""}; the next summary starts here.`);
		}
		case "sweep": {
			const { values } = parse(rest, { quiet: { type: "boolean" } });
			const copied = sweepTranscripts(target, process.cwd());
			if (!values.quiet) out(copied.length ? `Kept ${copied.length} transcript${copied.length === 1 ? "" : "s"} in ${transcriptDir(target, detectWhere().project)}` : "No transcripts to keep.");
			return;
		}
		default:
			return out(DEVLOG_HELP);
	}
}

// Claude Code keeps a project's transcripts in ~/.claude/projects/<the path with
// every other character as "-">/, worktrees in folders that start the same way.
function claudeProjectsDir(): string {
	return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

function sweepTranscripts(target: Store, cwd: string): string[] {
	const root = repositoryRoot(cwd) ?? cwd;
	const prefix = root.replace(/[^A-Za-z0-9]/g, "-");
	const dir = claudeProjectsDir();
	if (!existsSync(dir)) return [];
	const project = detectWhere(cwd).project;
	const copied: string[] = [];
	for (const folder of readdirSync(dir).filter((name) => name === prefix || name.startsWith(`${prefix}-`))) {
		for (const file of readdirSync(join(dir, folder)).filter((name) => name.endsWith(".jsonl"))) {
			const kept = keepTranscript(target, project, file.replace(/\.jsonl$/, ""), join(dir, folder, file));
			if (kept) copied.push(kept);
		}
	}
	return copied;
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
	await viewer.post("api/shutdown", { force: true });
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

// Once per new commit: if this session has committed since it began and has not
// recorded a devlog entry since, suggest looking back. The agent decides whether
// the change is worth an entry; the hook only makes sure it is considered.
function devlogReminder(target: Store, catalog: Catalog, session: string, cwd: string): boolean {
	if (process.env.AGENT_DAILIES_DEVLOG === "0") return false;
	const state = readSession(target, session);
	const head = headOf(cwd);
	if (!state.start?.head || !head || head === state.start.head || state.devlogReminded === head) return false;
	const commits = commitsBetween(cwd, state.start.head, head);
	if (!commits.length) return false;
	writeSession(target, session, { devlogReminded: head });
	const latestCommit = commits[0]!.at ?? "";
	const recorded = catalog.posts.some((post) => post.kind === "devlog" && post.session === session && post.at >= latestCommit);
	if (recorded) return false;
	process.stderr.write(
		[
			`This session has made ${commits.length} commit${commits.length === 1 ? "" : "s"} since it began (latest: ${commits[0]!.subject}).`,
			"Look back over the session: if the change is something a person using the product would notice, record it —",
			`  agent-dailies devlog add --title "<what changed>" --before <file|i_…> --after <file|i_…> --summary - <<'EOF'`,
			"  <what changed for the people using it, and why>",
			"  ## 工夫",
			"  <what was done well or cleverly — the idea that made it work>",
			"  ## 苦労",
			"  <what was hard: what failed first, what you tried, what the user had you redo, what you learned>",
			"  ## 決めたこと",
			"  <what was decided, with the user or by you>",
			"  EOF",
			"Before/after are required when the change can be seen (looks, motion, UI, feel): reuse files you showed (their i_… ids)",
			"or capture the before from the previous commit in a temporary worktree. Leave out sections that truly have nothing.",
			"Skip refactors and fixes nobody notices. If nothing is worth recording, just finish.",
		].join("\n") + "\n",
	);
	process.exitCode = 2;
	return true;
}

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
			if (input.session_id && !readSession(target, input.session_id).start) {
				const cwd = input.cwd || process.cwd();
				writeSession(target, input.session_id, { start: { at: new Date().toISOString(), head: headOf(cwd), cwd } });
			}
			// Keep earlier sessions' transcripts too (one that crashed never ran SessionEnd).
			spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "devlog", "sweep", "--quiet"], {
				cwd: input.cwd && existsSync(input.cwd) ? input.cwd : undefined,
				detached: true,
				stdio: "ignore",
			}).unref();
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
			if (!shown.length) {
				if (!input.stop_hook_active) devlogReminder(target, catalog, session, input.cwd || process.cwd());
				return;
			}
			const pending = pendingFor(catalog, target, session);
			if (hasMessage(pending)) {
				markDelivered(target, session, pending);
				process.stderr.write(`${["The user commented in agent-dailies while you were working:", ...describeFeedback(catalog, pending)].join("\n")}\n`);
				process.exitCode = 2;
				return;
			}
			if (input.stop_hook_active) return;
			if (devlogReminder(target, catalog, session, input.cwd || process.cwd())) return;
			if (process.env.AGENT_DAILIES_AUTO_WATCH === "0") return;
			const latest = postedBy(catalog, session, REMIND_WITHIN_MS).at(-1);
			if (!latest || readSession(target, session).reminded === latest.id) return;
			// The user already answered or commented on it: nothing to wait for.
			if (catalog.history.some((event) => event.post === latest.id && event.by === "human")) return;
			const viewer = client();
			const health = await viewer.health();
			if (!health || health.home !== target.home) return;
			const { watching } = await viewer.get<{ watching: number }>(
				`api/watchers?session=${encodeURIComponent(session)}&post=${encodeURIComponent(latest.id)}`,
			);
			writeSession(target, session, { reminded: latest.id });
			if (watching > 0) return;
			const asking = catalog.openQuestions(latest).length > 0;
			process.stderr.write(
				asking
					? `You asked the user something in agent-dailies (${latest.id}) and nothing is waiting for the answer. ` +
							`Start \`agent-dailies wait ${latest.id}\` with run_in_background (timeout 7200000) so the answer wakes you, then finish.\n`
					: "You showed the user something in agent-dailies and nothing is listening for their comments. " +
							"Start `agent-dailies watch` with run_in_background (timeout 7200000) so a comment wakes you, then finish.\n",
			);
			process.exitCode = 2;
			return;
		}
		case "session-end": {
			const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
			if (input.session_id && transcript) keepTranscript(target, detectWhere(input.cwd || process.cwd()).project, input.session_id, transcript);
			return;
		}
		default:
			throw new Error("Usage: agent-dailies hook <pre-tool-use|session-start|user-prompt-submit|stop|session-end>");
	}
}

async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	switch (command) {
		case "show":
			return show(rest);
		case "ask":
			return ask(rest);
		case "wait":
			return wait(rest);
		case "context":
			return context(rest);
		case "issue":
			return issue(rest);
		case "devlog":
			return devlog(rest);
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
