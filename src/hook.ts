// Coding-agent hooks. The PreToolUse hook stops the agent from opening media in a
// new window (an image viewer, a video player) and points it at `show` instead;
// the SessionStart hook tells the agent the viewer exists.

import { basename } from "node:path";
import { isViewable } from "./media.ts";

const OPENERS = new Set([
	"xdg-open",
	"open",
	"eog",
	"feh",
	"sxiv",
	"nsxiv",
	"imv",
	"loupe",
	"gwenview",
	"ristretto",
	"display",
	"mpv",
	"vlc",
	"totem",
	"celluloid",
	"ffplay",
	"firefox",
	"chromium",
	"chromium-browser",
	"google-chrome",
	"google-chrome-stable",
	"brave",
	"microsoft-edge",
]);
const PREFIXES = new Set(["nohup", "setsid", "sudo", "env", "command", "exec", "nice", "time"]);
export const ALLOW_VARIABLE = "AGENT_DAILIES_ALLOW_OPEN";

/** Splits a shell command into simple commands and their words. Rough, but quote-aware. */
export function simpleCommands(command: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | null = null;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length) commands.push(words);
		words = [];
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (quote) {
			if (char === quote) quote = null;
			else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index];
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
		} else if (char === "\\" && index + 1 < command.length) {
			word += command[++index];
			inWord = true;
		} else if (char === " " || char === "\t") {
			endWord();
		} else if (";&|\n()`".includes(char)) {
			endCommand();
		} else if (char === "$" && command[index + 1] === "(") {
			endCommand();
			index++;
		} else {
			word += char;
			inWord = true;
		}
	}
	endCommand();
	return commands;
}

/** The media files a shell command would open in a window, if any. */
export function openedMedia(command: string): string[] {
	const opened: string[] = [];
	for (const words of simpleCommands(command)) {
		let start = 0;
		while (start < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!) || PREFIXES.has(words[start]!))) start++;
		const program = words[start];
		if (!program) continue;
		let args = words.slice(start + 1);
		const name = basename(program);
		if (name === "gio" && args[0] === "open") args = args.slice(1);
		else if (!OPENERS.has(name)) continue;
		opened.push(...args.filter((arg) => !arg.startsWith("-") && isViewable(arg)));
	}
	return opened;
}

export interface HookDecision {
	block: boolean;
	message?: string;
}

/** Decides on a Claude Code / Codex PreToolUse event (the parsed stdin JSON). */
export function preToolUse(input: unknown): HookDecision {
	const event = (input ?? {}) as { tool_name?: string; tool_input?: { command?: unknown } };
	if (event.tool_name !== "Bash" && event.tool_name !== "shell") return { block: false };
	const command = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
	if (!command || command.includes(`${ALLOW_VARIABLE}=1`)) return { block: false };
	const files = openedMedia(command);
	if (!files.length) return { block: false };
	const quoted = files.map((file) => (/[\s"'$]/.test(file) ? `'${file.replaceAll("'", "'\\''")}'` : file)).join(" ");
	return {
		block: true,
		message: [
			"agent-dailies: don't open media in a new window. Show it in the viewer the user keeps open:",
			`  agent-dailies show ${quoted} --title "<what to look at>"`,
			"It appears at the top of their viewer tab without stealing focus, next to what you showed before.",
			"Show the files to compare in one `show` so they sit side by side. `agent-dailies context` tells you",
			"which one they picked, and `agent-dailies feedback` lists their marks and comments.",
			`Only if the user asked for a separate window, prefix the command with ${ALLOW_VARIABLE}=1.`,
		].join("\n"),
	};
}

export function guideText(): string {
	return `agent-dailies is installed: the user reviews what you make in one browser tab
(the viewer) instead of opening files one by one. Whenever you want the user to
look at an image, video, GIF, audio clip, 3D model (GLB/glTF), PDF or other file:

- Run \`agent-dailies show <file>… --title "<what to look at>" [--note "<what changed>"]\`.
  It copies the files into the store and puts them at the top of the viewer;
  it opens the viewer in the browser only when no viewer is open. Don't also
  open the files in a window, and don't leave the user only a file path.
- Show alternatives in one call (\`show a.png b.png --title "Option A / B"\`) so they
  sit side by side. Keep titles short; say what to compare.
- When the user says "this", "the left one", "これ", "左の", "今見てるやつ" about
  something you showed, run \`agent-dailies context\` first: it prints the post and
  the file they selected (with a path you can read), its mark and comments.
- After showing something you want a reaction to, keep \`agent-dailies watch\`
  running in the background (Bash with run_in_background, timeout 7200000). It
  exits when the user writes a comment in the viewer, which wakes you up with the
  comment; act on it, then start it again. One per session is enough.
- \`agent-dailies feedback\` lists what they adopted, rejected or commented on.
- Posts are grouped by repository and worktree automatically; the issue comes
  from the branch name (override with --issue).`;
}
