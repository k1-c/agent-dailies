// Works out where a post comes from: the project (repository), the lane (the
// worktree or branch the agent works in), the issue its branch names, and the
// agent session. The viewer groups posts by these, so two agents working in two
// worktrees at once never get mixed up.

import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import type { Where } from "./store.ts";

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

// Words that come before a number in branch names without being an issue key.
const NOT_KEYS = new Set(["release", "version", "hotfix", "fix", "feature", "feat", "bump", "update", "patch", "revert", "chore", "build", "v", "pr", "wip", "draft", "test", "tmp"]);

/** `summ-239`, `ABC-12`, `shunkimura/summ-239-familiar` → `SUMM-239`. */
export function issueFromBranch(branch: string | undefined): string | undefined {
	if (!branch) return undefined;
	const pattern = /(?:^|[/_-])([a-z][a-z0-9]{1,9})-(\d+)(?=$|[/_.-])/gi;
	for (const match of branch.matchAll(pattern)) {
		if (!NOT_KEYS.has(match[1]!.toLowerCase())) return `${match[1]!.toUpperCase()}-${match[2]}`;
	}
	return undefined;
}

export function detectWhere(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Where {
	const session = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || env.AGENT_DAILIES_SESSION || undefined;
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top) {
		const name = basename(resolve(cwd));
		return { project: name, lane: name, session, cwd };
	}
	const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const mainRoot = common && basename(common) === ".git" ? dirname(common) : top;
	const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const inWorktree = resolve(top) !== resolve(mainRoot);
	return {
		project: basename(mainRoot),
		lane: inWorktree ? basename(top) : branch && branch !== "HEAD" ? branch : basename(top),
		branch: branch && branch !== "HEAD" ? branch : undefined,
		issue: issueFromBranch(branch),
		session,
		cwd,
	};
}
