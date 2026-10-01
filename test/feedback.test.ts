import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { hasComment, markDelivered, orphanedIn, pendingFor, postedBy } from "../src/feedback.ts";
import { buildPost, Store, type CommentEvent, type VerdictEvent } from "../src/store.ts";
import { PNG, tempDir, writeFile } from "./helpers.ts";

async function setup() {
	const dir = tempDir();
	const store = new Store(join(dir, "home"), "m");
	const item = await store.addFile(writeFile(dir, "a.png", PNG));
	const mine = buildPost({ project: "game", lane: "summ-1", session: "s1", items: [item] }, "m", new Date("2026-10-01T00:00:00Z"));
	const old = buildPost({ project: "game", lane: "summ-1", session: "s0", items: [{ ...item, id: "i_old" }] }, "m", new Date("2026-09-30T00:00:00Z"));
	store.append(old);
	store.append(mine);
	const comment = (id: string, post: string, at: string, by: "human" | "agent" = "human"): CommentEvent => ({
		type: "comment",
		id,
		at,
		machine: "m",
		post,
		text: id,
		by,
	});
	const verdict = (id: string, at: string): VerdictEvent => ({ type: "verdict", id, at, machine: "m", post: mine.id, item: item.id, verdict: "adopted", by: "human" });
	return { store, mine, old, comment, verdict };
}

test("a session gets the feedback on its own posts once", async () => {
	const { store, mine, old, comment, verdict } = await setup();
	store.append(verdict("v1", "2026-10-01T00:01:00Z"));
	store.append(comment("c1", mine.id, "2026-10-01T00:02:00Z"));
	store.append(comment("c-agent", mine.id, "2026-10-01T00:02:30Z", "agent"));
	store.append(comment("c-other", old.id, "2026-10-01T00:03:00Z"));

	let pending = pendingFor(store.load(), store, "s1");
	assert.deepEqual(pending.map((event) => event.id), ["v1", "c1"]);
	assert.equal(hasComment(pending), true);
	markDelivered(store, "s1", pending);
	assert.deepEqual(pendingFor(store.load(), store, "s1"), []);

	store.append(verdict("v2", "2026-10-01T00:04:00Z"));
	pending = pendingFor(store.load(), store, "s1");
	assert.deepEqual(pending.map((event) => event.id), ["v2"]);
	assert.equal(hasComment(pending), false);
});

test("feedback no session took is found by the next session in the worktree", async () => {
	const { store, old, comment } = await setup();
	store.append(comment("c-left", old.id, "2026-10-01T00:05:00Z"));
	const catalog = store.load();
	assert.deepEqual(orphanedIn(catalog, store, "game", "summ-1", "s2").map((event) => event.id), ["c-left"]);
	assert.deepEqual(orphanedIn(catalog, store, "game", "summ-1", "s0"), []);
	assert.deepEqual(orphanedIn(catalog, store, "game", "main", "s2"), []);
	assert.equal(postedBy(catalog, "s1").length, 1);
	assert.equal(postedBy(catalog, "s1", 1000).length, 0);
});
