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
	return `agent-dailies is installed: the user reviews your work in one browser tab (the
viewer), replies there (OK, or a note) and answers your questions. Use it for your
work in progress instead of opening files in windows, leaving the user file paths,
or publishing an Artifact.

Show — whenever you want the user to look at an image, video, GIF, audio clip,
3D model (GLB/glTF), PDF, HTML or text file:
- \`agent-dailies show <file>… --title "<what to look at>" [--note "<what changed>"]\`.
  It stores the files and puts them at the top of the viewer; the browser opens
  only when no viewer tab is. Put alternatives in one call so they sit side by side.

Ask — only when the user has to look at something to answer (pick between
images, videos, models or pages you made; sign off on how something looks):
- \`agent-dailies ask "<question>" a.png b.png --option "Neither — redo it" --why "<your recommendation and why>"\`
  Files and --option texts become options A, B, C… (--multi lets them pick several).
- To sign off on one thing, show it above the options with --about and answer in sentences:
  \`agent-dailies ask "Ship this cut?" --about cut.mp4 --option "OK" --option "Fix something (note it)"\`
  (one file alone is not a choice; ask refuses to make it option A).
  When one option is a pattern shown by several files, group them:
  \`ask "Which version?" --pattern "Current" a1.png a2.png --pattern "Proposed" b1.png b2.png\`.
  The user picks per question and presses Send; a note is optional.
- Several such decisions at once (a review of things to look at): write a JSON sheet
  {"title": "…", "questions": [{"text": "…", "why": "…", "options": ["OK as proposed",
  {"label": "Alternative: …", "body": "…"}, "Let's discuss"]}]} — options may carry
  "files", and a question's own "files" show above its options — and run
  \`agent-dailies ask --file sheet.json\`.
- Then start \`agent-dailies wait <post-id>\` in the background (Bash with
  run_in_background, timeout 7200000). It exits with the answers once every question
  is answered (or the user comments), which wakes you. Act on them.

Devlog — a record of how the work changed, for updates and devlog videos later:
- Only merged work goes in: when work has landed on the main branch (the user
  approved the merge and it went through — not at each commit on a branch), look
  back over the session. If it changed something a person using the product would
  notice, record it with
  \`agent-dailies devlog add --title "<what changed>" --before <…> --after <…> --summary -\`
  and on stdin: what changed and why, then "## 工夫" (what was done well or
  cleverly), "## 苦労" (what was hard: what failed first, what was tried, what the
  user had redone, what was learned) and "## 決めたこと" (decisions). The craft and
  the struggles are what devlog videos are made of — write them concretely.
- Before/after are required when the change can be seen or heard: images, or short
  videos when it is in motion, timing, feel or sound. Reuse files you showed (their
  i_… ids) or capture the "before" from the commit before the merge in a temporary
  worktree. Only changes nobody can see go without them. Skip refactors nobody
  notices. The merged commits and their issue are attached; \`devlog add\` refuses
  work that is not on the main branch yet. The Stop hook reminds you once after a
  merge lands.
- To write an update ("what happened since the last one"), take the period from
  the previous update itself (when it ended), then read
  \`agent-dailies devlog summary --since "<that time>"\` (entries, decisions, commits,
  transcripts) and write from it.

Which to use:
- your work in progress to look at, or a choice between things to look at → agent-dailies (show / ask)
- a page others will read, or that should outlive this work (a report, a shared
  document) → an Artifact
- any question answered from words alone (which approach, yes/no, a name, what to
  do next — even a design decision) → ask in the terminal, not in the viewer

Hear back:
- When the user says "this", "the left one", "これ", "左の", "今見てるやつ" about
  something in the viewer, run \`agent-dailies context\` first: the post and file they
  selected (with a path you can read), marks, comments and answers.
- After showing something you want a reaction to, keep \`agent-dailies watch\` running
  in the background (run_in_background, timeout 7200000): it exits when the user
  comments or answers, waking you. One per session. Start it again only while you
  still expect a reply; when your work is done and nothing waits on the user, let it
  end (re-arming it then only wakes you with "no comments").
- \`agent-dailies feedback\` lists their replies and answers.
- Posts are grouped by repository, issue and session; the issue comes from the branch
  name (or --issue). The viewer shows the issue's summary above its posts. If it has
  none and no issue command is configured, describe the issue once:
  \`agent-dailies issue <KEY> --title "…" --description - <<'EOF' … EOF\`.`;
}
