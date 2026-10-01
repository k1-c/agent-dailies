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

test("a devlog entry records merged work only: refused on the branch, suggested and attached once it lands", async () => {
	assert.equal((await run(["hook", "session-start"], JSON.stringify({ session_id: "dev-session", cwd: repo }))).code, 0);
	const shown = JSON.parse((await run(["show", writeFile(dir, "old.png", PNG), "--json"])).stdout) as { post: { items: { id: string }[] } };
	const oldId = shown.post.items[0]!.id;

	git("checkout", "-q", "-b", "feat/summ-12-cape");
	writeFileSync(join(repo, "cape.txt"), "thick");
	git("add", "cape.txt");
	git("commit", "-q", "-m", "feat: a thicker cape");

	// On the branch: nothing is suggested, and recording is refused.
	assert.equal((await run(["hook", "stop"], JSON.stringify({ session_id: "dev-session", cwd: repo }))).code, 0);
	const early = await run(["devlog", "add", "--title", "Thicker cape", "--summary", "x"]);
	assert.notEqual(early.code, 0);
	assert.match(early.stderr, /work on feat\/summ-12-cape is not on main yet/);
	assert.match(early.stderr, /only work merged into the main branch/);
	const range = await run(["devlog", "add", "--title", "Thicker cape", "--summary", "x", "--commits", "main..HEAD"]);
	assert.notEqual(range.code, 0);
	assert.match(range.stderr, /1 of these commits are not on main yet/);

	// The merge, as the agent runs it: the PreToolUse hook notes it before it runs.
	git("checkout", "-q", "main");
	const merge = "git merge --ff-only feat/summ-12-cape";
	assert.equal((await run(["hook", "pre-tool-use"], JSON.stringify({ session_id: "dev-session", cwd: repo, tool_name: "Bash", tool_input: { command: merge } }))).code, 0);
	git("merge", "-q", "--ff-only", "feat/summ-12-cape");

	// Once it has landed, the Stop hook suggests an entry once.
	const reminded = await run(["hook", "stop"], JSON.stringify({ session_id: "dev-session", cwd: repo }));
	assert.equal(reminded.code, 2);
	assert.match(reminded.stderr, /landed on the main branch/);
	assert.match(reminded.stderr, /game: 1 commit on main from feat\/summ-12-cape \(latest: feat: a thicker cape\)/);
	assert.match(reminded.stderr, /## 工夫/);
	assert.match(reminded.stderr, /## 苦労/);
	assert.match(reminded.stderr, /short videos when the change is in motion/);
	assert.equal((await run(["hook", "stop"], JSON.stringify({ session_id: "dev-session", cwd: repo }))).code, 0);

	const added = await run(
		[
			"devlog", "add", "--title", "Thicker cape", "--summary", "-",
			"--before", oldId,
			"--after", writeFile(dir, "new.png", Buffer.concat([PNG, Buffer.from("x")])), writeFile(dir, "run.mp4", Buffer.from("not really a video")),
			"--json",
		],
		"Reads at game size.\n## 工夫\nPushed the cloth out along its normals.\n## 苦労\nThe hood clipped the horns at first.\n## Decided\nKeep the darker hem.",
	);
	assert.equal(added.code, 0, added.stderr);
	const { post } = JSON.parse(added.stdout) as {
		post: {
			kind: string;
			title: string;
			issue: string;
			devlog: { summary: string; craft: string; struggle: string; decided: string; before: string[]; after: string[]; commits: { subject: string }[] };
			items: { id: string; name: string; kind: string }[];
		};
	};
	assert.equal(post.kind, "devlog");
	assert.equal(post.issue, "SUMM-12");
	assert.equal(post.devlog.summary, "Reads at game size.");
	assert.equal(post.devlog.craft, "Pushed the cloth out along its normals.");
	assert.equal(post.devlog.struggle, "The hood clipped the horns at first.");
	assert.equal(post.devlog.decided, "Keep the darker hem.");
	assert.deepEqual(post.devlog.commits.map((commit) => commit.subject), ["feat: a thicker cape"]);
	assert.equal(post.devlog.before.length, 1);
	assert.equal(post.items.find((item) => item.id === post.devlog.before[0])!.name, "old.png");
	assert.notEqual(post.devlog.before[0], oldId);
	assert.deepEqual(post.devlog.after.map((id) => post.items.find((item) => item.id === id)!.kind), ["image", "video"]);

	// The same merged work is not attached twice.
	const again = await run(["devlog", "add", "--title", "Again", "--summary", "x"]);
	assert.notEqual(again.code, 0);
	assert.match(again.stderr, /already in a devlog entry/);

	const summary = (await run(["devlog", "summary"])).stdout;
	assert.match(summary, /### Thicker cape/);
	assert.match(summary, /Reads at game size\./);
	assert.match(summary, /Craft \(工夫\):\nPushed the cloth/);
	assert.match(summary, /Struggle \(苦労\):\nThe hood clipped/);
	assert.match(summary, /Before: old\.png/);
	assert.match(summary, /feat: a thicker cape/);

	assert.match((await run(["devlog", "summary", "--since", new Date(Date.now() + 60_000).toISOString()])).stdout, /Nothing was recorded in this period\./);
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

test("an entry without craft, struggle or before/after is recorded with a nudge", async () => {
	const result = await run(["devlog", "add", "--title", "Faster saves", "--summary", "Saving no longer stutters.", "--commits", "none"]);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /No craft \(工夫\) or struggle \(苦労\) written/);
	assert.match(result.stdout, /No before\/after pair/);
});

test("sections are split from one Markdown text, in Japanese or English", async () => {
	const { splitSections } = await import("../src/devlog.ts");
	assert.deepEqual(splitSections("What changed.\n\n## 工夫したこと\nA.\n### Struggle:\nB.\n## 決めたこと\nC.\n## Notes\nstill decided"), {
		summary: "What changed.",
		craft: "A.",
		struggle: "B.",
		decided: "C.\n## Notes\nstill decided",
	});
	assert.deepEqual(splitSections(""), { summary: undefined, craft: undefined, struggle: undefined, decided: undefined });
});

test("the merges and commits a shell command runs are found, following cd and git -C", async () => {
	const { gitSteps } = await import("../src/landed.ts");
	assert.deepEqual(gitSteps("cd /work/game && git merge --ff-only shunkimura/summ-249-hunger && git push origin main", "/home"), [
		{ cwd: "/work/game", kind: "merge", ref: "shunkimura/summ-249-hunger" },
	]);
	assert.deepEqual(gitSteps("git -C ../other merge -m 'Merge it' --no-ff topic", "/work/game"), [{ cwd: "/work/other", kind: "merge", ref: "topic" }]);
	assert.deepEqual(gitSteps("git add a.ts && git commit -q -m 'feat: x'", "/w"), [{ cwd: "/w", kind: "commit" }]);
	assert.deepEqual(gitSteps("git merge --abort; git log --oneline -1 main", "/w"), []);
	assert.deepEqual(gitSteps("echo 'git merge topic'", "/w"), []);
});

test("commits made straight on the main branch count as landed", async () => {
	const solo = join(dir, "solo");
	mkdirSync(solo);
	const sh = (...args: string[]) => execFileSync("git", args, { cwd: solo, env: { ...process.env, ...gitEnv }, stdio: "ignore" });
	sh("init", "-q", "-b", "main");
	sh("commit", "-q", "--allow-empty", "-m", "start");
	const soloEnv = { ...env, CLAUDE_CODE_SESSION_ID: "solo-session" };
	const runHere = (args: string[], input = "") =>
		new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
			const child = execFile(process.execPath, [CLI, ...args], { env: soloEnv, cwd: solo }, (error, stdout, stderr) =>
				resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
			);
			child.stdin!.end(input);
		});
	const hookInput = (command: string) => JSON.stringify({ session_id: "solo-session", cwd: solo, tool_name: "Bash", tool_input: { command } });
	await runHere(["hook", "pre-tool-use"], hookInput("git add -A && git commit -m 'feat: faster saves'"));
	writeFileSync(join(solo, "save.txt"), "fast");
	sh("add", "save.txt");
	sh("commit", "-q", "-m", "feat: faster saves");
	const reminded = await runHere(["hook", "stop"], JSON.stringify({ session_id: "solo-session", cwd: solo }));
	assert.equal(reminded.code, 2);
	assert.match(reminded.stderr, /solo: 1 commit on main \(latest: feat: faster saves\)/);
	const added = await runHere(["devlog", "add", "--title", "Faster saves", "--summary", "No stutter.", "--json"]);
	assert.equal(added.code, 0, added.stderr);
	assert.deepEqual((JSON.parse(added.stdout) as { post: { devlog: { commits: { subject: string }[] } } }).post.devlog.commits.map((commit) => commit.subject), ["feat: faster saves"]);
});
