// The devlog: a record of how the work changed, kept as the agent goes, so
// that summaries ("what happened since the last update") can be written later
// from it — without fixed-point screenshots taken on a schedule.
//
// - At the end of a piece of work the agent looks back over its session and,
//   when something changed that a person would notice, records a devlog entry
//   (a post of kind "devlog"): what changed and why, the commits, and
//   before/after files when a picture shows it better than words.
// - The Claude Code transcripts of the sessions are copied into the store, as
//   Claude Code deletes them after a while; summaries can point into them.
// - A cut marks where the last summary (an update video, a post) ended; the
//   next summary starts there.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AnswerEvent, Catalog, CommitRef, PostEvent, Store } from "./store.ts";

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }).trim();
	} catch {
		return undefined;
	}
}

export function headOf(cwd: string): string | undefined {
	return git(cwd, ["rev-parse", "HEAD"]) || undefined;
}

function parseLog(output: string | undefined): CommitRef[] {
	if (!output) return [];
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha, at, ...subject] = line.split("\t");
			return { sha: sha!, at, subject: subject.join("\t") };
		});
}

const FORMAT = "--format=%H%x09%cI%x09%s";

/** Commits in `from..to` (newest first). */
export function commitsBetween(cwd: string, from: string, to = "HEAD"): CommitRef[] {
	return parseLog(git(cwd, ["log", FORMAT, `${from}..${to}`]));
}

/** Commits on the repository's current branch made in a time range (newest first). */
export function commitsIn(cwd: string, since?: string, until?: string): CommitRef[] {
	const args = ["log", FORMAT];
	if (since) args.push(`--since=${since}`);
	if (until) args.push(`--until=${until}`);
	return parseLog(git(cwd, args));
}

/** The main checkout of a repository, from any of its worktrees. */
export function repositoryRoot(cwd: string): string | undefined {
	const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!common) return undefined;
	return basename(common) === ".git" ? join(common, "..") : git(cwd, ["rev-parse", "--show-toplevel"]);
}

// ---- entry sections ----

export interface DevlogSections {
	summary?: string;
	craft?: string;
	struggle?: string;
	decided?: string;
}

// Headings an agent (or a person) may use in one Markdown entry, in English or Japanese.
const HEADINGS: Record<keyof DevlogSections, RegExp> = {
	summary: /^(変わったこと|何が変わったか|変更|changed|what changed|summary)$/i,
	craft: /^(工夫|工夫したこと|うまくいったこと|craft|ingenuity|what worked)$/i,
	struggle: /^(苦労|苦労したこと|つまずいたこと|struggle|struggles|what was hard|hard parts)$/i,
	decided: /^(決めたこと|決まったこと|決定|decided|decisions)$/i,
};

/** Splits "## 工夫" / "## Struggle" … sections out of one Markdown text; the rest is the summary. */
export function splitSections(markdown: string): DevlogSections {
	const parts: Record<keyof DevlogSections, string[]> = { summary: [], craft: [], struggle: [], decided: [] };
	let current: keyof DevlogSections = "summary";
	for (const line of markdown.split("\n")) {
		const heading = /^#{1,4}\s+(.+?)\s*[:：]?\s*$/.exec(line);
		const key = heading ? (Object.keys(HEADINGS) as (keyof DevlogSections)[]).find((name) => HEADINGS[name].test(heading[1]!.trim())) : undefined;
		if (key) {
			current = key;
			continue;
		}
		parts[current].push(line);
	}
	const text = (lines: string[]) => lines.join("\n").trim() || undefined;
	return { summary: text(parts.summary), craft: text(parts.craft), struggle: text(parts.struggle), decided: text(parts.decided) };
}

// ---- transcripts ----

export function transcriptDir(store: Store, project: string): string {
	return join(store.home, "transcripts", project.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/** Copies a session's transcript into the store when it has grown. Returns the copy's path. */
export function keepTranscript(store: Store, project: string, session: string, source: string): string | undefined {
	if (!source || !existsSync(source)) return undefined;
	const dir = transcriptDir(store, project);
	const target = join(dir, `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
	const from = statSync(source);
	if (existsSync(target)) {
		const to = statSync(target);
		if (to.size >= from.size && to.mtimeMs >= from.mtimeMs) return target;
	}
	mkdirSync(dir, { recursive: true });
	copyFileSync(source, target);
	return target;
}

export function transcriptsOf(store: Store, project: string): { session: string; path: string; modified: string }[] {
	const dir = transcriptDir(store, project);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => {
			const path = join(dir, name);
			return { session: name.replace(/\.jsonl$/, ""), path, modified: statSync(path).mtime.toISOString() };
		});
}

// ---- summaries ----

export interface SummaryOptions {
	since: string;
	until?: string;
	project?: string;
}

export interface IssueSummary {
	key: string;
	title?: string;
	status?: string;
	url?: string;
	entries: PostEvent[];
	shown: PostEvent[];
	answers: AnswerEvent[];
}

export interface Summary {
	since: string;
	until: string;
	project?: string;
	issues: IssueSummary[];
	/** Work without an issue, by branch. */
	branches: { lane: string; entries: PostEvent[]; shown: PostEvent[]; answers: AnswerEvent[] }[];
	commits: { repository: string; commits: CommitRef[] }[];
	transcripts: { session: string; path: string; modified: string }[];
}

/** Everything recorded in a period, grouped by issue, as material for a summary. */
export function collect(catalog: Catalog, store: Store, options: SummaryOptions): Summary {
	const until = options.until ?? new Date().toISOString();
	const inRange = (at: string) => at >= options.since && at <= until;
	const posts = catalog.posts.filter((post) => inRange(post.at) && (!options.project || post.project === options.project));
	const answers = catalog.history.filter(
		(event): event is AnswerEvent => event.type === "answer" && event.by === "human" && inRange(event.at),
	);
	const issues = new Map<string, IssueSummary>();
	const branches = new Map<string, { lane: string; entries: PostEvent[]; shown: PostEvent[]; answers: AnswerEvent[] }>();
	const bucket = (post: PostEvent) => {
		if (post.issue) {
			const key = post.issue.toUpperCase();
			let issue = issues.get(key);
			if (!issue) {
				const known = catalog.issue(key);
				issue = { key, title: known?.title, status: known?.status, url: known?.url, entries: [], shown: [], answers: [] };
				issues.set(key, issue);
			}
			return issue;
		}
		let branch = branches.get(post.lane);
		if (!branch) {
			branch = { lane: post.lane, entries: [], shown: [], answers: [] };
			branches.set(post.lane, branch);
		}
		return branch;
	};
	for (const post of posts) {
		const group = bucket(post);
		if (post.kind === "devlog") group.entries.push(post);
		else group.shown.push(post);
	}
	for (const answer of answers) {
		const post = catalog.post(answer.post);
		if (!post || (options.project && post.project !== options.project)) continue;
		bucket(post).answers.push(answer);
	}
	const repositories = new Set<string>();
	for (const post of posts) {
		const root = post.cwd && existsSync(post.cwd) ? repositoryRoot(post.cwd) : undefined;
		if (root) repositories.add(root);
	}
	const projects = new Set(posts.map((post) => post.project));
	return {
		since: options.since,
		until,
		project: options.project,
		issues: [...issues.values()],
		branches: [...branches.values()],
		commits: [...repositories].map((repository) => ({ repository, commits: commitsIn(repository, options.since, until) })),
		transcripts: [...projects].flatMap((project) => transcriptsOf(store, project).filter((transcript) => inRange(transcript.modified))),
	};
}

function answerLine(catalog: Catalog, answer: AnswerEvent): string {
	const post = catalog.post(answer.post);
	const question = post?.questions?.find((candidate) => candidate.id === answer.question);
	const chosen = answer.choices
		.map((id) => question?.options.find((option) => option.id === id))
		.filter(Boolean)
		.map((option) => `${option!.key}${option!.label ? ` (${option!.label})` : ""}`)
		.join(" + ");
	return `- ${question?.text ?? answer.question} → ${[chosen, answer.text ? `"${answer.text}"` : ""].filter(Boolean).join(" — ")}`;
}

/** The material as Markdown, for an agent (or a person) to write the summary from. */
export function summaryMarkdown(catalog: Catalog, store: Store, summary: Summary): string {
	const files = (post: PostEvent, ids: string[]) =>
		ids
			.map((id) => post.items.find((item) => item.id === id))
			.filter(Boolean)
			.map((item) => `${item!.name} (${store.blobPath(item!.sha256, item!.ext)})`);
	const lines = [`# Devlog material ${summary.since.slice(0, 16)} → ${summary.until.slice(0, 16)}${summary.project ? ` (${summary.project})` : ""}`, ""];
	const section = (heading: string, group: { entries: PostEvent[]; shown: PostEvent[]; answers: AnswerEvent[] }) => {
		lines.push(heading, "");
		for (const entry of group.entries) {
			lines.push(`### ${entry.title ?? "(untitled)"} — ${entry.at.slice(0, 16)} (${entry.id})`);
			if (entry.devlog?.summary) lines.push("", entry.devlog.summary.trim());
			if (entry.devlog?.craft) lines.push("", "Craft (工夫):", entry.devlog.craft.trim());
			if (entry.devlog?.struggle) lines.push("", "Struggle (苦労):", entry.devlog.struggle.trim());
			if (entry.devlog?.decided) lines.push("", "Decided:", entry.devlog.decided.trim());
			const before = files(entry, entry.devlog?.before ?? []);
			const after = files(entry, entry.devlog?.after ?? []);
			if (before.length) lines.push("", `Before: ${before.join("; ")}`);
			if (after.length) lines.push(`After: ${after.join("; ")}`);
			const rest = entry.items.filter((item) => !entry.devlog?.before.includes(item.id) && !entry.devlog?.after.includes(item.id));
			if (rest.length) lines.push(`Files: ${rest.map((item) => `${item.name} (${store.blobPath(item.sha256, item.ext)})`).join("; ")}`);
			if (entry.devlog?.commits.length) lines.push(`Commits: ${entry.devlog.commits.map((commit) => `${commit.sha.slice(0, 8)} ${commit.subject}`).join("; ")}`);
			lines.push("");
		}
		if (group.answers.length) lines.push("Decisions:", ...group.answers.map((answer) => answerLine(catalog, answer)), "");
		if (group.shown.length) {
			lines.push(`Shown for review (${group.shown.length}): ${group.shown.map((post) => `${post.title ?? post.items.map((item) => item.name).join(", ")} (${post.id})`).join("; ")}`, "");
		}
	};
	for (const issue of summary.issues) {
		section(`## ${issue.key}${issue.title ? ` ${issue.title}` : ""}${issue.status ? ` [${issue.status}]` : ""}`, issue);
	}
	for (const branch of summary.branches) section(`## Branch ${branch.lane}`, branch);
	for (const repository of summary.commits) {
		if (!repository.commits.length) continue;
		lines.push(`## Commits in ${repository.repository} (${repository.commits.length})`, "");
		for (const commit of repository.commits) lines.push(`- ${commit.sha.slice(0, 8)} ${commit.at?.slice(0, 16) ?? ""} ${commit.subject}`);
		lines.push("");
	}
	if (summary.transcripts.length) {
		lines.push("## Session transcripts (Claude Code)", "", ...summary.transcripts.map((transcript) => `- ${transcript.session} (${transcript.modified.slice(0, 16)}): ${transcript.path}`), "");
	}
	if (lines.length <= 2) lines.push("Nothing was recorded in this period.");
	return lines.join("\n");
}
