// Getting the user's feedback back to the agent session that asked for it.
//
// Every post remembers the agent session that showed it. A comment the user
// writes on a post is "for" that session, and stays pending until it has been
// handed to the session once: by `agent-dailies watch` (which an agent leaves
// running in the background, so a comment wakes it up), by the Stop hook (so an
// agent about to stop reads it first), or by the UserPromptSubmit hook (so it
// rides along with the user's next message). What was handed over is recorded
// per session in sessions/<id>.json as the time of the last event delivered.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Catalog, CommentEvent, PostEvent, Store, VerdictEvent } from "./store.ts";

export type Feedback = VerdictEvent | CommentEvent;

function sessionFile(store: Store, session: string): string {
	return join(store.home, "sessions", `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

interface SessionState {
	/** Time of the last feedback event handed to the session. */
	delivered?: string;
	/** The newest post the Stop hook has already asked the agent to watch for. */
	reminded?: string;
}

export function readSession(store: Store, session: string): SessionState {
	try {
		return JSON.parse(readFileSync(sessionFile(store, session), "utf8")) as SessionState;
	} catch {
		return {};
	}
}

export function writeSession(store: Store, session: string, change: SessionState): void {
	mkdirSync(join(store.home, "sessions"), { recursive: true });
	writeFileSync(sessionFile(store, session), `${JSON.stringify({ ...readSession(store, session), ...change })}\n`);
}

export function deliveredUntil(store: Store, session: string): string {
	return readSession(store, session).delivered ?? "";
}

export function markDelivered(store: Store, session: string, events: Feedback[]): void {
	const last = events.reduce((latest, event) => (event.at > latest ? event.at : latest), deliveredUntil(store, session));
	if (last) writeSession(store, session, { delivered: last });
}

/** The user's marks and comments on this session's posts that it has not been given yet. */
export function pendingFor(catalog: Catalog, store: Store, session: string): Feedback[] {
	const since = deliveredUntil(store, session);
	return catalog.history.filter((event) => event.by === "human" && event.at > since && catalog.post(event.post)?.session === session);
}

export function hasComment(events: Feedback[]): boolean {
	return events.some((event) => event.type === "comment");
}

export function postedBy(catalog: Catalog, session: string, withinMs?: number): PostEvent[] {
	const from = withinMs ? new Date(Date.now() - withinMs).toISOString() : "";
	return catalog.posts.filter((post) => post.session === session && post.at > from);
}

/** Feedback left in a lane on posts of other, earlier sessions that never got it. */
export function orphanedIn(catalog: Catalog, store: Store, project: string, lane: string, session?: string): Feedback[] {
	const delivered = new Map<string, string>();
	return catalog.history.filter((event) => {
		if (event.by !== "human") return false;
		const post = catalog.post(event.post);
		if (!post || post.project !== project || post.lane !== lane || !post.session || post.session === session) return false;
		if (!delivered.has(post.session)) delivered.set(post.session, deliveredUntil(store, post.session));
		return event.at > delivered.get(post.session)!;
	});
}

export function describeFeedback(catalog: Catalog, events: Feedback[]): string[] {
	const lines: string[] = [];
	for (const event of events) {
		const post = catalog.post(event.post);
		const item = event.item ? post?.items.find((candidate) => candidate.id === event.item) : undefined;
		const where = post ? `"${post.title ?? post.items.map((entry) => entry.name).join(", ")}" (${post.id})` : event.post;
		const about = item ? `${item.name} (${item.id}) in ${where}` : where;
		if (event.type === "comment") lines.push(`- Comment on ${about}: ${event.text}`);
		else lines.push(`- ${event.verdict ? `Marked ${event.verdict}` : "Cleared the mark on"}: ${about}`);
	}
	return lines;
}
