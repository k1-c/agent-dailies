// File kinds the viewer knows how to show, by extension.

import { extname } from "node:path";

export type Kind = "image" | "video" | "audio" | "model" | "text" | "html" | "pdf" | "file";

const TYPES: Record<string, [string, Kind]> = {
	".png": ["image/png", "image"],
	".jpg": ["image/jpeg", "image"],
	".jpeg": ["image/jpeg", "image"],
	".gif": ["image/gif", "image"],
	".webp": ["image/webp", "image"],
	".avif": ["image/avif", "image"],
	".svg": ["image/svg+xml", "image"],
	".bmp": ["image/bmp", "image"],
	".mp4": ["video/mp4", "video"],
	".m4v": ["video/mp4", "video"],
	".webm": ["video/webm", "video"],
	".mov": ["video/quicktime", "video"],
	".ogv": ["video/ogg", "video"],
	".mp3": ["audio/mpeg", "audio"],
	".wav": ["audio/wav", "audio"],
	".ogg": ["audio/ogg", "audio"],
	".oga": ["audio/ogg", "audio"],
	".flac": ["audio/flac", "audio"],
	".m4a": ["audio/mp4", "audio"],
	".opus": ["audio/opus", "audio"],
	".glb": ["model/gltf-binary", "model"],
	".gltf": ["model/gltf+json", "model"],
	".txt": ["text/plain; charset=utf-8", "text"],
	".md": ["text/markdown; charset=utf-8", "text"],
	".json": ["application/json; charset=utf-8", "text"],
	".jsonl": ["application/x-ndjson; charset=utf-8", "text"],
	".log": ["text/plain; charset=utf-8", "text"],
	".csv": ["text/csv; charset=utf-8", "text"],
	".yaml": ["text/yaml; charset=utf-8", "text"],
	".yml": ["text/yaml; charset=utf-8", "text"],
	".toml": ["text/plain; charset=utf-8", "text"],
	".html": ["text/html; charset=utf-8", "html"],
	".htm": ["text/html; charset=utf-8", "html"],
	".pdf": ["application/pdf", "pdf"],
};

export function extensionOf(path: string): string {
	return extname(path).toLowerCase();
}

export function mimeOf(path: string): string {
	return TYPES[extensionOf(path)]?.[0] ?? "application/octet-stream";
}

export function kindOf(path: string): Kind {
	return TYPES[extensionOf(path)]?.[1] ?? "file";
}

// What the PreToolUse hook treats as "something to show the user".
export function isViewable(path: string): boolean {
	const kind = kindOf(path);
	return kind === "image" || kind === "video" || kind === "audio" || kind === "model" || kind === "pdf";
}
