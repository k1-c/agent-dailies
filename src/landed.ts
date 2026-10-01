// Work that has landed on the main branch. Devlog entries cover only that: work
// still on a branch may change or be dropped before it is merged, so it is not
// recorded until the user has approved the merge and it has gone through.
//
// The PreToolUse hook notes, per session, the merges the agent runs (`git merge
// <branch>`: the main tip before it and the branch tip) and the commits it makes
// straight on the main branch. Once a merge has gone through, its commits are the
// session's landed work: the Stop hook suggests a devlog entry for them and
// `devlog add` attaches them. Merges that were refused or never ran stay unlanded.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { commitsBetween, repositoryRoot } from "./devlog.ts";
import { simpleCommands } from "./hook.ts";
import type { CommitRef } from "./store.ts";

/** A `git merge <ref>` the session ran: `base` is the branch it merged into, before. */
export interface MergeRecord {
	repo: string;
	ref: string;
	base: string;
	tip: string;
	at: string;
}

/** The session committed straight on the main branch, starting from `base`. */
export interface DirectRecord {
	repo: string;
	base: string;
	at: string;
}

export interface LandingState {
	merges?: MergeRecord[];
	direct?: DirectRecord[];
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function succeeds(cwd: string, args: string[]): boolean {
	try {
		execFileSync("git", args, { cwd, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** The branch work is merged into: origin's default branch, else main, else master. */
export function mainBranch(cwd: string): string | undefined {
	const remote = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	for (const name of [remote?.replace(/^origin\//, ""), "main", "master"]) {
		if (name && succeeds(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return name;
	}
	return remote && succeeds(cwd, ["rev-parse", "--verify", "--quiet", remote]) ? remote : undefined;
}

export function isOnMain(cwd: string, sha: string, main = mainBranch(cwd)): boolean {
	return Boolean(main) && succeeds(cwd, ["merge-base", "--is-ancestor", sha, main!]);
}

/** A git step in a shell command that can land work on the main branch. */
export interface GitStep {
	cwd: string;
	kind: "merge" | "commit";
	ref?: string;
}

// Options of `git merge` that take a value, so the value is not taken for the branch.
const MERGE_VALUES = new Set(["-m", "-F", "-s", "-X", "--message", "--file", "--strategy", "--strategy-option", "--into-name"]);

/** The merges and commits a shell command runs, and in which folder (following `cd` and `git -C`). */
export function gitSteps(command: string, cwd: string): GitStep[] {
	const steps: GitStep[] = [];
	let here = cwd;
	const at = (base: string, dir: string) => resolve(base, dir.replace(/^~(?=\/|$)/, homedir()));
	for (const words of simpleCommands(command)) {
		let index = 0;
		while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
		const program = words[index];
		if (program === "cd" || program === "pushd") {
			const dir = words[index + 1];
			if (dir && !dir.startsWith("-")) here = at(here, dir);
			continue;
		}
		if (program !== "git") continue;
		let folder = here;
		let next = index + 1;
		while (next < words.length && words[next]!.startsWith("-")) {
			if (words[next] === "-C" && words[next + 1]) {
				folder = at(folder, words[next + 1]!);
				next += 2;
			} else if (words[next] === "-c") next += 2;
			else next++;
		}
		const sub = words[next];
		const rest = words.slice(next + 1);
		if (sub === "commit") steps.push({ cwd: folder, kind: "commit" });
		if (sub !== "merge" || rest.some((word) => ["--abort", "--continue", "--quit"].includes(word))) continue;
		for (let position = 0; position < rest.length; position++) {
			const word = rest[position]!;
			if (MERGE_VALUES.has(word)) position++;
			else if (!word.startsWith("-")) {
				steps.push({ cwd: folder, kind: "merge", ref: word });
				break;
			}
		}
	}
	return steps;
}

/** What to remember about a command before it runs (records for the session state). */
export function noteCommand(command: string, cwd: string, state: LandingState, now = new Date()): LandingState | undefined {
	if (!/\bgit\b/.test(command) || !/\b(merge|commit)\b/.test(command)) return undefined;
	const merges = [...(state.merges ?? [])];
	const direct = [...(state.direct ?? [])];
	let changed = false;
	for (const step of gitSteps(command, cwd)) {
		const repo = repositoryRoot(step.cwd);
		const base = repo && git(step.cwd, ["rev-parse", "HEAD"]);
		if (!repo || !base) continue;
		if (step.kind === "merge") {
			const tip = git(step.cwd, ["rev-parse", "--verify", "--quiet", `${step.ref}^{commit}`]);
			if (!tip || merges.some((merge) => merge.repo === repo && merge.tip === tip)) continue;
			merges.push({ repo, ref: step.ref!, base, tip, at: now.toISOString() });
			changed = true;
		} else {
			const branch = git(step.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
			if (!branch || branch !== mainBranch(step.cwd) || direct.some((record) => record.repo === repo)) continue;
			direct.push({ repo, base, at: now.toISOString() });
			changed = true;
		}
	}
	return changed ? { merges, direct } : undefined;
}

export interface Landed {
	repo: string;
	main: string;
	/** Newest first. */
	commits: CommitRef[];
	/** The branches whose merge brought them in. */
	refs: string[];
}

/** The session's work that is on the main branch now, per repository. */
export function landedWork(state: LandingState, onlyRepo?: string): Landed[] {
	const repos = new Set([...(state.merges ?? []).map((merge) => merge.repo), ...(state.direct ?? []).map((record) => record.repo)]);
	const result: Landed[] = [];
	for (const repo of repos) {
		if (onlyRepo && repo !== onlyRepo) continue;
		const main = mainBranch(repo);
		if (!main) continue;
		const seen = new Map<string, CommitRef>();
		const refs: string[] = [];
		for (const merge of state.merges ?? []) {
			if (merge.repo !== repo || !isOnMain(repo, merge.tip, main)) continue;
			const commits = commitsBetween(repo, merge.base, merge.tip);
			if (commits.length && !refs.includes(merge.ref)) refs.push(merge.ref);
			for (const commit of commits) seen.set(commit.sha, commit);
		}
		for (const record of state.direct ?? []) {
			if (record.repo !== repo) continue;
			for (const commit of commitsBetween(repo, record.base, main)) seen.set(commit.sha, commit);
		}
		if (!seen.size) continue;
		const commits = [...seen.values()].sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? 1 : -1));
		result.push({ repo, main, commits, refs });
	}
	return result;
}

/** Commits on the branch checked out at `cwd` that are not on the main branch yet. */
export function unmergedWork(cwd: string): { branch: string; main: string; commits: CommitRef[] } | undefined {
	const main = mainBranch(cwd);
	const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!main || !branch || branch === main) return undefined;
	const commits = commitsBetween(cwd, main, "HEAD");
	return commits.length ? { branch, main, commits } : undefined;
}
