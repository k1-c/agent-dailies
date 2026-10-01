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
