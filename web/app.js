// The review page. It keeps one feed of what agents have shown, newest first,
// and listens for new posts so it never needs reopening.
(() => {
	const t = window.t;
	const $ = (id) => document.getElementById(id);
	const feed = $("feed");
	const treeNav = $("tree");
	const modesNav = $("modes");
	const searchBox = $("search");
	const scopeTitle = $("scope-title");
	const issueCard = $("issue-card");
	const openButton = $("open-questions");
	const status = $("status");
	const statusText = $("status-text");
	const fresh = $("fresh");
	const more = $("more");
	const moreButton = $("more-button");
	const empty = $("empty");
	const lightbox = $("lightbox");
	const lightboxStage = $("lightbox-stage");
	const lightboxCaption = $("lightbox-caption");

	const PAGE = 40;
	const posts = new Map(); // id -> post view
	const order = []; // ids, newest first
	// Two sides: what agents show for review (dailies) and the devlog. Each keeps its own scope.
	let mode = load("mode") === "devlog" ? "devlog" : "dailies";
	let tree = [];
	let counts = {};
	let cuts = [];
	let scope = readScope();
	let query = "";
	let currentIssue = null;
	let selection = null; // { post, item }
	let freshCount = 0;
	let hasMore = false;
	let connectedOnce = false;
	let pageVersion = null;
	let modelViewerLoading = null;

	function load(key) {
		try {
			return localStorage.getItem(`agent-dailies:${key}`);
		} catch {
			return null;
		}
	}

	function save(key, value) {
		try {
			localStorage.setItem(`agent-dailies:${key}`, value);
		} catch {
			// Private windows may refuse storage; the filter just resets.
		}
	}

	function el(tag, attrs = {}, children = []) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined || value === null || value === false) continue;
			if (key === "class") node.className = value;
			else if (key === "text") node.textContent = value;
			else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
			else node.setAttribute(key, value === true ? "" : value);
		}
		for (const child of [].concat(children)) if (child) node.append(child);
		return node;
	}

	async function api(path, body) {
		const response = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
		if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
		return response.json();
	}

	const groupIdOf = (post) => (post.issue ? `${post.project}\u0000issue:${post.issue.toUpperCase()}` : `${post.project}\u0000lane:${post.lane}`);
	const blobUrl = (item) => `/blob/${item.sha256}${item.ext}`;
	// Video containers browsers do not reliably play; the viewer converts them (src/files.ts).
	const NEEDS_CONVERSION = new Set([".ogv", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".mpg", ".mpeg", ".m2ts", ".ts", ".3gp"]);
	// The same file under its own name, for saving and dragging out.
	const fileUrl = (item) => `/files/${item.id}/${encodeURIComponent(item.name)}`;

	function ago(at) {
		const seconds = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
		if (seconds < 10) return t.justNow;
		if (seconds < 60) return t.ago(seconds, t.units.s);
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) return t.ago(minutes, t.units.m);
		const hours = Math.round(minutes / 60);
		if (hours < 48) return t.ago(hours, t.units.h);
		return t.ago(Math.round(hours / 24), t.units.d);
	}

	function size(bytes) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	}

	// Which posts the feed shows: everything, what waits for an answer, one issue
	// (or branch), or one agent session in it. Search narrows it further on the server.
	function readScope() {
		try {
			const saved = JSON.parse(load(`scope:${mode}`) || "null");
			if (saved && typeof saved.kind === "string") return saved;
		} catch {
			// A scope saved by an older page; start from everything.
		}
		return { kind: "all" };
	}

	function scopeGroupId(target = scope) {
		if (target.kind !== "group" && target.kind !== "session") return null;
		return target.issue ? `${target.project}\u0000issue:${target.issue}` : `${target.project}\u0000lane:${target.lane}`;
	}

	function inScope(post, target = scope) {
		if ((post.kind === "devlog") !== (mode === "devlog")) return false;
		if (target.kind === "all") return true;
		if (target.kind === "recent") return false; // reloaded instead: it depends on the last cut
		if (target.kind === "open") return openQuestions(post).length > 0;
		if (groupIdOf(post) !== scopeGroupId(target)) return false;
		return target.kind === "group" || post.session === target.session;
	}

	function visible(post) {
		return inScope(post);
	}

	// ---- media ----

	function ensureModelViewer() {
		if (!modelViewerLoading) {
			modelViewerLoading = new Promise((resolve) => {
				const script = el("script", { type: "module", src: "/vendor/model-viewer.js" });
				script.addEventListener("load", resolve);
				script.addEventListener("error", resolve);
				document.head.append(script);
			});
		}
		return modelViewerLoading;
	}

	const players = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				const video = entry.target;
				if (entry.isIntersecting && entry.intersectionRatio > 0.4) video.play().catch(() => undefined);
				else video.pause();
			}
		},
		{ threshold: [0, 0.4, 1] },
	);

	const lazyText = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			lazyText.unobserve(entry.target);
			fillText(entry.target);
		}
	});

	async function fillText(pre) {
		try {
			const response = await fetch(pre.dataset.src, { headers: { range: "bytes=0-262143" } });
			let text = await response.text();
			if (Number(pre.dataset.size) > 262144) text += "\n…";
			pre.textContent = text;
		} catch (error) {
			pre.textContent = String(error);
		}
	}

	function media(item, { large = false } = {}) {
		const src = blobUrl(item);
		switch (item.kind) {
			case "image": {
				const image = el("img", { src, alt: item.name, loading: large ? "eager" : "lazy", decoding: "async" });
				makeDraggable(image, item);
				return image;
			}
			case "video": {
				// Formats the browser cannot play (Ogg Theora in Chrome) go through the
				// viewer, which converts them once with ffmpeg.
				// canPlayType("video/ogg") says "maybe" in Chrome, which cannot decode
				// Theora, so the extension decides, and a failed play retries converted.
				const convert = NEEDS_CONVERSION.has(item.ext) || document.createElement("video").canPlayType(item.mime) === "";
				const video = el("video", { src: convert ? `/play/${item.id}` : src, muted: true, loop: true, playsinline: true, controls: true, preload: "metadata" });
				video.muted = true;
				video.addEventListener("error", () => {
					if (!video.src.includes("/play/")) {
						video.src = `/play/${item.id}`;
						return;
					}
					const box = el("div", { class: "file" }, [
						el("div", { class: "glyph", text: "▶" }),
						el("div", { text: t.cannotPlay }),
						el("a", { href: `${fileUrl(item)}?download`, text: t.download, onclick: (event) => event.stopPropagation() }),
					]);
					video.replaceWith(box);
				});
				if (large) video.autoplay = true;
				else players.observe(video);
				return video;
			}
			case "audio":
				return el("div", { class: "audio" }, [
					el("div", { class: "glyph", text: "♪" }),
					el("audio", { src, controls: true, preload: "none" }),
				]);
			case "model":
				ensureModelViewer();
				return el("model-viewer", {
					src,
					alt: item.name,
					"camera-controls": true,
					"auto-rotate": true,
					"shadow-intensity": "1",
					exposure: "1",
					"interaction-prompt": "none",
					"touch-action": "pan-y",
				});
			case "text": {
				const pre = el("pre", { "data-src": src, "data-size": String(item.size) });
				if (large) fillText(pre);
				else lazyText.observe(pre);
				return pre;
			}
			case "html":
				return el("iframe", { src, sandbox: "allow-scripts", loading: "lazy", title: item.name });
			case "pdf":
				return el("iframe", { src, loading: "lazy", title: item.name });
			default:
				return el("div", { class: "file" }, [
					el("div", { class: "glyph", text: "▤" }),
					el("div", { text: item.name }),
					el("a", { href: `${fileUrl(item)}?download`, download: item.name, text: t.download, onclick: (event) => event.stopPropagation() }),
				]);
		}
	}

	// ---- getting files out: copy, download, drag ----

	const toastBox = el("div", { class: "toast", role: "status", hidden: true });
	document.body.append(toastBox);
	let toastTimer = 0;

	function toast(text, kind = "ok") {
		toastBox.textContent = text;
		toastBox.dataset.kind = kind;
		toastBox.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toastBox.hidden = true), kind === "ok" ? 2600 : 5000);
	}

	// What "copy" puts on the clipboard: the picture for still images, the text
	// for text files, and for everything else (video, audio, models, GIFs, which
	// a web page cannot put on the clipboard as files) a path to the file under its
	// own name, to paste into an upload dialog.
	function copyMode(item) {
		if (item.kind === "image" && item.ext !== ".gif") return "image";
		if (item.kind === "text" && item.size <= 2 * 1024 * 1024) return "text";
		return "path";
	}

	async function toPng(blob) {
		if (blob.type === "image/png") return blob;
		const url = URL.createObjectURL(blob);
		try {
			const image = new Image();
			image.decoding = "async";
			image.src = url;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth || 1024;
			canvas.height = image.naturalHeight || 1024;
			canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
			return await new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("PNG"))), "image/png"));
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	function copyItem(item, forcePath = false) {
		const mode = forcePath ? "path" : copyMode(item);
		// The clipboard write starts right away (inside the click) with a promise
		// for the contents, so the browser does not refuse it for lack of a gesture.
		const contents =
			mode === "image"
				? fetch(blobUrl(item)).then((response) => response.blob()).then(toPng)
				: mode === "text"
					? fetch(blobUrl(item))
							.then((response) => response.text())
							.then((text) => new Blob([text], { type: "text/plain" }))
					: api("/api/path", { item: item.id }).then(({ path }) => new Blob([path], { type: "text/plain" }));
		const type = mode === "image" ? "image/png" : "text/plain";
		navigator.clipboard
			.write([new ClipboardItem({ [type]: contents })])
			.then(() => toast(mode === "image" ? t.copiedImage : mode === "text" ? t.copiedText : t.copiedPath(item.name)))
			.catch((error) => {
				console.error(error);
				toast(t.copyFailed, "error");
			});
	}

	function downloadItem(item) {
		const link = el("a", { href: `${fileUrl(item)}?download`, download: item.name });
		document.body.append(link);
		link.click();
		link.remove();
	}

	async function downloadAll(post) {
		for (const item of post.items) {
			downloadItem(item);
			// Browsers drop downloads started in the same instant.
			await new Promise((resolve) => setTimeout(resolve, 350));
		}
		toast(t.downloadedAll(post.items.length));
	}

	// Dragging a file out: to the desktop or a file manager it arrives as the file
	// (Chrome's DownloadURL); to another page, images arrive as images and anything
	// else as its link.
	function makeDraggable(handle, item) {
		handle.setAttribute("draggable", "true");
		handle.addEventListener("dragstart", (event) => {
			const url = new URL(fileUrl(item), location.href).href;
			event.dataTransfer.setData("DownloadURL", `${item.mime.split(";")[0]}:${item.name}:${url}`);
			event.dataTransfer.setData("text/uri-list", url);
			event.dataTransfer.setData("text/plain", url);
			event.dataTransfer.effectAllowed = "copy";
		});
	}

	function fileActions(post, item, { withFull = false } = {}) {
		const button = (text, title, onclick) =>
			el("button", {
				class: "act icon",
				type: "button",
				title,
				"aria-label": title,
				text,
				onclick: (event) => {
					event.stopPropagation();
					onclick(event);
				},
			});
		return [
			button("⧉", `${t.copyTitle(copyMode(item))} (y)`, (event) => copyItem(item, event.shiftKey)),
			button("⤓", `${t.downloadTitle} (d)`, () => downloadItem(item)),
			withFull
				? button("⤢", `${t.full} (f)`, () => {
						select(post.id, item.id);
						openLightbox(post.id, item.id);
					})
				: null,
		];
	}

	// ---- building posts ----

	function columnsFor(count) {
		if (count <= 1) return 1;
		if (count === 2 || count === 4) return 2;
		return 3;
	}

	function buildTile(post, item, index) {
		const tile = el("article", { class: "tile", "data-item": item.id, "data-verdict": item.verdict || null });
		const stage = el("div", { class: "stage", "data-kind": item.kind }, [media(item)]);
		if (post.items.length > 1) stage.append(el("span", { class: "index", text: String(index + 1) }));
		const name = el("span", { class: "name", title: `${item.source || item.name}\n${t.dragHint}`, text: item.name });
		makeDraggable(name, item);
		if (item.kind !== "image") makeDraggable(stage, item);
		tile.append(stage, el("div", { class: "tile-foot" }, [name, el("span", { class: "size", text: size(item.size) }), ...fileActions(post, item, { withFull: true })]));
		tile.addEventListener("click", () => select(post.id, item.id));
		tile.addEventListener("dblclick", (event) => {
			if (event.target.closest("model-viewer, video, audio, pre, iframe")) return;
			openLightbox(post.id, item.id);
		});
		applyVerdict(tile, item.verdict);
		return tile;
	}

	// Marks from earlier versions (or the API) still show as a badge; the page
	// itself now asks for decisions per question, not per file.
	function applyVerdict(tile, verdict) {
		tile.dataset.verdict = verdict || "";
		tile.querySelector(".badge")?.remove();
		if (verdict) tile.querySelector(".stage").append(el("span", { class: `badge ${verdict}`, text: t[verdict] }));
	}

	function buildComment(post, comment) {
		const item = comment.item ? post.items.find((candidate) => candidate.id === comment.item) : null;
		return el("div", { class: "comment" }, [
			el("span", { class: `who ${comment.by}`, text: comment.by === "agent" ? t.agent : t.human }),
			el("span", {}, [
				item ? el("span", { class: "on", text: `${t.commentOn(item.name)}  ` }) : null,
				document.createTextNode(comment.text),
			]),
		]);
	}

	function composeTarget(post) {
		if (selection && selection.post === post.id && selection.item) {
			const item = post.items.find((candidate) => candidate.id === selection.item);
			if (item && post.items.length > 1) return { item: item.id, label: t.commentOn(item.name) };
		}
		return { item: undefined, label: post.items.length > 1 ? t.commentOnPost : "" };
	}

	// ---- devlog entries ----

	function buildDevlog(post) {
		const parts = [];
		const info = post.devlog || {};
		if (info.summary) parts.push(el("div", { class: "devlog-summary" }, [markdown(info.summary)]));
		const section = (key, label, text) =>
			text ? el("div", { class: `devlog-section ${key}` }, [el("div", { class: "devlog-label", text: label }), markdown(text)]) : null;
		const notes = [section("craft", t.craft, info.craft), section("struggle", t.struggle, info.struggle), section("decided", t.decided, info.decided)].filter(Boolean);
		if (notes.length) parts.push(el("div", { class: "devlog-sections" }, notes));
		const side = (label, ids) => {
			const items = ids.map((id) => post.items.find((item) => item.id === id)).filter(Boolean);
			const grid = el("div", { class: "grid", "data-columns": String(Math.min(items.length, 2) || 1) });
			grid.style.setProperty("--columns", String(Math.min(items.length, 2) || 1));
			items.forEach((item) => grid.append(buildTile(post, item, post.items.indexOf(item))));
			return el("div", { class: "ba-side" }, [el("div", { class: "ba-label", text: label }), grid]);
		};
		if (info.before?.length || info.after?.length) {
			parts.push(
				el("div", { class: `before-after${info.before?.length && info.after?.length ? " pair" : ""}` }, [
					info.before?.length ? side(t.before, info.before) : null,
					info.after?.length ? side(t.after, info.after) : null,
				]),
			);
		}
		if (info.commits?.length) {
			const list = el(
				"ul",
				{ class: "commits" },
				info.commits.map((commit) => el("li", {}, [el("code", { text: commit.sha.slice(0, 8) }), document.createTextNode(` ${commit.subject}`)])),
			);
			parts.push(el("details", { class: "commit-list" }, [el("summary", { text: t.commits(info.commits.length) }), list]));
		}
		return parts;
	}

	// ---- questions ----

	const drafts = new Map(); // `${post}/${question}` -> Set of option ids picked but not sent

	function questionItemIds(post) {
		const ids = new Set([...(post.devlog?.before || []), ...(post.devlog?.after || [])]);
		for (const question of post.questions || []) {
			for (const id of question.items || []) ids.add(id);
			for (const option of question.options) for (const id of option.items || []) ids.add(id);
		}
		return ids;
	}

	// A little Markdown for option texts: paragraphs, "- " lists, **bold**, `code`.
	function markdown(text) {
		const escape = (value) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
		const inline = (value) =>
			escape(value)
				.replace(/`([^`]+)`/g, "<code>$1</code>")
				.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
				.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
				.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
		const blocks = String(text).trim().split(/\n\s*\n/);
		const bullet = /^\s*[-*・]\s+/;
		const html = blocks
			.map((block) => {
				// Runs of bullet lines become lists; other lines stay paragraphs.
				const out = [];
				let run = [];
				let list = false;
				const flush = () => {
					if (!run.length) return;
					out.push(list ? `<ul>${run.map((line) => `<li>${inline(line.replace(bullet, ""))}</li>`).join("")}</ul>` : `<p>${run.map(inline).join("<br>")}</p>`);
					run = [];
				};
				for (const line of block.split("\n")) {
					const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
					if (heading) {
						flush();
						out.push(`<h4>${inline(heading[1])}</h4>`);
						continue;
					}
					const isBullet = bullet.test(line);
					if (run.length && isBullet !== list) flush();
					list = isBullet;
					run.push(line);
				}
				flush();
				return out.join("");
			})
			.join("");
		const box = el("div", { class: "md" });
		box.innerHTML = html;
		return box;
	}

	function picked(post, question) {
		const key = `${post.id}/${question.id}`;
		if (!drafts.has(key)) drafts.set(key, new Set(post.answers?.[question.id]?.choices || []));
		return drafts.get(key);
	}

	function buildQuestion(post, question) {
		const block = el("section", { class: "question", "data-question": question.id });
		renderQuestion(block, post, question);
		return block;
	}

	function renderQuestion(block, post, question) {
		const answer = post.answers?.[question.id];
		const chosen = picked(post, question);
		// A post that asks one thing is already titled with the question.
		const titled = post.questions.length === 1 && post.title === question.text;
		const head = el("div", { class: "q-head" }, [
			el("span", { class: `q-state ${answer ? "done" : "open"}`, text: answer ? t.answered : t.waiting }),
			titled ? null : el("h3", { class: "q-text", text: question.text }),
			question.multi ? el("span", { class: "q-hint", text: t.multi }) : null,
		]);
		const parts = [head];
		if (question.why) parts.push(el("div", { class: "q-why" }, [markdown(question.why)]));
		if ((question.items || []).length) {
			const grid = el("div", { class: "grid context", "data-columns": String(columnsFor(question.items.length)) });
			grid.style.setProperty("--columns", String(columnsFor(question.items.length)));
			for (const id of question.items) {
				const item = post.items.find((candidate) => candidate.id === id);
				if (item) grid.append(buildTile(post, item, post.items.indexOf(item)));
			}
			parts.push(grid);
		}
		const withMedia = question.options.some((option) => (option.items || []).length);
		const options = el("div", { class: `options${withMedia ? " media" : ""}` });
		options.style.setProperty("--columns", String(withMedia ? columnsFor(question.options.length) : 1));
		question.options.forEach((option, index) => {
			const isChosen = chosen.has(option.id);
			const card = el("div", {
				class: `option${isChosen ? " chosen" : ""}${answer?.choices.includes(option.id) ? " sent" : ""}`,
				role: question.multi ? "checkbox" : "radio",
				tabindex: "0",
				"aria-checked": String(isChosen),
				"data-option": option.id,
			});
			const items = (option.items || []).map((id) => post.items.find((candidate) => candidate.id === id)).filter(Boolean);
			card.append(
				el("div", { class: "o-head" }, [
					el("span", { class: "o-key", text: option.key }),
					el("span", { class: "o-label", text: option.label || items.map((item) => item.name).join(", ") }),
					...(items.length === 1 ? fileActions(post, items[0]) : []),
					el("span", { class: "o-num", text: index < 9 ? String(index + 1) : "" }),
				]),
			);
			if (option.body) card.append(el("div", { class: "o-body" }, [markdown(option.body)]));
			if (items.length) {
				const files = el("div", { class: "o-files", "data-count": String(Math.min(items.length, 3)) });
				for (const item of items) {
					const stage = el("div", { class: "stage", "data-kind": item.kind, "data-item": item.id }, [media(item)]);
					stage.addEventListener("dblclick", (event) => {
						if (event.target.closest("model-viewer, video, audio, pre, iframe")) return;
						openLightbox(post.id, item.id);
					});
					const label = el("div", { class: "o-file" }, [stage]);
					if (items.length > 1) {
						const caption = el("div", { class: "o-file-name" }, [el("span", { class: "name", text: item.name }), ...fileActions(post, item)]);
						makeDraggable(caption.querySelector(".name"), item);
						label.append(caption);
					}
					files.append(label);
				}
				card.append(files);
			}
			const toggle = () => {
				choose(post, question, option.id);
				if (items[0]) select(post.id, items[0].id);
			};
			card.addEventListener("click", (event) => {
				if (event.target.closest("video, audio, model-viewer, a")) return;
				toggle();
			});
			card.addEventListener("keydown", (event) => {
				if (event.key === " " || event.key === "Enter") {
					event.preventDefault();
					toggle();
				}
			});
			options.append(card);
		});
		parts.push(options);

		const note = el("input", {
			type: "text",
			class: "q-note",
			placeholder: t.answerNote,
			"aria-label": t.answerNote,
		});
		note.value = block.querySelector(".q-note")?.value || "";
		const changed = answer && (!sameSet(chosen, new Set(answer.choices)) || (note.value.trim() && note.value.trim() !== (answer.text || "")));
		const send = el("button", {
			class: "send",
			type: "button",
			text: answer ? t.resend : t.send,
			disabled: !chosen.size && !note.value.trim() ? true : answer && !changed ? true : undefined,
			onclick: () => sendAnswer(post, question, note.value),
		});
		note.addEventListener("input", () => {
			const empty = !chosen.size && !note.value.trim();
			send.disabled = empty || (answer && sameSet(chosen, new Set(answer.choices)) && note.value.trim() === (answer.text || ""));
		});
		note.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing && !send.disabled) {
				event.preventDefault();
				sendAnswer(post, question, note.value);
			}
		});
		const row = el("div", { class: "answer-row" }, [note, send]);
		parts.push(row);
		if (answer) {
			parts.push(
				el("div", { class: "answered-line" }, [
					el("span", { class: "who", text: `${answer.by === "agent" ? t.agentAnswer : t.yourAnswer}: ` }),
					document.createTextNode(answerSummary(question, answer)),
					el("span", { class: "time", text: `  ${ago(answer.at)}` }),
				]),
			);
		}
		block.replaceChildren(...parts);
	}

	// The first question of a post whose picks differ from what was sent.
	function pendingQuestion(post) {
		return (post.questions || []).find((question) => {
			const chosen = picked(post, question);
			const answer = post.answers?.[question.id];
			return chosen.size && (!answer || !sameSet(chosen, new Set(answer.choices)));
		});
	}

	function sameSet(a, b) {
		return a.size === b.size && [...a].every((value) => b.has(value));
	}

	function answerSummary(question, answer) {
		const chosen = answer.choices
			.map((id) => question.options.find((option) => option.id === id))
			.filter(Boolean)
			.map((option) => (option.label ? `${option.key}（${option.label}）` : option.key));
		return [chosen.join(" + "), answer.text ? `「${answer.text}」` : ""].filter(Boolean).join(" ");
	}

	function choose(post, question, optionId) {
		const chosen = picked(post, question);
		if (question.multi) {
			if (chosen.has(optionId)) chosen.delete(optionId);
			else chosen.add(optionId);
		} else {
			const only = chosen.has(optionId) && chosen.size === 1;
			chosen.clear();
			if (!only) chosen.add(optionId);
		}
		refreshQuestion(post, question);
	}

	function refreshQuestion(post, question) {
		const block = document.getElementById(post.id)?.querySelector(`.question[data-question="${question.id}"]`);
		if (block) renderQuestion(block, post, question);
	}

	async function sendAnswer(post, question, text) {
		const choices = [...picked(post, question)];
		try {
			const answer = await api("/api/answers", { post: post.id, question: question.id, choices, text: text.trim() || undefined, by: "human" });
			applyAnswer(answer);
			const block = document.getElementById(post.id)?.querySelector(`.question[data-question="${question.id}"]`);
			const note = block?.querySelector(".q-note");
			if (note) note.value = "";
			if (block) renderQuestion(block, post, question);
		} catch (error) {
			console.error(error);
		}
	}

	function applyAnswer(answer) {
		const post = posts.get(answer.post);
		if (!post) return;
		const previous = post.answers?.[answer.question];
		if (previous && previous.at >= answer.at) return;
		post.answers = { ...(post.answers || {}), [answer.question]: answer };
		const question = post.questions?.find((candidate) => candidate.id === answer.question);
		if (!question) return;
		drafts.set(`${post.id}/${question.id}`, new Set(answer.choices));
		refreshQuestion(post, question);
		const node = document.getElementById(post.id);
		if (node) updatePostState(node, post);
		renderOpen();
	}

	function openQuestions(post) {
		return (post.questions || []).filter((question) => !post.answers?.[question.id]);
	}

	function updatePostState(node, post) {
		const chip = node.querySelector(".chip.state");
		if (!chip) return;
		const open = openQuestions(post).length;
		chip.textContent = open ? t.waitingCount(open, post.questions.length) : t.answered;
		chip.classList.toggle("open", open > 0);
		node.classList.toggle("asking", open > 0);
	}

	function renderOpen() {
		refreshTree();
	}

	function buildPostElement(post) {
		const node = el("section", { class: "post", id: post.id, "data-post": post.id });
		const title = post.title || post.items.map((item) => item.name).join(" · ");
		const meta = el("div", { class: "meta" }, [
			el("span", { class: "chip", title: `${post.project} › ${post.lane}`, text: post.lane }),
			post.issue ? el("span", { class: "chip issue", text: post.issue }) : null,
			...(post.tags || []).map((tag) => el("span", { class: "chip tag", text: tag })),
			post.items.length > 1 ? el("span", { class: "time", text: t.files(post.items.length) }) : null,
			post.items.length > 1
				? el("button", {
						class: "act all",
						type: "button",
						text: `⤓ ${t.downloadAll}`,
						title: t.downloadAllTitle,
						onclick: (event) => {
							event.stopPropagation();
							downloadAll(post);
						},
					})
				: null,
			el("time", { class: "time", datetime: post.at, title: new Date(post.at).toLocaleString(), text: ago(post.at) }),
		]);
		if (post.questions?.length) meta.prepend(el("span", { class: "chip state" }));
		if (post.kind === "devlog") meta.prepend(el("span", { class: "chip devlog", text: t.devlog }));
		node.append(el("header", { class: "post-head" }, [el("h2", { class: "post-title", text: title }), meta]));
		if (post.note) node.append(el("p", { class: "note", text: post.note }));
		for (const question of post.questions || []) node.append(buildQuestion(post, question));
		if (post.kind === "devlog") node.append(...buildDevlog(post));
		const inQuestions = questionItemIds(post);
		const loose = post.items.filter((item) => !inQuestions.has(item.id));
		if (loose.length) {
			const grid = el("div", { class: "grid", "data-columns": String(columnsFor(loose.length)) });
			grid.style.setProperty("--columns", String(columnsFor(loose.length)));
			loose.forEach((item) => grid.append(buildTile(post, item, post.items.indexOf(item))));
			node.append(grid);
		}
		updatePostState(node, post);

		const list = el("div", { class: "comment-list" });
		for (const comment of post.comments || []) list.append(buildComment(post, comment));
		const parts = [list];
		// A post that asks questions is answered per question; others get a reply row:
		// "OK" with nothing written, "Send" once there is a note.
		if (!post.questions?.length) {
			const target = el("span", { class: "target" });
			const input = el("input", { type: "text", class: "reply-note", placeholder: t.replyPlaceholder, "aria-label": t.replyPlaceholder });
			const send = el("button", { class: "send reply", type: "button", text: t.ok });
			const sync = () => (send.textContent = input.value.trim() ? t.send : t.ok);
			const reply = async () => {
				const text = input.value.trim() || "OK";
				input.value = "";
				sync();
				const { item } = composeTarget(post);
				try {
					await api("/api/comments", { post: post.id, item, text, by: "human" });
					toast(t.sent);
				} catch (error) {
					input.value = text === "OK" ? "" : text;
					sync();
					console.error(error);
				}
			};
			input.addEventListener("input", sync);
			input.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" || event.isComposing || !input.value.trim()) return;
				event.preventDefault();
				reply();
			});
			send.addEventListener("click", (event) => {
				event.stopPropagation();
				reply();
			});
			parts.push(el("div", { class: "compose" }, [target, input, send]));
		}
		const comments = el("div", { class: "comments" }, parts);
		// Nothing to show yet and no reply row (a question post): no empty strip.
		comments.hidden = !list.childElementCount && parts.length === 1;
		node.append(comments);
		node.addEventListener("click", (event) => {
			if (!event.target.closest(".tile") && !event.target.closest(".compose")) select(post.id, selection?.post === post.id ? selection.item : undefined);
		});
		updateCompose(node, post);
		node.hidden = !visible(post);
		return node;
	}

	function updateCompose(node, post) {
		const target = node.querySelector(".compose .target");
		if (target) target.textContent = composeTarget(post).label;
	}

	// "OK" from the keyboard for the post in hand (one that asks nothing).
	function replyOk(post) {
		if (!post || post.questions?.length) return;
		api("/api/comments", { post: post.id, text: "OK", by: "human" })
			.then(() => toast(t.sent))
			.catch((error) => console.error(error));
	}

	// ---- state changes ----

	function addPost(post, { arriving = false, append = false } = {}) {
		if (posts.has(post.id)) return;
		posts.set(post.id, post);
		const node = buildPostElement(post);
		if (append) {
			order.push(post.id);
			feed.append(node);
		} else {
			order.unshift(post.id);
			feed.prepend(node);
		}
		if (arriving) {
			if (window.scrollY < 120 && document.visibilityState === "visible") {
				node.classList.add("arrived");
			} else {
				node.classList.add("arrived");
				freshCount++;
				renderFresh();
			}
		}
		renderEmpty();
		renderOpen();
	}

	function setVerdict(itemId, verdict) {
		for (const post of posts.values()) {
			const item = post.items.find((candidate) => candidate.id === itemId);
			if (!item) continue;
			item.verdict = verdict;
			const tile = document.querySelector(`.tile[data-item="${itemId}"]`);
			if (tile) applyVerdict(tile, verdict);
		}
	}

	function addComment(comment) {
		const post = posts.get(comment.post);
		if (!post) return;
		if ((post.comments || []).some((existing) => existing.id === comment.id)) return;
		post.comments = [...(post.comments || []), comment];
		const node = document.getElementById(post.id);
		node?.querySelector(".comment-list").append(buildComment(post, comment));
		const box = node?.querySelector(".comments");
		if (box) box.hidden = false;
	}

	function applySelection(next) {
		selection = next;
		document.querySelectorAll(".tile.selected").forEach((tile) => tile.classList.remove("selected"));
		document.querySelectorAll(".post.current").forEach((node) => node.classList.remove("current"));
		if (selection) {
			const node = document.getElementById(selection.post);
			node?.classList.add("current");
			if (selection.item) node?.querySelector(`.tile[data-item="${selection.item}"]`)?.classList.add("selected");
		}
		for (const [id, post] of posts) {
			const node = document.getElementById(id);
			if (node) updateCompose(node, post);
		}
	}

	function select(postId, itemId) {
		if (selection && selection.post === postId && selection.item === itemId) return;
		applySelection(postId ? { post: postId, item: itemId } : null);
		api("/api/select", { post: postId, item: itemId }).catch((error) => console.error(error));
	}

	// ---- chrome ----

	// ---- sidebar ----

	let treeTimer = 0;
	const expanded = new Set(JSON.parse(load("expanded") || "[]"));
	const seen = JSON.parse(load("seen") || "{}");

	function refreshTree() {
		clearTimeout(treeTimer);
		treeTimer = setTimeout(async () => {
			try {
				const response = await api(`/api/tree?mode=${mode}`);
				tree = response.tree;
				counts = response.counts || {};
				renderTree();
				renderScope();
			} catch (error) {
				console.error(error);
			}
		}, 250);
	}

	function findGroup(id) {
		for (const project of tree) for (const group of project.groups) if (group.id === id) return group;
		return null;
	}

	// A group is unread when something arrived since it was last opened. Groups
	// seen for the first time count as read, so a fresh page is not all dots.
	function isUnread(group) {
		if (!(group.id in seen)) {
			seen[group.id] = group.last;
			save("seen", JSON.stringify(seen));
			return false;
		}
		return group.last > seen[group.id];
	}

	function markSeen() {
		const group = findGroup(scopeGroupId());
		if (!group) return;
		seen[group.id] = group.last;
		save("seen", JSON.stringify(seen));
	}

	function sessionLabel(session) {
		const date = new Date(session.first);
		const time = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		return { time, title: session.title };
	}

	function treeMatches(text) {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		return words.every((word) => text.toLowerCase().includes(word));
	}

	function renderTree() {
		const rows = [];
		const openTotal = tree.reduce((sum, project) => sum + project.groups.reduce((n, group) => n + group.open, 0), 0);
		const smart = (kind, icon, label, count) =>
			el(
				"button",
				{
					class: `side-item smart${scope.kind === kind ? " active" : ""}`,
					type: "button",
					"data-scope": kind,
					onclick: () => setScope({ kind }),
				},
				[
					el("span", { class: "side-icon", text: icon }),
					el("span", { class: "side-label", text: label }),
					count ? el("span", { class: `side-count${kind === "open" ? " open" : ""}`, text: String(count) }) : null,
				],
			);
		if (mode === "devlog") rows.push(smart("recent", "✎", t.sinceCut, 0), smart("all", "◷", t.allEntries, counts.devlog || 0));
		else rows.push(smart("open", "★", t.waiting, openTotal), smart("all", "◷", t.all, 0));
		for (const project of tree) {
			const groups = project.groups.filter(
				(group) =>
					!query ||
					treeMatches(`${group.issue ?? ""} ${group.title} ${group.lane}`) ||
					group.sessions.some((session) => treeMatches(session.title)),
			);
			if (!groups.length) continue;
			rows.push(el("div", { class: "side-project", text: project.project }));
			for (const group of groups) {
				const active = scope.kind === "group" && scopeGroupId() === group.id;
				const inside = scope.kind === "session" && scopeGroupId() === group.id;
				const open = expanded.has(group.id) || inside || active || Boolean(query);
				const caret = el("span", {
					class: `side-caret${group.sessions.length ? "" : " empty"}`,
					text: group.sessions.length ? (open ? "▾" : "▸") : "",
					onclick: (event) => {
						event.stopPropagation();
						if (expanded.has(group.id)) expanded.delete(group.id);
						else expanded.add(group.id);
						save("expanded", JSON.stringify([...expanded]));
						renderTree();
					},
				});
				rows.push(
					el(
						"button",
						{
							class: `side-item group${active ? " active" : ""}${inside ? " within" : ""}`,
							type: "button",
							"data-group": group.id,
							title: `${group.issue ? `${group.issue} ` : ""}${group.title}\n${group.project} › ${group.lane}`,
							onclick: () => setScope({ kind: "group", project: group.project, issue: group.issue, lane: group.issue ? undefined : group.lane }),
						},
						[
							caret,
							group.issue ? el("span", { class: "side-key", text: group.issue }) : null,
							el("span", { class: "side-label", text: group.issue && group.title === group.issue ? "" : group.title }),
							isUnread(group) && !active && !inside ? el("span", { class: "unread" }) : null,
							group.open ? el("span", { class: "side-count open", text: String(group.open) }) : null,
							el("span", { class: "side-count", text: String(group.count) }),
						],
					),
				);
				if (!open) continue;
				for (const session of mode === "devlog" ? [] : group.sessions) {
					if (query && !treeMatches(`${group.issue ?? ""} ${group.title} ${session.title}`)) continue;
					const label = sessionLabel(session);
					const current = scope.kind === "session" && scope.session === session.session && inside;
					rows.push(
						el(
							"button",
							{
								class: `side-item session${current ? " active" : ""}`,
								type: "button",
								title: `${label.time} ${session.title}\n${session.session}`,
								onclick: () =>
									setScope({
										kind: "session",
										project: group.project,
										issue: group.issue,
										lane: group.issue ? undefined : group.lane,
										session: session.session,
									}),
							},
							[
								el("span", { class: "side-time", text: label.time }),
								el("span", { class: "side-label", text: label.title }),
								session.open ? el("span", { class: "side-count open", text: String(session.open) }) : null,
								el("span", { class: "side-count", text: String(session.count) }),
							],
						),
					);
				}
			}
		}
		treeNav.replaceChildren(...rows);
		const openCount = openTotal;
		openButton.hidden = openCount === 0 || scope.kind === "open";
		openButton.textContent = t.openQuestions(openCount);
	}

	function renderScope() {
		const group = findGroup(scopeGroupId());
		let label = t.all;
		if (scope.kind === "open") label = t.waiting;
		else if (scope.kind === "recent") label = t.sinceCut;
		else if (scope.kind === "all" && mode === "devlog") label = t.allEntries;
		else if (group) {
			label = `${group.issue ? `${group.issue} ` : ""}${group.issue && group.title === group.issue ? "" : group.title}`;
			if (scope.kind === "session") {
				const session = group.sessions.find((candidate) => candidate.session === scope.session);
				if (session) label += ` › ${sessionLabel(session).time}`;
			}
		}
		scopeTitle.textContent = label;
		document.title = `${freshCount ? `(${freshCount}) ` : ""}${scope.kind === "all" ? "" : `${label} — `}agent dailies`;
		renderIssueCard(group);
	}

	function trackerName(url) {
		try {
			const host = new URL(url).hostname;
			if (host.endsWith("linear.app")) return "Linear";
			if (host.endsWith("github.com")) return "GitHub";
			if (host.endsWith("atlassian.net")) return "Jira";
			return host;
		} catch {
			return "";
		}
	}

	function renderIssueCard(group) {
		const key = scope.issue;
		if (!key || (scope.kind !== "group" && scope.kind !== "session")) {
			issueCard.hidden = true;
			issueCard.replaceChildren();
			return;
		}
		const issue = currentIssue && currentIssue.key === key ? currentIssue : null;
		const title = issue?.title ?? group?.title ?? key;
		const parts = [
			el("div", { class: "issue-head" }, [
				el("span", { class: "chip issue", text: key }),
				issue?.status ? el("span", { class: "chip status", text: issue.status }) : null,
				...(issue?.details ?? []).map((detail) => el("span", { class: "chip", text: detail })),
				issue?.url
					? el("a", { class: "issue-link", href: issue.url, target: "_blank", rel: "noopener noreferrer", text: t.openIn(trackerName(issue.url)) })
					: null,
			]),
			el("h1", { class: "issue-title", text: title === key ? "" : title }),
		];
		if (issue?.description) {
			const body = el("div", { class: "issue-body collapsed" }, [markdown(issue.description)]);
			const toggle = el("button", {
				class: "issue-more",
				type: "button",
				text: t.readMore,
				onclick: () => {
					const collapsed = body.classList.toggle("collapsed");
					toggle.textContent = collapsed ? t.readMore : t.readLess;
				},
			});
			parts.push(body, toggle);
			requestAnimationFrame(() => {
				if (body.scrollHeight <= body.clientHeight + 4) toggle.hidden = true;
			});
		} else if (!issue) {
			parts.push(el("p", { class: "issue-empty", text: t.noIssueYet(key) }));
		}
		issueCard.replaceChildren(...parts);
		issueCard.hidden = false;
	}

	async function setScope(next) {
		scope = next;
		save(`scope:${mode}`, JSON.stringify(scope));
		freshCount = 0;
		renderFresh();
		renderTree();
		renderScope();
		document.body.classList.remove("side-open");
		window.scrollTo({ top: 0 });
		await loadState({ reset: true });
	}

	function scopeParams(target = scope) {
		const params = new URLSearchParams({ limit: String(PAGE), mode });
		if (target.kind === "open") params.set("open", "1");
		if (target.kind === "recent") params.set("since", "lastcut");
		if (target.kind === "group" || target.kind === "session") {
			params.set("project", target.project);
			if (target.issue) params.set("issue", target.issue);
			else if (target.lane) params.set("lane", target.lane);
		}
		if (target.kind === "session") params.set("session", target.session);
		if (query) params.set("q", query);
		return params;
	}

	async function setMode(next) {
		if (next === mode) return;
		mode = next;
		save("mode", mode);
		scope = readScope();
		renderModes();
		freshCount = 0;
		renderFresh();
		window.scrollTo({ top: 0 });
		await loadState({ reset: true });
	}

	function renderModes() {
		document.body.dataset.mode = mode;
		for (const button of modesNav.querySelectorAll("button")) {
			const active = button.dataset.mode === mode;
			button.setAttribute("aria-pressed", String(active));
			const badge = button.querySelector(".mode-count");
			const value = button.dataset.mode === "devlog" ? counts.devlog : counts.open;
			badge.textContent = value ? String(value) : "";
			badge.classList.toggle("open", button.dataset.mode === "dailies" && Boolean(value));
		}
	}

	// The sidebar's rows in order, for [ and ] to step through.
	function stepScope(delta) {
		const rows = [...treeNav.querySelectorAll(".side-item")];
		if (!rows.length) return;
		const at = rows.findIndex((row) => row.classList.contains("active"));
		const next = rows[Math.min(rows.length - 1, Math.max(0, (at === -1 ? 0 : at) + delta))];
		next?.click();
		next?.scrollIntoView({ block: "nearest" });
	}

	function renderFresh() {
		fresh.hidden = freshCount === 0;
		fresh.textContent = t.fresh(freshCount);
		document.title = document.title.replace(/^\(\d+\) /, "");
		if (freshCount) document.title = `(${freshCount}) ${document.title}`;
	}

	function clearFresh() {
		if (!freshCount) return;
		freshCount = 0;
		renderFresh();
	}

	function renderEmpty() {
		const any = order.some((id) => visible(posts.get(id)));
		empty.hidden = any;
		more.hidden = !hasMore || !any;
	}

	function renderStatus(state) {
		status.dataset.state = state;
		statusText.textContent = state === "live" ? t.connected : state === "down" ? t.disconnected : t.connecting;
	}

	function renderKeys() {
		$("keys").replaceChildren(
			...t.keys.map(([key, label]) => el("span", {}, [el("kbd", { text: key }), document.createTextNode(label)])),
			el("span", { class: "hint", text: t.selectedHint }),
		);
	}

	function renderEmptyState() {
		empty.replaceChildren(
			el("img", { src: "/icon.svg", alt: "", width: "44", height: "44" }),
			el("h1", { text: t.emptyTitle }),
			el("p", { text: t.emptyBody }),
			el("code", { text: 'agent-dailies show render.png --title "What to look at"' }),
		);
	}

	// ---- full screen ----

	let lightboxAt = null; // { post, index }

	function openLightbox(postId, itemId) {
		const post = posts.get(postId);
		if (!post) return;
		const index = Math.max(0, post.items.findIndex((item) => item.id === itemId));
		lightboxAt = { post: postId, index };
		renderLightbox();
		lightbox.hidden = false;
	}

	function renderLightbox() {
		const post = posts.get(lightboxAt.post);
		const item = post.items[lightboxAt.index];
		lightboxStage.replaceChildren(media(item, { large: true }));
		const position = post.items.length > 1 ? `${lightboxAt.index + 1} / ${post.items.length} · ` : "";
		lightboxCaption.replaceChildren(
			el("span", { text: `${position}${item.name}${post.title ? ` — ${post.title}` : ""}` }),
			...fileActions(post, item),
		);
		select(post.id, item.id);
	}

	function closeLightbox() {
		lightbox.hidden = true;
		lightboxStage.replaceChildren();
		lightboxAt = null;
	}

	function stepLightbox(delta) {
		const post = posts.get(lightboxAt.post);
		lightboxAt.index = (lightboxAt.index + delta + post.items.length) % post.items.length;
		renderLightbox();
	}

	$("lightbox-close").addEventListener("click", closeLightbox);
	lightbox.addEventListener("click", (event) => {
		if (event.target === lightbox || event.target === lightboxStage) closeLightbox();
	});
	// Double-click closes it again, the way it was opened — except on things that
	// use double-clicks themselves (video, 3D models, text, pages).
	lightbox.addEventListener("dblclick", (event) => {
		if (event.target.closest("model-viewer, video, audio, pre, iframe, button, a")) return;
		closeLightbox();
	});

	// ---- keyboard ----

	function selectedItem() {
		const post = selection && posts.get(selection.post);
		return post?.items.find((item) => item.id === selection.item);
	}

	function visibleIds() {
		return order.filter((id) => visible(posts.get(id)));
	}

	function moveSelection(postDelta, itemDelta) {
		const ids = visibleIds();
		if (!ids.length) return;
		let postIndex = selection ? ids.indexOf(selection.post) : -1;
		let itemIndex = 0;
		if (postIndex === -1) {
			postIndex = 0;
		} else if (postDelta) {
			postIndex = Math.min(ids.length - 1, Math.max(0, postIndex + postDelta));
		} else {
			const post = posts.get(ids[postIndex]);
			const current = post.items.findIndex((item) => item.id === selection.item);
			itemIndex = Math.min(post.items.length - 1, Math.max(0, (current === -1 ? 0 : current) + itemDelta));
		}
		const post = posts.get(ids[postIndex]);
		select(post.id, post.items[itemIndex].id);
		const node = document.getElementById(post.id);
		const target = itemDelta ? node.querySelector(`.tile[data-item="${post.items[itemIndex].id}"]`) : node;
		target?.scrollIntoView({ behavior: "smooth", block: postDelta ? "start" : "nearest" });
	}

	document.addEventListener("keydown", (event) => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const typing = event.target.closest("input, textarea, [contenteditable]");
		if (!lightbox.hidden) {
			if (event.key === "Escape") closeLightbox();
			else if (event.key === "ArrowRight" || event.key === "l") stepLightbox(1);
			else if (event.key === "ArrowLeft" || event.key === "h") stepLightbox(-1);
			else if ((event.key === "y" || event.key === "Y") && selectedItem()) copyItem(selectedItem(), event.key === "Y");
			else if (event.key === "d" && selectedItem()) downloadItem(selectedItem());
			else return;
			event.preventDefault();
			return;
		}
		if (typing) {
			if (event.key === "Escape") event.target.blur();
			return;
		}
		switch (event.key) {
			case "j":
				moveSelection(1, 0);
				break;
			case "k":
				moveSelection(-1, 0);
				break;
			case "l":
				moveSelection(0, 1);
				break;
			case "h":
				moveSelection(0, -1);
				break;
			case "o":
				replyOk(selection && posts.get(selection.post));
				break;
			case "y":
			case "Y": {
				const item = selectedItem();
				if (item) copyItem(item, event.key === "Y");
				break;
			}
			case "d": {
				const item = selectedItem();
				if (item) downloadItem(item);
				break;
			}
			case "c":
				if (selection) document.getElementById(selection.post)?.querySelector(".compose input, .question .q-note")?.focus();
				break;
			case "f":
			case "Enter": {
				const post = selection && posts.get(selection.post);
				const question = post && pendingQuestion(post);
				if (event.key === "Enter" && question) {
					const note = document.getElementById(post.id)?.querySelector(`.question[data-question="${question.id}"] .q-note`);
					sendAnswer(post, question, note?.value || "");
				} else if (selection?.item) openLightbox(selection.post, selection.item);
				break;
			}
			case "Escape":
				select(null);
				break;
			case "g":
				window.scrollTo({ top: 0, behavior: "smooth" });
				break;
			case "m":
				setMode(mode === "devlog" ? "dailies" : "devlog");
				break;
			case "[":
				stepScope(-1);
				break;
			case "]":
				stepScope(1);
				break;
			case "/":
				searchBox.focus();
				break;
			case "1":
			case "2":
			case "3":
			case "4":
			case "5":
			case "6":
			case "7":
			case "8":
			case "9": {
				const post = selection && posts.get(selection.post);
				const question = post && (openQuestions(post)[0] || post.questions?.[0]);
				const option = question?.options[Number(event.key) - 1];
				if (!option) return;
				choose(post, question, option.id);
				if (option.items?.[0]) select(post.id, option.items[0]);
				break;
			}
			default:
				return;
		}
		event.preventDefault();
	});

	// ---- loading and live updates ----

	let loading = 0;

	async function loadState({ reset = false } = {}) {
		const ticket = ++loading;
		const state = await api(`/api/state?${scopeParams()}`);
		if (ticket !== loading) return; // a newer scope was chosen meanwhile
		if (reset) {
			posts.clear();
			order.length = 0;
			feed.replaceChildren();
		}
		tree = state.tree;
		counts = state.counts || {};
		cuts = state.cuts || [];
		renderModes();
		currentIssue = state.issue;
		if ((scope.kind === "group" || scope.kind === "session") && !findGroup(scopeGroupId())) {
			scope = { kind: "all" };
			return loadState({ reset: true });
		}
		hasMore = state.posts.length >= PAGE;
		for (const post of state.posts) addPost(post, { append: true });
		if (mode === "devlog") placeSeparators();
		markSeen();
		renderTree();
		renderScope();
		applySelection(state.selection && posts.has(state.selection.post) ? state.selection : null);
		renderEmpty();
	}

	async function loadOlder() {
		const oldest = order[order.length - 1];
		if (!oldest) return;
		const params = scopeParams();
		params.set("before", oldest);
		const state = await api(`/api/state?${params}`);
		hasMore = state.posts.length >= PAGE;
		for (const post of state.posts) addPost(post, { append: true });
		if (mode === "devlog") placeSeparators();
		applySelection(selection);
		renderEmpty();
	}

	// The devlog reads as a timeline: a heading for each day, and a line where a
	// summary went out (a cut).
	function placeSeparators() {
		feed.querySelectorAll(".day-sep, .cut-sep").forEach((node) => node.remove());
		const nodes = [...feed.querySelectorAll(".post")];
		const pending = [...cuts].sort((a, b) => (a.at < b.at ? 1 : -1));
		let day = "";
		for (const node of nodes) {
			const post = posts.get(node.id);
			if (!post) continue;
			while (pending.length && pending[0].at > post.at) {
				const cut = pending.shift();
				node.before(el("div", { class: "cut-sep" }, [el("span", { text: `${t.cutLabel}${cut.name ? `: ${cut.name}` : ""} · ${new Date(cut.at).toLocaleString()}` })]));
			}
			const date = new Date(post.at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", weekday: "short" });
			if (date !== day) {
				day = date;
				node.before(el("div", { class: "day-sep", text: date }));
			}
		}
	}

	function connect() {
		renderStatus("connecting");
		const source = new EventSource("/api/events");
		source.addEventListener("hello", (event) => {
			// A newer viewer took over (after an upgrade): load its page.
			const { version } = JSON.parse(event.data || "{}");
			if (pageVersion && version && version !== pageVersion) return location.reload();
			pageVersion = version;
			renderStatus("live");
			// After a reconnect, catch up on whatever arrived while we were away.
			if (connectedOnce) loadState({ reset: true }).catch((error) => console.error(error));
			connectedOnce = true;
		});
		source.addEventListener("post", (event) => {
			const post = JSON.parse(event.data);
			if (mode === "devlog" && post.kind === "devlog") {
				loadState({ reset: true }).catch((error) => console.error(error));
				return;
			}
			if (inScope(post) && !query) {
				addPost(post, { arriving: true });
				markSeen();
			}
			refreshTree();
		});
		source.addEventListener("cut", () => {
			if (mode === "devlog") loadState({ reset: true }).catch((error) => console.error(error));
		});
		source.addEventListener("issue", (event) => {
			const issue = JSON.parse(event.data);
			if (scope.issue && issue.key === scope.issue) currentIssue = issue;
			refreshTree();
		});
		source.addEventListener("verdict", (event) => {
			const data = JSON.parse(event.data);
			setVerdict(data.item, data.verdict);
		});
		source.addEventListener("comment", (event) => addComment(JSON.parse(event.data)));
		source.addEventListener("answer", (event) => applyAnswer(JSON.parse(event.data)));
		source.addEventListener("select", (event) => {
			const data = JSON.parse(event.data);
			if (JSON.stringify(data) !== JSON.stringify(selection)) applySelection(data && { post: data.post, item: data.item });
		});
		source.addEventListener("error", () => renderStatus("down"));
	}

	async function goToHash() {
		const id = decodeURIComponent(location.hash.slice(1));
		if (!id.startsWith("p_")) return;
		if (!posts.has(id) && scope.kind !== "all") await setScope({ kind: "all" });
		const post = posts.get(id);
		if (!post) return;
		select(post.id, post.items[0]?.id);
		document.getElementById(post.id)?.scrollIntoView({ block: "start" });
	}

	openButton.addEventListener("click", () => (mode === "dailies" ? setScope({ kind: "open" }) : setMode("dailies").then(() => setScope({ kind: "open" }))));
	for (const button of modesNav.querySelectorAll("button")) {
		button.querySelector(".mode-label").textContent = button.dataset.mode === "devlog" ? t.modeDevlog : t.modeDailies;
		button.addEventListener("click", () => setMode(button.dataset.mode));
	}
	renderModes();
	let searchTimer = 0;
	searchBox.placeholder = t.search;
	searchBox.addEventListener("input", () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			query = searchBox.value.trim();
			renderTree();
			loadState({ reset: true }).catch((error) => console.error(error));
		}, 250);
	});
	searchBox.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			searchBox.value = "";
			searchBox.dispatchEvent(new Event("input"));
			searchBox.blur();
		}
	});
	$("side-scrim").addEventListener("click", () => document.body.classList.remove("side-open"));
	$("side-toggle").addEventListener("click", () => {
		if (window.matchMedia("(max-width: 900px)").matches) document.body.classList.toggle("side-open");
		else {
			document.body.classList.toggle("side-hidden");
			save("side-hidden", document.body.classList.contains("side-hidden") ? "1" : "");
		}
	});
	if (load("side-hidden")) document.body.classList.add("side-hidden");
	fresh.addEventListener("click", () => {
		window.scrollTo({ top: 0, behavior: "smooth" });
		clearFresh();
	});
	moreButton.textContent = t.more;
	moreButton.addEventListener("click", () => loadOlder().catch((error) => console.error(error)));
	document.querySelector('[data-action="top"]').addEventListener("click", (event) => {
		event.preventDefault();
		window.scrollTo({ top: 0, behavior: "smooth" });
	});
	window.addEventListener("scroll", () => {
		if (window.scrollY < 120) clearFresh();
	});
	window.addEventListener("hashchange", goToHash);
	setInterval(() => {
		for (const node of document.querySelectorAll("time.time")) node.textContent = ago(node.getAttribute("datetime"));
	}, 30_000);

	renderKeys();
	renderEmptyState();
	renderStatus("connecting");
	loadState()
		.then(() => {
			goToHash();
			connect();
		})
		.catch((error) => {
			console.error(error);
			renderStatus("down");
			connect();
		});
})();
