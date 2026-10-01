import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { PNG, tempDir, writeFile } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = tempDir();
const env = {
	...process.env,
	AGENT_DAILIES_HOME: join(dir, "home"),
	AGENT_DAILIES_PORT: String(47000 + Math.floor(Math.random() * 2000)),
	AGENT_DAILIES_NO_OPEN: "1",
	CLAUDE_CODE_SESSION_ID: "cli-session",
};
const run = (args: string[], input?: string) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		const child = execFile(process.execPath, [CLI, ...args], { env, cwd: dir }, (error, stdout, stderr) =>
			resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
		);
		if (input !== undefined) child.stdin!.end(input);
	});

after(async () => {
	await promisify(execFile)(process.execPath, [CLI, "stop"], { env }).catch(() => undefined);
});

test("show starts the viewer, and a comment wakes watch", async () => {
	const image = writeFile(dir, "shot.png", PNG);
	const shown = await run(["show", image, "--title", "First", "--json"]);
	assert.equal(shown.code, 0, shown.stderr);
	const { post, url } = JSON.parse(shown.stdout) as { post: { id: string; session: string }; url: string };
	assert.equal(post.session, "cli-session");

	const stop = await run(["hook", "stop"], JSON.stringify({ session_id: "cli-session" }));
	assert.equal(stop.code, 2);
	assert.match(stop.stderr, /agent-dailies watch/);
	assert.equal((await run(["hook", "stop"], JSON.stringify({ session_id: "cli-session" }))).code, 0);

	const watcher = spawn(process.execPath, [CLI, "watch", "--timeout", "60s"], { env, cwd: dir });
	let output = "";
	watcher.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const exited = new Promise<number>((resolve) => watcher.on("exit", (code) => resolve(code ?? -1)));
	const base = new URL(url).origin;
	for (let tries = 0; tries < 50; tries++) {
		const { watching } = (await (await fetch(`${base}/api/watchers?session=cli-session`)).json()) as { watching: number };
		if (watching) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	await fetch(`${base}/api/comments`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ post: post.id, text: "make it bigger", by: "human" }),
	});
	assert.equal(await exited, 0);
	assert.match(output, /make it bigger/);

	const context = await run(["context"]);
	assert.match(context.stdout, /shot\.png/);
	assert.match(context.stdout, /make it bigger/);
});

test("ask posts a question, and wait exits with the answer", async () => {
	const image = writeFile(dir, "option.png", PNG);
	const asked = await run(["ask", "Keep this one?", image, "--option", "No, redo it", "--json"]);
	assert.equal(asked.code, 0, asked.stderr);
	const { post, url } = JSON.parse(asked.stdout) as { post: { id: string; title: string; questions: { options: { id: string; key: string; label?: string }[] }[] }; url: string };
	assert.equal(post.title, "Keep this one?");
	assert.deepEqual(
		post.questions[0]!.options.map((option) => [option.key, option.label ?? null]),
		[
			["A", null],
			["B", "No, redo it"],
		],
	);

	const waiter = spawn(process.execPath, [CLI, "wait", post.id, "--timeout", "60s"], { env, cwd: dir });
	let output = "";
	waiter.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const exited = new Promise<number>((resolve) => waiter.on("exit", (code) => resolve(code ?? -1)));
	const base = new URL(url).origin;
	for (let tries = 0; tries < 50; tries++) {
		const { watching } = (await (await fetch(`${base}/api/watchers?session=none&post=${post.id}`)).json()) as { watching: number };
		if (watching) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	await fetch(`${base}/api/answers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ post: post.id, question: "q1", choices: [post.questions[0]!.options[1]!.id], text: "too dark", by: "human" }),
	});
	assert.equal(await exited, 0);
	assert.match(output, /answered: B \(No, redo it\) — "too dark"/);
});

test("ask groups the files after --pattern into one option", async () => {
	const files = ["c1.png", "c2.png", "w1.png", "w2.png"].map((name) => writeFile(dir, name, PNG));
	const asked = await run(["ask", "Which palette?", "--pattern", "Current", files[0]!, files[1]!, "--pattern", "Warmer", files[2]!, files[3]!, "--option", "Neither", "--json", "--no-open"]);
	assert.equal(asked.code, 0, asked.stderr);
	const { post } = JSON.parse(asked.stdout) as { post: { items: { id: string; name: string }[]; questions: { options: { key: string; label?: string; items: string[] }[] }[] } };
	const names = new Map(post.items.map((item) => [item.id, item.name]));
	assert.deepEqual(
		post.questions[0]!.options.map((option) => [option.key, option.label, option.items.map((id) => names.get(id))]),
		[
			["A", "Current", ["c1.png", "c2.png"]],
			["B", "Warmer", ["w1.png", "w2.png"]],
			["C", "Neither", []],
		],
	);
});

test("the Stop hook does not ask to wait on a post the user already replied to", async () => {
	const shown = await run(["show", writeFile(dir, "reply.png", PNG), "--json"]);
	const { post, url } = JSON.parse(shown.stdout) as { post: { id: string }; url: string };
	await fetch(`${new URL(url).origin}/api/comments`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ post: post.id, text: "OK", by: "human" }),
	});
	const stop = await run(["hook", "stop"], JSON.stringify({ session_id: "cli-session" }));
	// The OK is handed over (exit 2 with it) the first time, and then nothing is left to say.
	assert.match(stop.stderr, /OK/);
	assert.equal((await run(["hook", "stop"], JSON.stringify({ session_id: "cli-session" }))).code, 0);
});

test("ask --file takes a review sheet with files relative to it", async () => {
	writeFile(dir, "sketch.png", PNG);
	const sheet = writeFile(
		dir,
		"sheet.json",
		JSON.stringify({
			title: "Review",
			questions: [
				{ text: "Layout", why: "**why**", files: ["sketch.png"], options: ["OK", { label: "Alternative", body: "- shorter" }, "Discuss"] },
				{ text: "Colors", multi: true, options: ["Red", "Blue"] },
			],
		}),
	);
	const asked = await run(["ask", "--file", sheet, "--json", "--no-open"]);
	assert.equal(asked.code, 0, asked.stderr);
	const { post } = JSON.parse(asked.stdout) as { post: { title: string; items: unknown[]; questions: { id: string; multi?: boolean; items: string[] }[] } };
	assert.equal(post.title, "Review");
	assert.equal(post.items.length, 1);
	assert.deepEqual(post.questions.map((question) => [question.id, question.items.length, Boolean(question.multi)]), [
		["q1", 1, false],
		["q2", 0, true],
	]);
});

test("issue describes an issue, or fetches it with the configured command", async () => {
	const set = await run(["issue", "ABC-3", "--title", "Blue capes", "--status", "Todo"]);
	assert.equal(set.code, 0, set.stderr);
	assert.match(set.stdout, /^ABC-3 Blue capes\nTodo/);
	const fetched = await new Promise<{ code: number; stdout: string }>((resolve) =>
		execFile(
			process.execPath,
			[CLI, "issue", "ABC-3", "--refresh", "--json"],
			{ env: { ...env, AGENT_DAILIES_ISSUE_COMMAND: `printf '{"title":"From the tracker","body":"Details","state":"OPEN"}'` }, cwd: dir },
			(error, stdout) => resolve({ code: error ? 1 : 0, stdout }),
		),
	);
	assert.equal(fetched.code, 0);
	const event = JSON.parse(fetched.stdout) as { title: string; description: string; status: string };
	assert.deepEqual([event.title, event.description, event.status], ["From the tracker", "Details", "OPEN"]);
	assert.match((await run(["issue", "ABC-3"])).stdout, /From the tracker/);
});

test("the launcher runs the sources with no install", async () => {
	const launcher = fileURLToPath(new URL("../bin/agent-dailies", import.meta.url));
	const { stdout } = await promisify(execFile)("sh", [launcher, "--version"], { env });
	assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

test("the plugin hook script puts the launcher on PATH at session start", async () => {
	const script = fileURLToPath(new URL("../hooks/run.sh", import.meta.url));
	const envFile = writeFile(dir, "claude-env", "");
	const child = execFile("sh", [script, "session-start"], { env: { ...env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_ROOT: "" } });
	child.stdin!.end(JSON.stringify({ session_id: "x", cwd: dir }));
	const output = await new Promise<string>((resolve) => {
		let text = "";
		child.stdout!.on("data", (chunk: Buffer) => (text += chunk.toString()));
		child.on("exit", () => resolve(text));
	});
	assert.match(output, /agent-dailies show/);
	const { readFileSync } = await import("node:fs");
	assert.match(readFileSync(envFile, "utf8"), /^export PATH=".*\/bin:\$PATH"$/m);
});

test("the PreToolUse hook blocks opening an image", async () => {
	const result = await run(["hook", "pre-tool-use"], JSON.stringify({ tool_name: "Bash", tool_input: { command: "xdg-open shot.png" } }));
	assert.equal(result.code, 2);
	assert.match(result.stderr, /agent-dailies show shot\.png/);
	assert.equal((await run(["hook", "pre-tool-use"], JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }))).code, 0);
});
