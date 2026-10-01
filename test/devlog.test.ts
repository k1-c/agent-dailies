import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { PNG, tempDir, writeFile } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = tempDir();
const repo = join(dir, "game");
mkdirSync(repo);
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, ...gitEnv }, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("commit", "-q", "--allow-empty", "-m", "start");

const env = {
	...process.env,
	...gitEnv,
	AGENT_DAILIES_HOME: join(dir, "home"),
	AGENT_DAILIES_PORT: String(49000 + Math.floor(Math.random() * 900)),
	AGENT_DAILIES_NO_OPEN: "1",
	CLAUDE_CODE_SESSION_ID: "dev-session",
	CLAUDE_CONFIG_DIR: join(dir, "claude"),
	AGENT_DAILIES_AUTO_WATCH: "0",
};
const run = (args: string[], input?: string) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		const child = execFile(process.execPath, [CLI, ...args], { env, cwd: repo }, (error, stdout, stderr) =>
			resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
		);
		child.stdin!.end(input ?? "");
	});

after(async () => {
	await promisify(execFile)(process.execPath, [CLI, "stop"], { env }).catch(() => undefined);
});

test("a devlog entry records the session's commits and before/after, reusing shown files", async () => {
	assert.equal((await run(["hook", "session-start"], JSON.stringify({ session_id: "dev-session", cwd: repo }))).code, 0);
	const shown = JSON.parse((await run(["show", writeFile(dir, "old.png", PNG), "--json"])).stdout) as { post: { items: { id: string }[] } };
	const oldId = shown.post.items[0]!.id;

	writeFileSync(join(repo, "cape.txt"), "thick");
	git("add", "cape.txt");
	git("commit", "-q", "-m", "feat: a thicker cape");

	// The Stop hook suggests an entry once after the commit, then leaves it to the agent.
	const reminded = await run(["hook", "stop"], JSON.stringify({ session_id: "dev-session", cwd: repo }));
	assert.equal(reminded.code, 2);
	assert.match(reminded.stderr, /1 commit since it began \(latest: feat: a thicker cape\)/);
	assert.equal((await run(["hook", "stop"], JSON.stringify({ session_id: "dev-session", cwd: repo }))).code, 0);

	const added = await run(["devlog", "add", "--title", "Thicker cape", "--summary", "-", "--before", oldId, "--after", writeFile(dir, "new.png", Buffer.concat([PNG, Buffer.from("x")])), "--json"], "Reads at game size.");
	assert.equal(added.code, 0, added.stderr);
	const { post } = JSON.parse(added.stdout) as {
		post: { kind: string; title: string; devlog: { summary: string; before: string[]; after: string[]; commits: { subject: string }[] }; items: { id: string; name: string }[] };
	};
	assert.equal(post.kind, "devlog");
	assert.equal(post.devlog.summary, "Reads at game size.");
	assert.deepEqual(post.devlog.commits.map((commit) => commit.subject), ["feat: a thicker cape"]);
	assert.equal(post.devlog.before.length, 1);
	assert.equal(post.items.find((item) => item.id === post.devlog.before[0])!.name, "old.png");
	assert.notEqual(post.devlog.before[0], oldId);

	const summary = (await run(["devlog", "summary"])).stdout;
	assert.match(summary, /### Thicker cape/);
	assert.match(summary, /Reads at game size\./);
	assert.match(summary, /Before: old\.png/);
	assert.match(summary, /feat: a thicker cape/);

	assert.match((await run(["devlog", "cut", "--name", "Update 1"])).stdout, /next summary starts here/);
	assert.match((await run(["devlog", "summary"])).stdout, /Nothing was recorded in this period\./);
	assert.match((await run(["devlog", "summary", "--since", "1d"])).stdout, /Thicker cape/);
	assert.match((await run(["devlog", "list"])).stdout, /Thicker cape/);
});

test("transcripts are kept from the session end and by sweeping the project's folders", async () => {
	const projects = join(dir, "claude", "projects");
	const folder = join(projects, repo.replace(/[^A-Za-z0-9]/g, "-"));
	mkdirSync(folder, { recursive: true });
	const transcript = writeFile(folder, "s-1.jsonl", '{"type":"user"}\n');
	await run(["hook", "session-end"], JSON.stringify({ session_id: "s-1", cwd: repo, transcript_path: transcript }));
	const kept = join(dir, "home", "transcripts", "game", "s-1.jsonl");
	assert.equal(readFileSync(kept, "utf8"), '{"type":"user"}\n');

	const worktreeFolder = join(projects, `${repo.replace(/[^A-Za-z0-9]/g, "-")}--claude-worktrees-x`);
	mkdirSync(worktreeFolder, { recursive: true });
	writeFile(worktreeFolder, "s-2.jsonl", "{}\n");
	assert.match((await run(["devlog", "sweep"])).stdout, /Kept 2 transcripts/);
	assert.ok(existsSync(join(dir, "home", "transcripts", "game", "s-2.jsonl")));
});
