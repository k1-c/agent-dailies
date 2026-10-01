// Getting stored files back out in a usable shape: under their own names (to
// paste a path into an upload dialog, or download), and as video a browser can
// actually play.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Item, Store } from "./store.ts";

/** A file name safe to create and to put in a header, keeping the original as far as possible. */
export function safeName(name: string): string {
	const cleaned = basename(name)
		.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
		.replace(/^\.+/, "_")
		.trim();
	return cleaned || "file";
}

/**
 * A path to the file under its original name: a hard link to the stored copy
 * (no extra space) in named/<item-id>/, made on first use. Upload dialogs and
 * chat apps show this name rather than a hash.
 */
export function namedPath(store: Store, item: Item): string {
	const dir = join(store.home, "named", item.id);
	const path = join(dir, safeName(item.name));
	if (existsSync(path)) return path;
	mkdirSync(dir, { recursive: true });
	const source = store.blobPath(item.sha256, item.ext);
	try {
		linkSync(source, path);
	} catch {
		// Another file system, or links not allowed: a copy will do.
		copyFileSync(source, path);
	}
	return path;
}

/** Content-Disposition for a stored file, with the UTF-8 name and an ASCII fallback. */
export function disposition(kind: "inline" | "attachment", name: string): string {
	const safe = safeName(name);
	const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

// Containers and codecs that current browsers do not play (Ogg Theora was
// dropped from Chrome; QuickTime, AVI, Matroska are hit and miss).
const NEEDS_TRANSCODE = new Set([".ogv", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".mpg", ".mpeg", ".m2ts", ".ts", ".3gp"]);

export function needsTranscode(item: Item): boolean {
	return item.kind === "video" && NEEDS_TRANSCODE.has(item.ext);
}

const running = new Map<string, Promise<string>>();

/**
 * A WebM (VP9 + Opus) copy of a video, made once with ffmpeg and kept in
 * derived/. Resolves to its path; rejects when ffmpeg is missing or fails.
 */
export function playableVideo(store: Store, item: Item, ffmpeg: string = process.env.AGENT_DAILIES_FFMPEG || "ffmpeg"): Promise<string> {
	const target = join(store.home, "derived", `${item.sha256}.webm`);
	if (existsSync(target)) return Promise.resolve(target);
	const pending = running.get(target);
	if (pending) return pending;
	const work = new Promise<string>((resolve, reject) => {
		mkdirSync(join(store.home, "derived"), { recursive: true });
		const temp = `${target}.${process.pid}.part.webm`;
		const child = spawn(
			ffmpeg,
			[
				"-v", "error", "-y",
				"-i", store.blobPath(item.sha256, item.ext),
				"-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-b:v", "0", "-crf", "32",
				"-c:a", "libopus", "-b:a", "128k",
				temp,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let errors = "";
		child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
		child.on("error", (error) => {
			rmSync(temp, { force: true });
			reject(new Error(`ffmpeg is needed to play ${item.ext} files (${error.message})`));
		});
		child.on("close", (code) => {
			if (code === 0 && existsSync(temp)) {
				renameSync(temp, target);
				resolve(target);
			} else {
				rmSync(temp, { force: true });
				reject(new Error(`ffmpeg could not convert ${item.name}: ${errors.trim().split("\n").pop() ?? `exit ${code}`}`));
			}
		});
	}).finally(() => running.delete(target));
	running.set(target, work);
	return work;
}
