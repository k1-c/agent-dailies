// The review page. It keeps one feed of what agents have shown, newest first,
// and listens for new posts so it never needs reopening.
(() => {
	const t = window.t;
	const $ = (id) => document.getElementById(id);
	const feed = $("feed");
	const lanesNav = $("lanes");
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
			case "image":
				return el("img", { src, alt: item.name, loading: large ? "eager" : "lazy", decoding: "async" });
			case "video": {
				const video = el("video", { src, muted: true, loop: true, playsinline: true, controls: true, preload: "metadata" });
				video.muted = true;
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
					el("a", { href: src, download: item.name, text: t.download, onclick: (event) => event.stopPropagation() }),
				]);
		}
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
		const full = el("button", {
			class: "act icon",
			type: "button",
			title: `${t.full} (f)`,
			"aria-label": t.full,
			text: "⤢",
			onclick: (event) => {
				event.stopPropagation();
				select(post.id, item.id);
				openLightbox(post.id, item.id);
			},
		});
		tile.append(
			stage,
			el("div", { class: "tile-foot" }, [
				el("span", { class: "name", title: item.source || item.name, text: item.name }),
				el("span", { class: "size", text: size(item.size) }),
				adopt,
				reject,
				full,
			]),
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

	function buildPostElement(post) {
		const node = el("section", { class: "post", id: post.id, "data-post": post.id });
		const title = post.title || post.items.map((item) => item.name).join(" · ");
		const meta = el("div", { class: "meta" }, [
			el("span", { class: "chip", title: `${post.project} › ${post.lane}`, text: post.lane }),
			post.issue ? el("span", { class: "chip issue", text: post.issue }) : null,
			...(post.tags || []).map((tag) => el("span", { class: "chip tag", text: tag })),
			post.items.length > 1 ? el("span", { class: "time", text: t.files(post.items.length) }) : null,
			el("time", { class: "time", datetime: post.at, title: new Date(post.at).toLocaleString(), text: ago(post.at) }),
		]);
		node.append(el("header", { class: "post-head" }, [el("h2", { class: "post-title", text: title }), meta]));
		if (post.note) node.append(el("p", { class: "note", text: post.note }));
		const grid = el("div", { class: "grid", "data-columns": String(columnsFor(post.items.length)) });
		grid.style.setProperty("--columns", String(columnsFor(post.items.length)));
		post.items.forEach((item, index) => grid.append(buildTile(post, item, index)));
		node.append(grid);

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
		lightboxCaption.textContent = `${position}${item.name}${post.title ? ` — ${post.title}` : ""}`;
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
			case "c":
				if (selection) document.getElementById(selection.post)?.querySelector(".compose input")?.focus();
				break;
			case "f":
			case "Enter":
				if (selection?.item) openLightbox(selection.post, selection.item);
				break;
			case "Escape":
				select(null);
				break;
			case "g":
				window.scrollTo({ top: 0, behavior: "smooth" });
				break;
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
