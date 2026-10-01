// The review page. It keeps one feed of what agents have shown, newest first,
// and listens for new posts so it never needs reopening.
(() => {
	const t = window.t;
	const $ = (id) => document.getElementById(id);
	const feed = $("feed");
	const lanesNav = $("lanes");
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
	let lanes = [];
	let laneFilter = load("lane") || "all";
	let selection = null; // { post, item }
	let freshCount = 0;
	const unreadLanes = new Set();
	let hasMore = false;
	let connectedOnce = false;
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

	const laneKey = (post) => `${post.project}\u0000${post.lane}`;
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

	function visible(post) {
		return laneFilter === "all" || laneKey(post) === laneFilter;
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
		const adopt = el("button", {
			class: "act adopt",
			type: "button",
			"aria-pressed": String(item.verdict === "adopted"),
			title: `${t.adopt} (a)`,
			text: `✓ ${t.adopt}`,
			onclick: (event) => {
				event.stopPropagation();
				toggleVerdict(post.id, item.id, "adopted");
			},
		});
		const reject = el("button", {
			class: "act reject",
			type: "button",
			"aria-pressed": String(item.verdict === "rejected"),
			title: `${t.reject} (x)`,
			text: `✕ ${t.reject}`,
			onclick: (event) => {
				event.stopPropagation();
				toggleVerdict(post.id, item.id, "rejected");
			},
		});
		const name = el("span", { class: "name", title: `${item.source || item.name}\n${t.dragHint}`, text: item.name });
		makeDraggable(name, item);
		if (item.kind !== "image") makeDraggable(stage, item);
		tile.append(
			stage,
			el("div", { class: "tile-foot" }, [name, el("span", { class: "size", text: size(item.size) }), ...fileActions(post, item, { withFull: true }), adopt, reject]),
		);
		tile.addEventListener("click", () => select(post.id, item.id));
		tile.addEventListener("dblclick", (event) => {
			if (event.target.closest("model-viewer, video, audio, pre, iframe")) return;
			openLightbox(post.id, item.id);
		});
		applyVerdict(tile, item.verdict);
		return tile;
	}

	function applyVerdict(tile, verdict) {
		tile.dataset.verdict = verdict || "";
		tile.querySelector(".act.adopt").setAttribute("aria-pressed", String(verdict === "adopted"));
		tile.querySelector(".act.reject").setAttribute("aria-pressed", String(verdict === "rejected"));
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

	// ---- questions ----

	const drafts = new Map(); // `${post}/${question}` -> Set of option ids picked but not sent

	function questionItemIds(post) {
		const ids = new Set();
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
				.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
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
			for (const item of items) {
				const stage = el("div", { class: "stage", "data-kind": item.kind, "data-item": item.id }, [media(item)]);
				stage.addEventListener("dblclick", (event) => {
					if (event.target.closest("model-viewer, video, audio, pre, iframe")) return;
					openLightbox(post.id, item.id);
				});
				card.append(stage);
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
					el("span", { class: "who", text: `${t.yourAnswer}: ` }),
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
		const open = order.map((id) => posts.get(id)).filter((post) => visible(post) && openQuestions(post).length);
		openButton.hidden = open.length === 0;
		openButton.textContent = t.openQuestions(open.reduce((sum, post) => sum + openQuestions(post).length, 0));
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
		node.append(el("header", { class: "post-head" }, [el("h2", { class: "post-title", text: title }), meta]));
		if (post.note) node.append(el("p", { class: "note", text: post.note }));
		for (const question of post.questions || []) node.append(buildQuestion(post, question));
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
		const target = el("span", { class: "target" });
		const input = el("input", { type: "text", placeholder: t.commentPlaceholder, "aria-label": t.commentPlaceholder });
		input.addEventListener("keydown", async (event) => {
			if (event.key !== "Enter" || event.isComposing || !input.value.trim()) return;
			event.preventDefault();
			const text = input.value.trim();
			input.value = "";
			const { item } = composeTarget(post);
			try {
				await api("/api/comments", { post: post.id, item, text, by: "human" });
			} catch (error) {
				input.value = text;
				console.error(error);
			}
		});
		node.append(el("div", { class: "comments" }, [list, el("div", { class: "compose" }, [target, input])]));
		node.addEventListener("click", (event) => {
			if (!event.target.closest(".tile") && !event.target.closest(".compose")) select(post.id, selection?.post === post.id ? selection.item : undefined);
		});
		updateCompose(node, post);
		node.hidden = !visible(post);
		return node;
	}

	function updateCompose(node, post) {
		const target = node.querySelector(".compose .target");
		target.textContent = composeTarget(post).label;
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
			trackLane(post);
			if (!visible(post)) {
				unreadLanes.add(laneKey(post));
				renderLanes();
			} else if (window.scrollY < 120 && document.visibilityState === "visible") {
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

	function trackLane(post) {
		const key = laneKey(post);
		const lane = lanes.find((candidate) => `${candidate.project}\u0000${candidate.lane}` === key);
		if (lane) {
			lane.count++;
			lane.last = post.at;
			lanes = [lane, ...lanes.filter((candidate) => candidate !== lane)];
		} else {
			lanes.unshift({ project: post.project, lane: post.lane, issue: post.issue, count: 1, last: post.at });
		}
		renderLanes();
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

	async function toggleVerdict(postId, itemId, verdict) {
		const post = posts.get(postId);
		const item = post?.items.find((candidate) => candidate.id === itemId);
		if (!item) return;
		const next = item.verdict === verdict ? null : verdict;
		const previous = item.verdict;
		setVerdict(itemId, next);
		try {
			await api("/api/verdicts", { item: itemId, verdict: next, by: "human" });
		} catch (error) {
			setVerdict(itemId, previous);
			console.error(error);
		}
	}

	function addComment(comment) {
		const post = posts.get(comment.post);
		if (!post) return;
		if ((post.comments || []).some((existing) => existing.id === comment.id)) return;
		post.comments = [...(post.comments || []), comment];
		document.getElementById(post.id)?.querySelector(".comment-list").append(buildComment(post, comment));
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

	function renderLanes() {
		const projects = new Set(lanes.map((lane) => lane.project));
		const button = (key, children, title) =>
			el(
				"button",
				{
					class: "lane",
					type: "button",
					"aria-pressed": String(laneFilter === key),
					title,
					onclick: () => setLaneFilter(key),
				},
				children,
			);
		const chips = [button("all", [document.createTextNode(t.all)])];
		for (const lane of lanes) {
			const key = `${lane.project}\u0000${lane.lane}`;
			chips.push(
				button(
					key,
					[
						projects.size > 1 ? el("span", { class: "project", text: `${lane.project} ›` }) : null,
						document.createTextNode(lane.lane),
						unreadLanes.has(key) ? el("span", { class: "unread" }) : null,
					],
					`${lane.project} › ${lane.lane}${lane.issue ? ` (${lane.issue})` : ""}`,
				),
			);
		}
		lanesNav.replaceChildren(...chips);
	}

	function setLaneFilter(key) {
		laneFilter = key;
		save("lane", key);
		unreadLanes.delete(key);
		for (const [id, post] of posts) {
			const node = document.getElementById(id);
			if (node) node.hidden = !visible(post);
		}
		renderLanes();
		renderEmpty();
		renderOpen();
		window.scrollTo({ top: 0 });
	}

	function renderFresh() {
		fresh.hidden = freshCount === 0;
		fresh.textContent = t.fresh(freshCount);
		document.title = freshCount ? `(${freshCount}) agent dailies` : "agent dailies";
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
			else if ((event.key === "a" || event.key === "x") && selection?.item) toggleVerdict(selection.post, selection.item, event.key === "a" ? "adopted" : "rejected");
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
			case "a":
			case "x":
				if (selection?.item) toggleVerdict(selection.post, selection.item, event.key === "a" ? "adopted" : "rejected");
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
				if (selection) document.getElementById(selection.post)?.querySelector(".compose input")?.focus();
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

	async function loadState({ reset = false } = {}) {
		const state = await api(`/api/state?limit=${PAGE}`);
		if (reset) {
			posts.clear();
			order.length = 0;
			feed.replaceChildren();
		}
		lanes = state.lanes;
		if (laneFilter !== "all" && !lanes.some((lane) => `${lane.project}\u0000${lane.lane}` === laneFilter)) laneFilter = "all";
		hasMore = state.posts.length >= PAGE;
		for (const post of state.posts) addPost(post, { append: true });
		renderLanes();
		applySelection(state.selection && posts.has(state.selection.post) ? state.selection : null);
		renderEmpty();
	}

	async function loadOlder() {
		const oldest = order[order.length - 1];
		if (!oldest) return;
		const state = await api(`/api/state?limit=${PAGE}&before=${encodeURIComponent(oldest)}`);
		hasMore = state.posts.length >= PAGE;
		for (const post of state.posts) addPost(post, { append: true });
		applySelection(selection);
		renderEmpty();
	}

	function connect() {
		renderStatus("connecting");
		const source = new EventSource("/api/events");
		source.addEventListener("hello", () => {
			renderStatus("live");
			// After a reconnect, catch up on whatever arrived while we were away.
			if (connectedOnce) loadState({ reset: true }).catch((error) => console.error(error));
			connectedOnce = true;
		});
		source.addEventListener("post", (event) => addPost(JSON.parse(event.data), { arriving: true }));
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

	function goToHash() {
		const id = decodeURIComponent(location.hash.slice(1));
		const post = posts.get(id);
		if (!post) return;
		if (!visible(post)) setLaneFilter("all");
		select(post.id, post.items[0].id);
		document.getElementById(post.id)?.scrollIntoView({ block: "start" });
	}

	openButton.addEventListener("click", () => {
		const post = order.map((id) => posts.get(id)).find((candidate) => visible(candidate) && openQuestions(candidate).length);
		if (!post) return;
		select(post.id, undefined);
		document.getElementById(post.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
	});
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
