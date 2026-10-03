// The viewer: a small HTTP server that serves the review page, the stored files,
// and a JSON API, and pushes new posts to open pages over server-sent events.
//
// It is the only writer of this machine's log while it runs; the CLI copies the
// files into the store and then hands the post to the server, which records it
// and tells every open page at once.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { compareVersions, version } from "./config.ts";
import { disposition, namedPath, needsTranscode, playableVideo, safeName } from "./files.ts";
import { ISSUE_KEY, sameIssue, type IssueInfo } from "./issues.ts";
import {
	type AmendEvent,
	type AmendInput,
	type AnswerEvent,
	buildAmend,
	buildPost,
	buildRetract,
	Catalog,
	newId,
	Store,
	type Author,
	type CommentEvent,
	type DailiesEvent,
	type IssueEvent,
	type Item,
	type ListFilter,
	type PostEvent,
	type PostInput,
	type PostView,
	type RetractEvent,
	type RetractInput,
	type Selection,
	type Verdict,
	type VerdictEvent,
} from "./store.ts";

export interface Context {
	viewers: number;
	url: string;
	selection: Selection | null;
	/** The selected post, or the newest one when nothing is selected. */
	post: PostView | null;
	selected: boolean;
}

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const MODEL_VIEWER_CDN = "https://cdn.jsdelivr.net/npm/@google/model-viewer@4/dist/model-viewer.min.js";
const MAX_BODY = 1 << 20;
const STATIC: Record<string, string> = {
	"/": "index.html",
	"/index.html": "index.html",
	"/app.js": "app.js",
	"/style.css": "style.css",
	"/i18n.js": "i18n.js",
	"/icon.svg": "icon.svg",
};
const STATIC_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
};

// Vendored so the viewer works offline and the plugin needs no install step.
const MODEL_VIEWER = join(WEB_DIR, "vendor", "model-viewer.min.js");

function modelViewerPath(): string | undefined {
	return existsSync(MODEL_VIEWER) ? MODEL_VIEWER : undefined;
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class DailiesServer {
	readonly store: Store;
	readonly catalog: Catalog;
	readonly http: Server;
	private readonly clients = new Set<ServerResponse>();
	/**
	 * `agent-dailies watch` / `ask --wait` processes waiting for the user to say
	 * something, keyed "session:<agent session>" or "post:<post id>".
	 */
	private readonly watchers = new Map<string, Set<ServerResponse>>();
	private selection: Selection | null;
	private readonly allowedHosts: Set<string> | null;
	private keepAlive: NodeJS.Timeout | undefined;
	port = 0;
	host: string;

	private readonly onShutdown: () => void;

	constructor(store: Store, options: { host: string; allowedHosts?: string[]; onShutdown?: () => void }) {
		this.onShutdown = options.onShutdown ?? (() => process.exit(0));
		this.store = store;
		this.catalog = store.load();
		this.selection = store.readSelection();
		this.host = options.host;
		// Checking the Host header stops another web page from reaching this API
		// through DNS rebinding. Listening on every interface (to view from another
		// machine over a VPN) is an explicit choice, so the check is off then.
		this.allowedHosts = options.host === "0.0.0.0" || options.host === "::" ? null : new Set(options.allowedHosts ?? []);
		this.http = createServer((request, response) => {
			this.handle(request, response).catch((error: unknown) => {
				const status = error instanceof HttpError ? error.status : 500;
				const message = error instanceof Error ? error.message : String(error);
				if (!response.headersSent) sendJson(response, status, { error: message });
				else response.end();
			});
		});
	}

	listen(port: number): Promise<number> {
		return new Promise((resolvePort, reject) => {
			this.http.once("error", reject);
			this.http.listen(port, this.host, () => {
				const address = this.http.address();
				this.port = typeof address === "object" && address ? address.port : port;
				if (this.allowedHosts) {
					for (const name of ["127.0.0.1", "localhost", "[::1]", this.host]) this.allowedHosts.add(`${name}:${this.port}`);
				}
				this.keepAlive = setInterval(() => this.broadcast("ping", {}), 25_000);
				this.keepAlive.unref();
				resolvePort(this.port);
			});
		});
	}

	close(): Promise<void> {
		if (this.keepAlive) clearInterval(this.keepAlive);
		for (const client of this.clients) client.end();
		this.clients.clear();
		for (const set of this.watchers.values()) for (const watcher of set) watcher.end();
		this.watchers.clear();
		const closed = new Promise<void>((done) => this.http.close(() => done()));
		// Open streams and kept-alive sockets would hold the old viewer alive, unseen.
		this.http.closeAllConnections();
		return closed;
	}

	get viewers(): number {
		return this.clients.size;
	}

	get url(): string {
		const name = this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host;
		return `http://${name}:${this.port}/`;
	}

	record(event: DailiesEvent): void {
		this.store.append(event);
		this.catalog.apply(event);
	}

	addPost(input: PostInput): PostView {
		let event: PostEvent;
		try {
			event = buildPost(input, this.store.machine);
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
		this.record(event);
		const view = this.catalog.view(event);
		this.broadcast("post", view);
		return view;
	}

	setVerdict(itemId: string, verdict: Verdict | null, by: Author): VerdictEvent {
		const post = this.catalog.postOfItem(itemId);
		if (!post) throw new HttpError(404, `no item ${itemId}`);
		if (verdict !== null && verdict !== "adopted" && verdict !== "rejected") throw new HttpError(400, "verdict must be adopted, rejected or null");
		const event: VerdictEvent = {
			type: "verdict",
			id: newId("v"),
			at: new Date().toISOString(),
			machine: this.store.machine,
			post: post.id,
			item: itemId,
			verdict,
			by,
		};
		this.record(event);
		this.broadcast("verdict", event);
		return event;
	}

	addComment(postId: string, itemId: string | undefined, text: string, by: Author): CommentEvent {
		const post = this.catalog.post(postId);
		if (!post) throw new HttpError(404, `no post ${postId}`);
		if (itemId && !post.items.some((item) => item.id === itemId)) throw new HttpError(404, `no item ${itemId} in ${postId}`);
		if (!text.trim()) throw new HttpError(400, "empty comment");
		const event: CommentEvent = {
			type: "comment",
			id: newId("c"),
			at: new Date().toISOString(),
			machine: this.store.machine,
			post: postId,
			item: itemId || undefined,
			text: text.trim(),
			by,
		};
		this.record(event);
		this.broadcast("comment", event);
		if (by === "human") this.notify(post, event);
		return event;
	}

	addAnswer(postId: string, questionId: string, choices: unknown, text: string | undefined, by: Author): AnswerEvent {
		const post = this.catalog.post(postId);
		if (!post) throw new HttpError(404, `no post ${postId}`);
		const question = post.questions?.find((candidate) => candidate.id === questionId);
		if (!question) throw new HttpError(404, `no question ${questionId} in ${postId}`);
		const chosen = Array.isArray(choices) ? [...new Set(choices.map(String))] : [];
		for (const choice of chosen) {
			if (!question.options.some((option) => option.id === choice)) throw new HttpError(400, `no option ${choice} in ${questionId}`);
		}
		if (chosen.length > 1 && !question.multi) throw new HttpError(400, "this question takes one choice");
		const said = text?.trim() || undefined;
		if (!chosen.length && !said) throw new HttpError(400, "choose an option or write something");
		const event: AnswerEvent = {
			type: "answer",
			id: newId("a"),
			at: new Date().toISOString(),
			machine: this.store.machine,
			post: postId,
			question: questionId,
			choices: chosen,
			text: said,
			by,
		};
		this.record(event);
		this.broadcast("answer", event);
		if (by === "human") this.notify(post, event);
		return event;
	}

	/** Corrects a devlog entry (a new event; the entry's own event stays as it was). */
	amend(input: AmendInput): { amend: AmendEvent; post: PostView } {
		const event = this.entryEvent(input.post, () => buildAmend(input, this.catalog, this.store.machine));
		this.record(event);
		const post = this.catalog.view(this.catalog.post(event.post)!);
		this.broadcast("amend", { amend: event, post });
		return { amend: event, post };
	}

	/** Takes a devlog entry back, or brings it back (undo). */
	retract(input: RetractInput): { retract: RetractEvent; post: PostView } {
		const event = this.entryEvent(input.post, () => buildRetract(input, this.catalog, this.store.machine));
		this.record(event);
		const post = this.catalog.view(this.catalog.post(event.post)!);
		this.broadcast("retract", { retract: event, post });
		return { retract: event, post };
	}

	private entryEvent<T>(ref: unknown, build: () => T): T {
		if (typeof ref !== "string" || !ref) throw new HttpError(400, "post is required");
		try {
			return build();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new HttpError(message.startsWith("no devlog entry") ? 404 : 400, message);
		}
	}

	counts(): { devlog: number; review: number; open: number } {
		let devlog = 0;
		let review = 0;
		let open = 0;
		for (const post of this.catalog.posts) {
			if (post.retracted) continue;
			if (post.kind === "devlog") devlog++;
			else {
				review++;
				open += this.catalog.openQuestions(post).length;
			}
		}
		return { devlog, review, open };
	}

	/** Records what is known about an issue, unless nothing changed. */
	setIssue(body: Record<string, unknown>): IssueEvent {
		const key = String(body.key ?? "").toUpperCase();
		if (!ISSUE_KEY.test(key)) throw new HttpError(400, `not an issue key: ${body.key}`);
		const str = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
		const info: IssueInfo = {
			title: str(body.title),
			description: str(body.description),
			status: str(body.status),
			url: str(body.url),
			details: Array.isArray(body.details) && body.details.length ? body.details.map(String) : undefined,
		};
		const current = this.catalog.issue(key);
		// An agent filling in some fields keeps what the tracker said for the rest.
		const merged: IssueInfo = body.merge && current ? { ...current, ...Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) } : info;
		if (current && sameIssue(current, merged)) return current;
		const event: IssueEvent = {
			type: "issue",
			id: newId("s"),
			at: new Date().toISOString(),
			machine: this.store.machine,
			key,
			title: merged.title,
			description: merged.description,
			status: merged.status,
			url: merged.url,
			details: merged.details,
			by: author(body.by),
		};
		this.record(event);
		this.broadcast("issue", event);
		return event;
	}

	private notify(post: PostEvent, event: CommentEvent | AnswerEvent): void {
		const message = `event: feedback\ndata: ${JSON.stringify(event)}\n\n`;
		for (const key of [post.session ? `session:${post.session}` : "", `post:${post.id}`]) {
			for (const watcher of this.watchers.get(key) ?? []) watcher.write(message);
		}
	}

	select(postId: string | null, itemId?: string): Selection | null {
		if (postId === null) {
			this.selection = null;
		} else {
			const post = this.catalog.post(postId);
			if (!post) throw new HttpError(404, `no post ${postId}`);
			if (itemId && !post.items.some((item) => item.id === itemId)) throw new HttpError(404, `no item ${itemId} in ${postId}`);
			this.selection = { post: postId, item: itemId || undefined, at: new Date().toISOString() };
		}
		this.store.writeSelection(this.selection);
		this.broadcast("select", this.selection);
		return this.selection;
	}

	context(): Context {
		const selected = this.selection ? this.catalog.post(this.selection.post) : undefined;
		const post = selected ?? this.catalog.posts[this.catalog.posts.length - 1];
		return {
			viewers: this.viewers,
			url: this.url,
			selection: selected ? this.selection : null,
			post: post ? this.catalog.view(post) : null,
			selected: Boolean(selected),
		};
	}

	watching(session: string): number {
		return this.watchers.get(`session:${session}`)?.size ?? 0;
	}

	private broadcast(type: string, data: unknown): void {
		const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of this.clients) client.write(message);
		if (type === "ping") for (const set of this.watchers.values()) for (const watcher of set) watcher.write(message);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (this.allowedHosts && !this.allowedHosts.has(request.headers.host ?? "")) throw new HttpError(403, "unexpected Host header");
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname;
		const method = request.method ?? "GET";

		if (method === "POST") {
			// Requiring JSON makes a cross-site form or fetch need a preflight, which
			// this server never answers, so other pages cannot post here.
			if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
			const origin = request.headers.origin;
			if (origin && this.allowedHosts && !this.allowedHosts.has(new URL(origin).host)) throw new HttpError(403, "cross-origin request");
			const body = (await readJson(request)) as Record<string, unknown>;
			switch (path) {
				case "/api/posts": {
					const post = this.addPost(body as unknown as PostInput);
					return sendJson(response, 201, { post, viewers: this.viewers, url: `${this.url}#${post.id}` });
				}
				case "/api/verdicts":
					return sendJson(response, 201, this.setVerdict(String(body.item), (body.verdict ?? null) as Verdict | null, author(body.by)));
				case "/api/comments":
					return sendJson(
						response,
						201,
						this.addComment(String(body.post), body.item ? String(body.item) : undefined, String(body.text ?? ""), author(body.by)),
					);
				case "/api/answers":
					return sendJson(
						response,
						201,
						this.addAnswer(String(body.post), String(body.question), body.choices, body.text === undefined ? undefined : String(body.text), author(body.by)),
					);
				case "/api/issues":
					return sendJson(response, 201, this.setIssue(body));
				case "/api/amend": {
					const result = this.amend({ ...(body as unknown as AmendInput), by: author(body.by) });
					return sendJson(response, 201, { ...result, url: `${this.url}#${result.post.id}` });
				}
				case "/api/retract":
					return sendJson(response, 201, this.retract({ ...(body as unknown as RetractInput), by: author(body.by) }));
				case "/api/path": {
					const item = this.itemById(String(body.item));
					if (!item) throw new HttpError(404, `no item ${body.item}`);
					return sendJson(response, 200, { item: item.id, path: namedPath(this.store, item) });
				}
				case "/api/select":
					return sendJson(response, 200, this.select(body.post ? String(body.post) : null, body.item ? String(body.item) : undefined));
				case "/api/shutdown": {
					// Several agent sessions can run different versions of the CLI side by side
					// (each loaded the plugin when it started). Only a newer one may replace this
					// viewer, or `stop` on purpose; otherwise they would take turns replacing
					// each other's viewer forever.
					const theirs = typeof body.version === "string" ? body.version : "";
					if (!body.force && !(theirs && compareVersions(theirs, version()) > 0)) {
						return sendJson(response, 409, { error: `this viewer (${version()}) is not older than ${theirs || "the caller"}; keep using it`, version: version() });
					}
					sendJson(response, 200, { ok: true });
					setImmediate(() => {
						const exit = setTimeout(this.onShutdown, 1500);
						exit.unref();
						void this.close().then(() => {
							clearTimeout(exit);
							this.onShutdown();
						});
					});
					return;
				}
			}
			throw new HttpError(404, `no ${path}`);
		}

		if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");

		switch (path) {
			case "/api/health":
				return sendJson(response, 200, { ok: true, version: version(), pid: process.pid, viewers: this.viewers, home: this.store.home });
			case "/api/state": {
				const param = (name: string) => url.searchParams.get(name) || undefined;
				const filter: ListFilter = {
					limit: Math.min(Number(url.searchParams.get("limit")) || 40, 200),
					before: param("before"),
					project: param("project"),
					lane: param("lane"),
					issue: param("issue"),
					session: param("session"),
					q: param("q"),
					open: url.searchParams.get("open") === "1",
					kind: modeOf(url),
					since: param("since"),
					until: param("until"),
				};
				return sendJson(response, 200, {
					posts: this.catalog.list(filter),
					tree: this.catalog.tree(filter.kind),
					counts: this.counts(),
					issue: this.catalog.issue(filter.issue) ?? null,
					selection: this.selection,
					machine: this.store.machine,
				});
			}
			case "/api/tree":
				return sendJson(response, 200, { tree: this.catalog.tree(modeOf(url)), counts: this.counts() });
			case "/api/issue": {
				const key = url.searchParams.get("key") ?? "";
				return sendJson(response, 200, { issue: this.catalog.issue(key) ?? null });
			}
			case "/api/context":
				return sendJson(response, 200, this.context());
			case "/api/feedback": {
				const since = url.searchParams.get("since") ?? "";
				return sendJson(response, 200, { history: this.catalog.history.filter((event) => event.at > since) });
			}
			case "/api/events":
				return this.openStream(request, response);
			case "/api/watch": {
				const session = url.searchParams.get("session");
				const post = url.searchParams.get("post");
				if (!session && !post) throw new HttpError(400, "session or post is required");
				return this.openWatch(session ? `session:${session}` : `post:${post}`, request, response);
			}
			case "/api/watchers": {
				// Counts what listens for a session's feedback, plus (with post=) what waits on one post.
				const session = url.searchParams.get("session") ?? "";
				const post = url.searchParams.get("post");
				const onPost = post ? (this.watchers.get(`post:${post}`)?.size ?? 0) : 0;
				return sendJson(response, 200, { session, watching: this.watching(session) + onPost });
			}
			case "/vendor/model-viewer.js": {
				const file = modelViewerPath();
				if (!file) {
					response.writeHead(302, { location: MODEL_VIEWER_CDN });
					return void response.end();
				}
				return sendFile(request, response, file, "text/javascript; charset=utf-8", "public, max-age=86400");
			}
		}

		// /files/<item>/<name>: the file under its own name (inline, or ?download to save it).
		const named = /^\/files\/(i_[a-z0-9]+)(?:\/[^/]*)?$/.exec(path);
		if (named) {
			const item = this.itemById(named[1]!);
			if (!item) throw new HttpError(404, "no such file");
			const kind = url.searchParams.has("download") ? "attachment" : "inline";
			return sendFile(request, response, this.store.blobPath(item.sha256, item.ext), item.mime, "public, max-age=31536000, immutable", {
				"content-disposition": disposition(kind, item.name),
			});
		}

		// /play/<item>: a video the browser can play, converting it once if it cannot.
		const play = /^\/play\/(i_[a-z0-9]+)$/.exec(path);
		if (play) {
			const item = this.itemById(play[1]!);
			if (!item) throw new HttpError(404, "no such file");
			if (!needsTranscode(item)) {
				response.writeHead(302, { location: `/files/${item.id}/${encodeURIComponent(safeName(item.name))}` });
				return void response.end();
			}
			let file: string;
			try {
				file = await playableVideo(this.store, item);
			} catch (error) {
				throw new HttpError(415, error instanceof Error ? error.message : String(error));
			}
			return sendFile(request, response, file, "video/webm", "public, max-age=31536000, immutable");
		}

		const blob = /^\/blob\/([0-9a-f]{64})(\.[a-z0-9]{1,8})?$/.exec(path);
		if (blob) {
			const sha = blob[1]!;
			const ext = blob[2] ?? "";
			const file = this.store.blobPath(sha, ext);
			if (!existsSync(file)) throw new HttpError(404, "no such file");
			const item = this.findItem(sha, ext);
			// Content-addressed, so a URL never changes what it points to.
			return sendFile(request, response, file, item?.mime ?? "application/octet-stream", "public, max-age=31536000, immutable");
		}

		const asset = STATIC[path];
		if (asset) {
			const file = resolve(join(WEB_DIR, asset));
			const ext = asset.slice(asset.lastIndexOf("."));
			return sendFile(request, response, file, STATIC_TYPES[ext] ?? "application/octet-stream", "no-cache");
		}
		throw new HttpError(404, `no ${path}`);
	}

	// Files a correction replaced still resolve: the page can show an entry as first recorded.
	private itemById(id: string): Item | undefined {
		return this.catalog.item(id);
	}

	private findItem(sha256: string, ext: string): Item | undefined {
		for (let index = this.catalog.posts.length - 1; index >= 0; index--) {
			const item = this.catalog.itemsOf(this.catalog.posts[index]!.id).find((candidate) => candidate.sha256 === sha256 && candidate.ext === ext);
			if (item) return item;
		}
		return undefined;
	}

	private openWatch(key: string, request: IncomingMessage, response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		response.write(`event: hello\ndata: ${JSON.stringify({ watching: key })}\n\n`);
		const set = this.watchers.get(key) ?? new Set<ServerResponse>();
		set.add(response);
		this.watchers.set(key, set);
		request.on("close", () => {
			set.delete(response);
			if (!set.size) this.watchers.delete(key);
		});
	}

	private openStream(request: IncomingMessage, response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		response.write(`event: hello\ndata: ${JSON.stringify({ version: version(), machine: this.store.machine })}\n\n`);
		this.clients.add(response);
		request.on("close", () => this.clients.delete(response));
	}
}

// The page has two sides: what agents show for review ("dailies"), and the devlog.
function modeOf(url: URL): "devlog" | "review" | undefined {
	const mode = url.searchParams.get("mode");
	return mode === "devlog" ? "devlog" : mode === "dailies" ? "review" : undefined;
}

function author(value: unknown): Author {
	return value === "agent" ? "agent" : "human";
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
	const body = JSON.stringify(data);
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(body);
}

function readJson(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolveBody, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new HttpError(413, "body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			try {
				resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch {
				reject(new HttpError(400, "invalid JSON"));
			}
		});
		request.on("error", reject);
	});
}

// Serves a file with Range support, which video players need to seek.
function sendFile(
	request: IncomingMessage,
	response: ServerResponse,
	file: string,
	type: string,
	cache: string,
	extra: Record<string, string> = {},
): void {
	let size: number;
	try {
		size = statSync(file).size;
	} catch {
		throw new HttpError(404, "no such file");
	}
	const headers: Record<string, string | number> = { "content-type": type, "cache-control": cache, "accept-ranges": "bytes", ...extra };
	const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
	let start = 0;
	let end = size - 1;
	let status = 200;
	if (range && size > 0) {
		if (range[1]) start = Number(range[1]);
		if (range[2]) end = Math.min(Number(range[2]), size - 1);
		if (!range[1] && range[2]) {
			start = Math.max(0, size - Number(range[2]));
			end = size - 1;
		}
		if (start > end || start >= size) {
			response.writeHead(416, { "content-range": `bytes */${size}` });
			return void response.end();
		}
		status = 206;
		headers["content-range"] = `bytes ${start}-${end}/${size}`;
	}
	headers["content-length"] = size === 0 ? 0 : end - start + 1;
	response.writeHead(status, headers);
	if (request.method === "HEAD" || size === 0) return void response.end();
	createReadStream(file, { start, end }).pipe(response);
}
