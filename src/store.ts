// The store: files kept by their content hash, and an append-only log of what
// happened to them (shown, marked, commented on).
//
// Files live under blobs/<first two hex>/<sha256><ext>, so showing the same file
// twice keeps one copy, and a file shown from a worktree survives the worktree.
// Events live in log/<machine>.jsonl, one JSON object per line. Each machine
// only ever appends to its own log, so syncing the logs between machines is a
// union and never a merge.

import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { extensionOf, kindOf, mimeOf, type Kind } from "./media.ts";

export type Verdict = "adopted" | "rejected";
export type Author = "human" | "agent";

export interface Item {
	id: string;
	sha256: string;
	ext: string;
	name: string;
	mime: string;
	kind: Kind;
	size: number;
	/** The path the agent showed it from, for reference. It may be gone by now. */
	source?: string;
}

export interface Where {
	project: string;
	lane: string;
	branch?: string;
	issue?: string;
	session?: string;
	cwd?: string;
}

/** One choice in a question. It can be a file (or several), a sentence, or both. */
export interface QuestionOption {
	id: string;
	/** A, B, C… — what the user and the agent call it. */
	key: string;
	label?: string;
	/** Longer text: the reasoning, the trade-off. Light Markdown (bold, code, lists). */
	body?: string;
	/** Ids of this post's items that belong to the option. */
	items: string[];
}

/** Something the agent needs the user to decide. */
export interface Question {
	id: string;
	text: string;
	/** Why it matters, or why the agent proposes what it does. */
	why?: string;
	/** Ids of this post's items that give context to the question. */
	items: string[];
	options: QuestionOption[];
	/** More than one option may be chosen. */
	multi?: boolean;
}

export interface PostEvent extends Where {
	type: "post";
	id: string;
	at: string;
	machine: string;
	title?: string;
	note?: string;
	tags: string[];
	items: Item[];
	/** Present when the post asks the user to decide something. */
	questions?: Question[];
}

export interface VerdictEvent {
	type: "verdict";
	id: string;
	at: string;
	machine: string;
	post: string;
	item: string;
	verdict: Verdict | null;
	by: Author;
}

export interface CommentEvent {
	type: "comment";
	id: string;
	at: string;
	machine: string;
	post: string;
	/** Absent when the comment is about the whole post. */
	item?: string;
	text: string;
	by: Author;
}

export interface AnswerEvent {
	type: "answer";
	id: string;
	at: string;
	machine: string;
	post: string;
	question: string;
	/** Option ids; empty when the user only wrote something. */
	choices: string[];
	text?: string;
	by: Author;
}

export type DailiesEvent = PostEvent | VerdictEvent | CommentEvent | AnswerEvent;

export interface Selection {
	post: string;
	item?: string;
	at: string;
}

export function newId(prefix: string, now: number = Date.now()): string {
	return `${prefix}_${now.toString(36)}${randomBytes(3).toString("hex")}`;
}

export class Store {
	readonly home: string;
	readonly machine: string;

	constructor(home: string, machine: string) {
		this.home = home;
		this.machine = machine;
	}

	get blobDir(): string {
		return join(this.home, "blobs");
	}

	get logDir(): string {
		return join(this.home, "log");
	}

	get logPath(): string {
		return join(this.logDir, `${this.machine}.jsonl`);
	}

	blobPath(sha256: string, ext: string): string {
		return join(this.blobDir, sha256.slice(0, 2), `${sha256}${ext}`);
	}

	/** Copies a file into the store (once per content) and describes it. */
	async addFile(path: string): Promise<Item> {
		const stat = statSync(path);
		if (!stat.isFile()) throw new Error(`not a file: ${path}`);
		const ext = extensionOf(path);
		mkdirSync(this.blobDir, { recursive: true });
		const temp = join(this.blobDir, `.incoming-${process.pid}-${randomBytes(4).toString("hex")}`);
		const hash = createHash("sha256");
		const tap = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				hash.update(chunk);
				done(null, chunk);
			},
		});
		try {
			await pipeline(createReadStream(path), tap, createWriteStream(temp));
			const sha256 = hash.digest("hex");
			const target = this.blobPath(sha256, ext);
			if (existsSync(target)) {
				unlinkSync(temp);
			} else {
				mkdirSync(dirname(target), { recursive: true });
				renameSync(temp, target);
			}
			return {
				id: newId("i"),
				sha256,
				ext,
				name: basename(path),
				mime: mimeOf(path),
				kind: kindOf(path),
				size: stat.size,
				source: path,
			};
		} catch (error) {
			if (existsSync(temp)) unlinkSync(temp);
			throw error;
		}
	}

	append(event: DailiesEvent): void {
		mkdirSync(this.logDir, { recursive: true });
		appendFileSync(this.logPath, `${JSON.stringify(event)}\n`);
	}

	/** Reads every machine's log. Lines that do not parse are skipped, not fatal. */
	readEvents(): DailiesEvent[] {
		if (!existsSync(this.logDir)) return [];
		const events: DailiesEvent[] = [];
		for (const file of readdirSync(this.logDir).filter((name) => name.endsWith(".jsonl")).sort()) {
			for (const line of readFileSync(join(this.logDir, file), "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					events.push(JSON.parse(line) as DailiesEvent);
				} catch {
					// A torn last line from a crash; the rest of the log is still good.
				}
			}
		}
		return events.sort(compareEvents);
	}

	load(): Catalog {
		const catalog = new Catalog();
		for (const event of this.readEvents()) catalog.apply(event);
		return catalog;
	}

	get selectionPath(): string {
		return join(this.home, "selection.json");
	}

	readSelection(): Selection | null {
		try {
			return JSON.parse(readFileSync(this.selectionPath, "utf8")) as Selection | null;
		} catch {
			return null;
		}
	}

	writeSelection(selection: Selection | null): void {
		mkdirSync(this.home, { recursive: true });
		writeFileSync(this.selectionPath, `${JSON.stringify(selection)}\n`);
	}
}

export interface PostInput extends Where {
	title?: string;
	note?: string;
	tags?: string[];
	items: Item[];
	questions?: Question[];
}

export function buildPost(input: PostInput, machine: string, at: Date = new Date()): PostEvent {
	const questions = Array.isArray(input.questions) && input.questions.length ? input.questions : undefined;
	if (!Array.isArray(input.items) || (input.items.length === 0 && !questions)) throw new Error("a post needs at least one item or question");
	if (questions) checkQuestions(questions, input.items);
	return {
		type: "post",
		id: newId("p", at.getTime()),
		at: at.toISOString(),
		machine,
		project: String(input.project || "unknown"),
		lane: String(input.lane || "default"),
		branch: input.branch || undefined,
		issue: input.issue || undefined,
		session: input.session || undefined,
		cwd: input.cwd || undefined,
		title: input.title || undefined,
		note: input.note || undefined,
		tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
		items: input.items,
		questions,
	};
}

function checkQuestions(questions: Question[], items: Item[]): void {
	const known = new Set(items.map((item) => item.id));
	const ids = new Set<string>();
	for (const question of questions) {
		if (!question.id || ids.has(question.id)) throw new Error("each question needs its own id");
		ids.add(question.id);
		if (!String(question.text ?? "").trim()) throw new Error(`question ${question.id} has no text`);
		if (!Array.isArray(question.options)) throw new Error(`question ${question.id} has no options`);
		const optionIds = new Set<string>();
		for (const option of question.options) {
			if (!option.id || optionIds.has(option.id)) throw new Error(`question ${question.id}: each option needs its own id`);
			optionIds.add(option.id);
			for (const item of [...(option.items ?? []), ...(question.items ?? [])]) {
				if (!known.has(item)) throw new Error(`question ${question.id} refers to an unknown item ${item}`);
			}
		}
	}
}

export function compareEvents(a: DailiesEvent, b: DailiesEvent): number {
	return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface ItemView extends Item {
	verdict: Verdict | null;
}

export interface PostView extends Omit<PostEvent, "items"> {
	items: ItemView[];
	comments: CommentEvent[];
	/** The latest answer to each question, by question id. */
	answers: Record<string, AnswerEvent>;
}

/** The state the events add up to. */
export class Catalog {
	readonly posts: PostEvent[] = [];
	private readonly postsById = new Map<string, PostEvent>();
	private readonly itemPost = new Map<string, string>();
	private readonly verdicts = new Map<string, VerdictEvent>();
	private readonly comments = new Map<string, CommentEvent[]>();
	private readonly answers = new Map<string, Map<string, AnswerEvent>>();
	readonly history: (VerdictEvent | CommentEvent | AnswerEvent)[] = [];

	apply(event: DailiesEvent): void {
		switch (event.type) {
			case "post":
				if (this.postsById.has(event.id)) return;
				this.posts.push(event);
				this.postsById.set(event.id, event);
				for (const item of event.items) this.itemPost.set(item.id, event.id);
				break;
			case "verdict": {
				const previous = this.verdicts.get(event.item);
				if (!previous || compareEvents(previous, event) < 0) this.verdicts.set(event.item, event);
				this.history.push(event);
				break;
			}
			case "comment": {
				const list = this.comments.get(event.post) ?? [];
				list.push(event);
				this.comments.set(event.post, list);
				this.history.push(event);
				break;
			}
			case "answer": {
				const byQuestion = this.answers.get(event.post) ?? new Map<string, AnswerEvent>();
				const previous = byQuestion.get(event.question);
				if (!previous || compareEvents(previous, event) < 0) byQuestion.set(event.question, event);
				this.answers.set(event.post, byQuestion);
				this.history.push(event);
				break;
			}
		}
	}

	post(id: string): PostEvent | undefined {
		return this.postsById.get(id);
	}

	postOfItem(itemId: string): PostEvent | undefined {
		const postId = this.itemPost.get(itemId);
		return postId ? this.postsById.get(postId) : undefined;
	}

	verdictOf(itemId: string): Verdict | null {
		return this.verdicts.get(itemId)?.verdict ?? null;
	}

	view(post: PostEvent): PostView {
		return {
			...post,
			items: post.items.map((item) => ({ ...item, verdict: this.verdictOf(item.id) })),
			comments: this.comments.get(post.id) ?? [],
			answers: Object.fromEntries(this.answers.get(post.id) ?? []),
		};
	}

	answerOf(postId: string, questionId: string): AnswerEvent | undefined {
		return this.answers.get(postId)?.get(questionId);
	}

	/** Questions of a post that have no answer yet. */
	openQuestions(post: PostEvent): Question[] {
		return (post.questions ?? []).filter((question) => !this.answerOf(post.id, question.id));
	}

	/** Newest first. `before` is a post id to page from. */
	list(options: { limit?: number; before?: string; lane?: string; project?: string; issue?: string } = {}): PostView[] {
		const out: PostView[] = [];
		let skipping = Boolean(options.before);
		for (let index = this.posts.length - 1; index >= 0; index--) {
			const post = this.posts[index]!;
			if (skipping) {
				if (post.id === options.before) skipping = false;
				continue;
			}
			if (options.lane && post.lane !== options.lane) continue;
			if (options.project && post.project !== options.project) continue;
			if (options.issue && post.issue?.toLowerCase() !== options.issue.toLowerCase()) continue;
			out.push(this.view(post));
			if (options.limit && out.length >= options.limit) break;
		}
		return out;
	}

	lanes(): { project: string; lane: string; issue?: string; count: number; last: string }[] {
		const lanes = new Map<string, { project: string; lane: string; issue?: string; count: number; last: string }>();
		for (const post of this.posts) {
			const key = `${post.project}\u0000${post.lane}`;
			const lane = lanes.get(key) ?? { project: post.project, lane: post.lane, count: 0, last: post.at };
			lane.count++;
			lane.last = post.at;
			if (post.issue) lane.issue = post.issue;
			lanes.set(key, lane);
		}
		return [...lanes.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
	}
}
