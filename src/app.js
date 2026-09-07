/**
 * OpenCode Comparator
 *
 * Loads the snapshot from data/models.json and renders a sortable, filterable
 * table of every coding model across the free tier, Go subscription and Zen
 * pay-as-you-go gateway — price, context, capabilities and value for coding.
 * Up to 4 rows can be pinned for a side-by-side comparison.
 *
 * The header "Refresh data" button re-fetches the OpenCode Go and Zen catalogs
 * plus models.dev metadata in the browser and rebuilds the UI without a reload.
 */

const ORIGIN = typeof window !== "undefined" ? window.location.origin : "";

const MAX_OUTPUT_PRICE = 200;

function snapshotUrl() {
	return `${ORIGIN}/data/models.json`;
}

function budgetsUrl() {
	return `${ORIGIN}/data/budgets.json`;
}

// Base URL of the Cloudflare Worker that proxies opencode.ai (see /worker). opencode.ai does not
// send Access-Control-Allow-Origin headers, so the browser blocks direct fetches from any other
// origin (GitHub Pages, localhost, etc.). The Worker mirrors the two catalog endpoints and adds
// the CORS headers the browser needs.
const CORS_PROXY_BASE = "https://opencode-comparator-cors.skyrex23.workers.dev";

const LIVE = {
	modelsDev: "https://models.dev/api.json",
	goModels: `${CORS_PROXY_BASE}/go/models`,
	zenModels: `${CORS_PROXY_BASE}/zen/models`
};

const STATE = {
	data: null,
	filtered: [],
	selected: new Set(),
	filters: {
		search: "",
		plans: new Set(["go", "zen", "free"]),
		showActive: true,
		showDeprecated: false,
		labs: new Set(),
		minContext: 0,
		maxContext: null,
		minOutputPrice: 0,
		maxOutputPrice: MAX_OUTPUT_PRICE,
		reasoning: false,
		tools: false,
		structured: false,
		attachment: false,
		openWeights: false,
		sort: { field: "requestsMonth", dir: "desc" },
		hiddenColumns: new Set()
	}
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmt = {
	money(n) {
		if (n == null) return "—";
		if (n === 0) return "$0";
		const digits = n < 0.01 ? 4 : n < 1 ? 3 : 2;
		return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
	},
	tokens(n) {
		if (n == null) return "—";
		if (n >= 1_000_000) {
			const v = n / 1_000_000;
			return `${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}M`;
		}
		if (n >= 1000) return `${Math.round(n / 1000).toLocaleString()}K`;
		return String(n);
	},
	date(d) {
		if (!d) return "—";
		return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
	},
	datetime(iso) {
		if (!iso) return "—";
		return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
	}
};

function toast(msg, kind = "ok") {
	const el = $("#toast");
	el.textContent = msg;
	el.className = `toast toast--${kind}`;
	el.hidden = false;
	clearTimeout(toast._t);
	toast._t = setTimeout(() => {
		el.hidden = true;
	}, 3500);
}

function score(m) {
	if (m.cost?.output == null) return 0;
	const outCost = m.cost.output;
	const requests = m.estimatedRequests?.monthly ?? 0;
	const context = m.context ?? 0;
	const reasoningBoost = m.capabilities?.reasoning ? 1.25 : 1;
	const contextBonus = Math.log10(Math.max(context, 1000)) / 6;
	const requestBonus = requests > 0 ? Math.log10(requests) / 5 : 0;
	let costComponent = 0;
	if (outCost > 0) {
		const outputTokensPerDollar = 1_000_000 / outCost;
		costComponent = (outputTokensPerDollar / 1000) * 0.6;
	}
	const score = costComponent + contextBonus * 30 + requestBonus * 40;
	return score * reasoningBoost;
}

function scoreTier(score) {
	if (score >= 80) return "high";
	if (score >= 40) return "mid";
	return "low";
}

function labFromFamily(family, modelId) {
	const f = (family || "").toLowerCase();
	const id = (modelId || "").toLowerCase();
	if (f.startsWith("kimi")) return "Moonshot AI";
	if (f.startsWith("qwen")) return "Alibaba";
	if (f.startsWith("glm")) return "Zhipu AI";
	if (f.startsWith("mimo")) return "Xiaomi";
	if (f.startsWith("minimax")) return "MiniMax";
	if (f.startsWith("deepseek")) return "DeepSeek";
	if (f.startsWith("longcat")) return "Meituan";
	if (f.startsWith("hy")) return "Tencent";
	if (f.startsWith("grok") || f.startsWith("ox")) return "xAI";
	if (f.startsWith("gpt") || id.startsWith("gpt-") || f.startsWith("gpt-")) return "OpenAI";
	if (f.startsWith("muse")) return "Meta";
	if (f.startsWith("claude") || id.startsWith("claude-")) return "Anthropic";
	if (f.startsWith("gemini")) return "Google";
	if (f.startsWith("nemotron")) return "NVIDIA";
	if (f.startsWith("ling")) return "Ant Group";
	if (f.startsWith("big-pickle") || id === "big-pickle") return "Stealth";
	return family || "Unknown";
}

function statusTag(m) {
	if (m.status === "active") return `<span class="tag tag--active">Active</span>`;
	if (m.status === "legacy") return `<span class="tag tag--legacy">Legacy</span>`;
	if (m.status === "preview-or-removed") return `<span class="tag tag--legacy">Preview</span>`;
	return `<span class="tag tag--deprecated">Deprecated</span>`;
}

function weightsTag(m) {
	return m.openWeights
		? `<span class="tag tag--open" title="Public weights available">Open</span>`
		: `<span class="tag tag--closed" title="Closed weights">Closed</span>`;
}

function tierTag(m) {
	if (m.monthlyBudgetUsd == null) return `<span class="tag tag--legacy">—</span>`;
	const tier = m.monthlyBudgetUsd;
	if (tier === 15) return `<span class="tag tag--premium">$15 tier</span>`;
	if (tier === 30) return `<span class="tag tag--mid">$30 tier</span>`;
	return `<span class="tag tag--standard">$60 tier</span>`;
}

function planTag(m) {
	if (m.plan === "go") {
		return `<span class="tag tag--go" title="Included in the $10/mo OpenCode Go subscription">Go</span>`;
	}
	if (m.plan === "zen") {
		return `<span class="tag tag--zen" title="OpenCode Zen gateway, pay-as-you-go per 1M tokens">Zen</span>`;
	}
	return `<span class="tag tag--free" title="Available without a Go or Zen subscription">Free</span>`;
}

function capabilityIcons(m) {
	const caps = [
		{ key: "reasoning", label: "Reasoning — extended thinking / chain-of-thought", glyph: "R" },
		{ key: "toolCall", label: "Tool calls — can invoke functions and tools", glyph: "T" },
		{ key: "structuredOutput", label: "Structured output — can return JSON-schema data", glyph: "S" },
		{ key: "attachment", label: "Attachments — accepts images, PDFs, audio", glyph: "A" }
	];
	return caps
		.map((c) => `<span class="cap" data-on="${!!m.capabilities?.[c.key]}" title="${c.label}">${c.glyph}</span>`)
		.join("");
}

function contextBar(m) {
	const max = 1_048_576;
	const pct = m.context ? Math.min(100, (m.context / max) * 100) : 0;
	let cls = "bar";
	if (m.context >= 1_000_000) cls += " bar--premium";
	else if (m.context >= 500_000) cls += " bar--mid";
	else cls += " bar--low";
	return `<span class="${cls}"><span class="bar__fill" style="width:${pct}%"></span></span><span class="bar-text">${fmt.tokens(m.context)}</span>`;
}

function scoreCell(m) {
	if (m.plan === "free") {
		return `<div class="value-cell">
			<span class="value-cell__score value-cell__score--high">Free</span>
			<span class="value-cell__bar"><span class="value-cell__bar-fill value-cell__bar-fill--high" style="width:100%"></span></span>
		</div>`;
	}
	const s = score(m);
	const tier = scoreTier(s);
	const pct = Math.min(100, (s / 120) * 100);
	return `<div class="value-cell">
		<span class="value-cell__score value-cell__score--${tier}">${s.toFixed(0)}</span>
		<span class="value-cell__bar"><span class="value-cell__bar-fill value-cell__bar-fill--${tier}" style="width:${pct}%"></span></span>
	</div>`;
}

const COLUMNS = [
	{
		id: "name",
		label: "Model",
		thClass: "th-model",
		sortable: true,
		hideable: false,
		defaultDir: "asc",
		sortKey: (m) => m.name.toLowerCase(),
		cellHtml: (m) => `
			<div class="model-cell">
				<span class="model-cell__name" data-detail="${m.id}">${m.name}</span>
				<span class="model-cell__meta">
					${planTag(m)} ${statusTag(m)} ${weightsTag(m)}
					<span class="dot">·</span>
					<span>${m.lab || "—"}</span>
					${m.releaseDate ? `<span class="dot">·</span><span>${fmt.date(m.releaseDate)}</span>` : ""}
				</span>
			</div>`
	},
	{
		id: "inputCost",
		label: "In $/1M",
		thClass: "th-cost num",
		sortable: true,
		defaultDir: "asc",
		sortKey: (m) => (m.cost?.input != null ? m.cost.input : Infinity),
		cellHtml: (m) => `<span class="${m.cost?.input != null ? "" : "num--dim"}">${fmt.money(m.cost?.input)}</span>`
	},
	{
		id: "outputCost",
		label: "Out $/1M",
		thClass: "th-cost num",
		sortable: true,
		defaultDir: "asc",
		sortKey: (m) => (m.cost?.output != null ? m.cost.output : Infinity),
		cellHtml: (m) => `<span class="${m.cost?.output != null ? "" : "num--dim"}">${fmt.money(m.cost?.output)}</span>`
	},
	{
		id: "cacheRead",
		label: "Cache read",
		thClass: "th-cost num",
		sortable: false,
		cellHtml: (m) =>
			`<span class="${m.cost?.cacheRead != null ? "" : "num--dim"}">${fmt.money(m.cost?.cacheRead)}</span>`
	},
	{
		id: "context",
		label: "Context",
		thClass: "th-context",
		sortable: true,
		defaultDir: "desc",
		sortKey: (m) => m.context ?? 0,
		cellHtml: (m) => contextBar(m)
	},
	{
		id: "tier",
		label: "Tier",
		thClass: "th-budget",
		sortable: false,
		cellHtml: (m) => tierTag(m)
	},
	{
		id: "requestsMonth",
		label: "Req / mo",
		thClass: "th-requests num",
		sortable: true,
		defaultDir: "desc",
		sortKey: (m) => m.estimatedRequests?.monthly ?? 0,
		cellHtml: (m) => {
			const monthly = m.estimatedRequests?.monthly;
			return `<span class="${monthly ? "num--strong" : "num--dim"}">${monthly?.toLocaleString() ?? "—"}</span>`;
		}
	},
	{
		id: "caps",
		label: "Caps",
		thClass: "th-caps",
		sortable: false,
		cellHtml: (m) => `<div class="caps">${capabilityIcons(m)}</div>`
	},
	{
		id: "releaseDate",
		label: "Released",
		thClass: "th-date",
		sortable: true,
		defaultDir: "desc",
		sortKey: (m) => m.releaseDate || "",
		cellHtml: (m) => `<span class="${m.releaseDate ? "" : "num--dim"}">${fmt.date(m.releaseDate)}</span>`
	},
	{
		id: "score",
		label: "Score",
		thClass: "th-score",
		sortable: true,
		defaultDir: "desc",
		sortKey: (m) => score(m),
		cellHtml: (m) => scoreCell(m)
	}
];

const COL_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));

function rowHTML(m) {
	const req = m.estimatedRequests || {};
	const selected = STATE.selected.has(m.id) ? "is-selected" : "";
	const legacyCls = m.status === "legacy" ? "is-legacy" : m.status === "deprecated" ? "is-deprecated" : "";
	const cells = COLUMNS.map((c) => {
		const hidden = STATE.filters.hiddenColumns.has(c.id) ? " is-hidden" : "";
		const cls = c.thClass ? ` class="${c.thClass}${hidden}"` : ` class="${hidden.trim()}"`;
		return `<td data-col="${c.id}"${cls}>${c.cellHtml(m)}</td>`;
	}).join("");
	return `
		<tr class="${selected} ${legacyCls}" data-id="${m.id}">
			<td class="th-check"><input type="checkbox" data-cmp="${m.id}" ${STATE.selected.has(m.id) ? "checked" : ""} /></td>
			${cells}
		</tr>`;
}

function applyFilters() {
	const f = STATE.filters;
	const q = f.search.trim().toLowerCase();
	let arr = STATE.data.models.filter((m) => {
		if (!f.plans.has(m.plan)) return false;
		if (m.status === "active" && !f.showActive) return false;
		if (m.status === "deprecated" && !f.showDeprecated) return false;
		if (q) {
			const hay = `${m.name} ${m.id} ${m.lab} ${m.family || ""}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		if (f.labs.size > 0 && !f.labs.has(m.lab)) return false;
		if (f.minContext > 0 && (m.context || 0) < f.minContext) return false;
		if (f.maxContext != null && (m.context || 0) > f.maxContext) return false;
		const outCost = m.cost?.output ?? 0;
		if (f.minOutputPrice > 0 && outCost < f.minOutputPrice) return false;
		if (f.maxOutputPrice < MAX_OUTPUT_PRICE && outCost > f.maxOutputPrice) return false;
		if (f.reasoning && !m.capabilities?.reasoning) return false;
		if (f.tools && !m.capabilities?.toolCall) return false;
		if (f.structured && !m.capabilities?.structuredOutput) return false;
		if (f.attachment && !m.capabilities?.attachment) return false;
		if (f.openWeights && !m.openWeights) return false;
		return true;
	});

	const s = f.sort;
	const col = s && COL_BY_ID[s.field];
	const sign = s?.dir === "asc" ? 1 : -1;
	if (col && col.sortKey) {
		arr.sort((a, b) => {
			const va = col.sortKey(a);
			const vb = col.sortKey(b);
			if (va == null && vb == null) return a.id.localeCompare(b.id);
			if (va == null) return 1;
			if (vb == null) return -1;
			if (va < vb) return -1 * sign;
			if (va > vb) return 1 * sign;
			return a.id.localeCompare(b.id);
		});
	}

	STATE.filtered = arr;
}

function renderTable() {
	const body = $("#models-body");
	body.innerHTML = STATE.filtered.map(rowHTML).join("");
}

function render() {
	const empty = STATE.filtered.length === 0;
	$("#empty").hidden = !empty;
	$("#table-wrap").hidden = empty;

	if (!empty) renderTable();

	$("#result-count").textContent = `${STATE.filtered.length} of ${STATE.data.models.length} models`;
	renderPills();
	renderCompareBar();
	updateSortHeader();
	applyColumnVisibility();
	bindRowEvents();
}

function updateSortHeader() {
	const current = STATE.filters.sort;
	$$("th[data-sort]").forEach((th) => {
		const field = th.getAttribute("data-sort");
		const isActive = current && current.field === field;
		th.classList.toggle("is-sorted", !!isActive);
		th.classList.toggle("is-asc", !!isActive && current.dir === "asc");
		th.classList.toggle("is-desc", !!isActive && current.dir === "desc");
	});
}

function applyColumnVisibility() {
	$$(".table th[data-col], .table td[data-col]").forEach((el) => {
		const id = el.getAttribute("data-col");
		el.classList.toggle("is-hidden", isHideable(id) && STATE.filters.hiddenColumns.has(id));
	});
}

function renderPills() {
	const f = STATE.filters;
	const pills = [];
	if (f.search) pills.push({ k: "search", label: `q: ${f.search}` });
	const singlePlanLabels = { go: "Go only", zen: "Zen only", free: "Free only" };
	const planKeys = Array.from(f.plans);
	if (planKeys.length === 1 && singlePlanLabels[planKeys[0]]) {
		const k =
			planKeys[0] === "go"
				? "plan:zen,plan:free"
				: planKeys[0] === "zen"
					? "plan:go,plan:free"
					: "plan:go,plan:zen";
		pills.push({ k, label: singlePlanLabels[planKeys[0]] });
	} else if (f.plans.size === 0) pills.push({ k: "plans", label: "no plans selected" });
	const checkedStatuses = [];
	if (f.showActive) checkedStatuses.push("active");
	if (f.showDeprecated) checkedStatuses.push("deprecated");
	if (checkedStatuses.length === 0) pills.push({ k: "statuses", label: "no statuses" });
	for (const s of checkedStatuses) pills.push({ k: `status:${s}`, label: s });
	for (const lab of f.labs) pills.push({ k: `lab:${lab}`, label: lab });
	if (f.minContext > 0) pills.push({ k: "contextMin", label: `ctx ≥ ${fmt.tokens(f.minContext)}` });
	if (f.maxContext != null) pills.push({ k: "contextMax", label: `ctx ≤ ${fmt.tokens(f.maxContext)}` });
	if (f.minOutputPrice > 0) pills.push({ k: "outputPriceMin", label: `out ≥ ${fmt.money(f.minOutputPrice)}` });
	if (f.maxOutputPrice < MAX_OUTPUT_PRICE)
		pills.push({ k: "outputPrice", label: `out ≤ ${fmt.money(f.maxOutputPrice)}` });
	if (f.reasoning) pills.push({ k: "reasoning", label: "reasoning" });
	if (f.tools) pills.push({ k: "tools", label: "tools" });
	if (f.structured) pills.push({ k: "structured", label: "structured" });
	if (f.attachment) pills.push({ k: "attachment", label: "attachments" });
	if (f.openWeights) pills.push({ k: "openWeights", label: "open weights" });

	const out = $("#active-pills");
	if (pills.length === 0) {
		out.innerHTML = "";
		return;
	}
	out.innerHTML = pills
		.map(
			(p) =>
				`<span class="pill">${p.label} <button data-clear="${p.k}" aria-label="Remove">&times;</button></span>`
		)
		.join("");
}

function renderCompareBar() {
	const bar = $("#cmpbar");
	const ids = Array.from(STATE.selected);
	if (ids.length === 0) {
		bar.hidden = true;
		return;
	}
	bar.hidden = false;
	$("#cmp-count").textContent = ids.length;
	$("#cmp-chips").innerHTML = ids
		.map((id) => {
			const m = STATE.data.models.find((x) => x.id === id);
			if (!m) return "";
			return `<span class="cmp-chip">${m.name} <button data-remove="${id}" aria-label="Remove">&times;</button></span>`;
		})
		.join("");
}

function bindRowEvents() {
	$$("input[data-cmp]").forEach((cb) => {
		cb.addEventListener("change", (e) => {
			const id = e.target.getAttribute("data-cmp");
			if (e.target.checked) {
				if (STATE.selected.size >= 4) {
					e.target.checked = false;
					toast("Up to 4 models at a time.", "error");
					return;
				}
				STATE.selected.add(id);
			} else {
				STATE.selected.delete(id);
			}
			render();
		});
	});
	$$("[data-detail]").forEach((el) => {
		el.addEventListener("click", (e) => {
			e.stopPropagation();
			openDetail(el.getAttribute("data-detail"));
		});
	});
}

const HIDDEN_COLUMNS_KEY = "ai-comparator.hiddenColumns";

function loadHiddenColumns() {
	try {
		const raw = localStorage.getItem(HIDDEN_COLUMNS_KEY);
		if (!raw) return;
		const arr = JSON.parse(raw);
		if (Array.isArray(arr)) STATE.filters.hiddenColumns = new Set(arr.filter((id) => isHideable(id)));
	} catch (_) {
		// ignore corrupted storage
	}
}

function saveHiddenColumns() {
	try {
		localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...STATE.filters.hiddenColumns]));
	} catch (_) {
		// ignore quota errors
	}
}

function isHideable(id) {
	const col = COL_BY_ID[id];
	return !!col && col.hideable !== false;
}

function bindSortHeaders() {
	$$("th[data-sort]").forEach((th) => {
		th.addEventListener("click", () => {
			const field = th.getAttribute("data-sort");
			const col = COL_BY_ID[field];
			if (!col || !col.sortable) return;
			const current = STATE.filters.sort;
			let next;
			if (current && current.field === field) {
				if (current.dir === col.defaultDir) {
					next = { field, dir: col.defaultDir === "asc" ? "desc" : "asc" };
				} else {
					next = null;
				}
			} else {
				next = { field, dir: col.defaultDir };
			}
			STATE.filters.sort = next;
			applyAndRender();
		});
	});
}

function bindColumnsToggle() {
	const btn = $("#btn-columns");
	const pop = $("#columns-popover");
	if (!btn || !pop) return;
	const close = () => {
		pop.hidden = true;
		btn.setAttribute("aria-expanded", "false");
	};
	const open = () => {
		renderColumnsList();
		pop.hidden = false;
		btn.setAttribute("aria-expanded", "true");
	};
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		if (pop.hidden) open();
		else close();
	});
	document.addEventListener("click", (e) => {
		if (pop.hidden) return;
		if (pop.contains(e.target) || btn.contains(e.target)) return;
		close();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !pop.hidden) close();
	});
	pop.addEventListener("change", (e) => {
		const cb = e.target.closest("input[data-col-toggle]");
		if (!cb) return;
		const id = cb.getAttribute("data-col-toggle");
		if (!isHideable(id)) {
			cb.checked = true;
			return;
		}
		if (cb.checked) STATE.filters.hiddenColumns.delete(id);
		else STATE.filters.hiddenColumns.add(id);
		saveHiddenColumns();
		applyAndRender();
	});
}

function renderColumnsList() {
	const pop = $("#columns-popover");
	if (!pop) return;
	const hidden = STATE.filters.hiddenColumns;
	pop.innerHTML = `
		<div class="col-popover__head">Columns</div>
		<div class="col-popover__list">
			${COLUMNS.map((c) => {
				const locked = c.hideable === false;
				const checked = locked || !hidden.has(c.id);
				const disabledAttr = locked ? "disabled" : "";
				return `
				<label class="col-popover__item ${locked ? "is-locked" : ""}">
					<input type="checkbox" data-col-toggle="${c.id}" ${checked ? "checked" : ""} ${disabledAttr} />
					<span>${c.label}${locked ? ` <em>(always shown)</em>` : ""}</span>
				</label>`;
			}).join("")}
		</div>`;
}

function renderLabs() {
	const labs = Array.from(new Set(STATE.data.models.map((m) => m.lab).filter(Boolean))).sort();
	const host = $("#f-labs");
	host.innerHTML = labs
		.map(
			(lab) =>
				`<button class="chip" type="button" data-lab="${lab}" aria-pressed="${STATE.filters.labs.has(lab)}">${lab}</button>`
		)
		.join("");
	$$("[data-lab]", host).forEach((btn) => {
		btn.addEventListener("click", () => {
			const lab = btn.getAttribute("data-lab");
			if (STATE.filters.labs.has(lab)) STATE.filters.labs.delete(lab);
			else STATE.filters.labs.add(lab);
			btn.setAttribute("aria-pressed", STATE.filters.labs.has(lab));
			applyAndRender();
		});
	});
}

function renderKpis() {
	const active = STATE.data.models.filter((m) => m.status === "active");
	const countByPlan = {
		free: active.filter((m) => m.plan === "free").length,
		go: active.filter((m) => m.plan === "go").length,
		zen: active.filter((m) => m.plan === "zen").length
	};
	const providerCount = new Set(active.map((m) => m.lab).filter(Boolean)).size;
	const subMonthly = STATE.data.subscription?.monthlyUsd;
	const subCap = STATE.data.subscription?.limitUsd?.monthly;
	const plans = STATE.filters.plans;
	let activeKey = null;
	if (plans.size === 3) activeKey = "active";
	else if (plans.size === 1) activeKey = [...plans][0];

	const kpis = [
		{
			key: "active",
			label: "Active models",
			value: String(active.length),
			sub: providerCount > 0 ? `From ${providerCount} providers` : "—"
		},
		{
			key: "free",
			label: "Free models",
			value: String(countByPlan.free),
			sub: "No subscription needed"
		},
		{
			key: "go",
			label: "Go models",
			value: String(countByPlan.go),
			sub:
				subMonthly != null && subCap != null
					? `$${subMonthly}/mo · $${subCap} monthly cap`
					: "Monthly subscription"
		},
		{
			key: "zen",
			label: "Zen models",
			value: String(countByPlan.zen),
			sub: "Pay-as-you-go, no monthly cap"
		}
	];
	const host = $("#hero-kpis");
	host.innerHTML = kpis
		.map(
			(k) => `
			<div class="kpi${k.key === activeKey ? " kpi--active" : ""}" data-kpi="${k.key}" role="button" tabindex="0" aria-label="Filter lineup by ${k.label.toLowerCase()}">
				<div class="kpi__label">${k.label}</div>
				<div class="kpi__value ${k.accent ? "kpi__value--accent" : ""}">${k.value}</div>
				${k.sub ? `<div class="kpi__sub">${k.sub}</div>` : ""}
			</div>`
		)
		.join("");
}

function setKpiFilter(plan) {
	const plans = plan ? [plan] : ["free", "go", "zen"];
	STATE.filters.plans = new Set(plans);
	$("#f-plan-free").checked = plans.includes("free");
	$("#f-plan-go").checked = plans.includes("go");
	$("#f-plan-zen").checked = plans.includes("zen");
	applyAndRender();
}

function bindKpis() {
	const host = $("#hero-kpis");
	const activate = (card) => {
		const key = card.dataset.kpi;
		setKpiFilter(key === "active" ? null : key);
	};
	host.addEventListener("click", (e) => {
		const card = e.target.closest("[data-kpi]");
		if (card) activate(card);
	});
	host.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		const card = e.target.closest("[data-kpi]");
		if (!card) return;
		e.preventDefault();
		activate(card);
	});
}

function renderBrand() {
	$("#brand-sub").textContent = `Updated ${fmt.datetime(STATE.data.fetchedAt)}`;
	$("#footer-time").textContent = fmt.datetime(STATE.data.fetchedAt);
}

function applyAndRender() {
	applyFilters();
	render();
	renderKpis();
}

function openDetail(id) {
	const m = STATE.data.models.find((x) => x.id === id);
	if (!m) return;
	$("#detail-name").textContent = m.name;
	const subBits = [m.lab, m.id];
	if (m.status !== "active") subBits.push(m.status);
	$("#detail-sub").textContent = subBits.join(" · ");

	const req = m.estimatedRequests || {};
	const budget = m.monthlyBudgetUsd != null ? `$${m.monthlyBudgetUsd} / mo` : "—";
	const capList = [
		{ k: "reasoning", label: "Reasoning" },
		{ k: "toolCall", label: "Tool calls" },
		{ k: "structuredOutput", label: "Structured output" },
		{ k: "attachment", label: "Attachments" }
	];
	const capHTML = capList
		.map((c) => {
			const on = !!m.capabilities?.[c.key];
			return `<span class="tag ${on ? "tag--active" : "tag--legacy"}">${c.label}: ${on ? "yes" : "no"}</span>`;
		})
		.join(" ");

	$("#detail-body").innerHTML = `
		${m.description ? `<p style="color:var(--text-dim);font-size:14px;line-height:1.55;margin:0 0 8px;">${m.description}</p>` : ""}
		<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px;">${statusTag(m)} ${weightsTag(m)} ${tierTag(m)}</div>
		<div class="detail-grid">
			<div class="detail-card">
				<h3>Output price</h3>
				<div class="num-big num-big--accent">${fmt.money(m.cost?.output)}<span style="color:var(--text-faint);font-size:13px;font-weight:400;"> / 1M</span></div>
				<div class="sub">Input ${fmt.money(m.cost?.input)} / 1M</div>
			</div>
			<div class="detail-card">
				<h3>Caching</h3>
				<div class="num-big">${fmt.money(m.cost?.cacheRead)}</div>
				<div class="sub">cache read · write ${fmt.money(m.cost?.cacheWrite)}</div>
			</div>
			<div class="detail-card">
				<h3>Context window</h3>
				<div class="num-big">${fmt.tokens(m.context)}</div>
				<div class="sub">output limit ${fmt.tokens(m.outputLimit)}</div>
			</div>
			<div class="detail-card">
				<h3>Subscription tier</h3>
				<div class="num-big">${budget}</div>
				<div class="sub">${req.monthly ? `≈ ${req.monthly.toLocaleString()} req/mo` : "no per-model allocation"}</div>
			</div>
			<div class="detail-card">
				<h3>Requests (official est.)</h3>
				<div class="num-big">${req.fiveHours?.toLocaleString() ?? "—"}</div>
				<div class="sub">per 5h window · ${req.weekly?.toLocaleString() ?? "—"} per week</div>
			</div>
			<div class="detail-card">
				<h3>Score</h3>
				<div class="num-big">${score(m).toFixed(0)}</div>
				<div class="sub">composite of price, context and request budget</div>
			</div>
			<div class="detail-card">
				<h3>Released</h3>
				<div class="num-big" style="font-size:14px;font-family:var(--font-mono);">${fmt.date(m.releaseDate)}</div>
				<div class="sub">updated ${fmt.date(m.lastUpdated)} · knowledge cutoff ${m.knowledgeCutoff || "—"}</div>
			</div>
			<div class="detail-card">
				<h3>Modalities</h3>
				<div class="num-big" style="font-size:13px;font-family:var(--font-mono);">${m.modalities.input.join(" · ") || "—"}</div>
				<div class="sub">output: ${m.modalities.output.join(" · ") || "—"}</div>
			</div>
		</div>
		<div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:6px;">${capHTML}</div>
		${m.budgetNotes ? `<p style="margin-top:14px;font-size:12px;color:var(--warn);padding:10px 12px;background:var(--warn-soft);border-radius:6px;">⚠ ${m.budgetNotes}</p>` : ""}
		${m.status === "deprecated" || m.status === "legacy" ? `<p style="margin-top:12px;font-size:12px;color:var(--text-dim);">This model is not in the curated "active" lineup — it may still work via the API but is not promoted on the official docs.</p>` : ""}
	`;
	const cmpBox = $("#detail-compare");
	cmpBox.checked = STATE.selected.has(id);
	cmpBox.onchange = () => {
		if (cmpBox.checked) {
			if (STATE.selected.size >= 4) {
				cmpBox.checked = false;
				toast("Up to 4 models at a time.", "error");
				return;
			}
			STATE.selected.add(id);
		} else {
			STATE.selected.delete(id);
		}
		render();
	};
	$("#detail").showModal();
}

function openCompare() {
	const ids = Array.from(STATE.selected);
	if (ids.length < 2) {
		toast("Pick at least 2 models to compare.", "error");
		return;
	}
	const models = ids.map((id) => STATE.data.models.find((x) => x.id === id)).filter(Boolean);
	$("#compare-sub").textContent =
		`${models.length} models · $${STATE.data.subscription.monthlyUsd}/mo subscription · best value highlighted`;

	const rows = [
		{ label: "Lab", pick: (m) => m.lab },
		{ label: "Status", pick: (m) => m.status },
		{ label: "Weights", pick: (m) => (m.openWeights ? "open" : "closed") },
		{
			label: "Output price",
			pick: (m) => fmt.money(m.cost?.output),
			bestFn: (m) => m.cost?.output ?? Infinity,
			bestDir: "min",
			unit: "/ 1M"
		},
		{
			label: "Input price",
			pick: (m) => fmt.money(m.cost?.input),
			bestFn: (m) => m.cost?.input ?? Infinity,
			bestDir: "min",
			unit: "/ 1M"
		},
		{
			label: "Cache read",
			pick: (m) => fmt.money(m.cost?.cacheRead),
			bestFn: (m) => m.cost?.cacheRead ?? Infinity,
			bestDir: "min",
			unit: "/ 1M"
		},
		{ label: "Context", pick: (m) => fmt.tokens(m.context), bestFn: (m) => m.context || 0, bestDir: "max" },
		{
			label: "Output limit",
			pick: (m) => fmt.tokens(m.outputLimit),
			bestFn: (m) => m.outputLimit || 0,
			bestDir: "max"
		},
		{
			label: "Monthly budget",
			pick: (m) => (m.monthlyBudgetUsd ? `$${m.monthlyBudgetUsd}` : "—"),
			bestFn: (m) => m.monthlyBudgetUsd ?? -1,
			bestDir: "max"
		},
		{
			label: "Requests / 5h",
			pick: (m) => m.estimatedRequests?.fiveHours?.toLocaleString() ?? "—",
			bestFn: (m) => m.estimatedRequests?.fiveHours ?? 0,
			bestDir: "max"
		},
		{
			label: "Requests / week",
			pick: (m) => m.estimatedRequests?.weekly?.toLocaleString() ?? "—",
			bestFn: (m) => m.estimatedRequests?.weekly ?? 0,
			bestDir: "max"
		},
		{
			label: "Requests / month",
			pick: (m) => m.estimatedRequests?.monthly?.toLocaleString() ?? "—",
			bestFn: (m) => m.estimatedRequests?.monthly ?? 0,
			bestDir: "max"
		},
		{ label: "Reasoning", pick: (m) => (m.capabilities?.reasoning ? "yes" : "no") },
		{ label: "Tool calls", pick: (m) => (m.capabilities?.toolCall ? "yes" : "no") },
		{ label: "Structured", pick: (m) => (m.capabilities?.structuredOutput ? "yes" : "no") },
		{ label: "Attachments", pick: (m) => (m.capabilities?.attachment ? "yes" : "no") },
		{ label: "Modalities in", pick: (m) => m.modalities.input.join(", ") || "—" },
		{ label: "Released", pick: (m) => fmt.date(m.releaseDate), bestFn: (m) => m.releaseDate || "", bestDir: "max" },
		{ label: "Score", pick: (m) => score(m).toFixed(0), bestFn: (m) => score(m), bestDir: "max" }
	];

	const grid = $("#compare-body");
	grid.style.setProperty("--cols", models.length);
	const headerCols = models
		.map(
			(m) => `<div class="compare-col-head">
				<h3>${m.name}</h3>
				<div class="lab">${m.lab} · ${m.id}</div>
				<div class="tags">${statusTag(m)} ${weightsTag(m)}</div>
			</div>`
		)
		.join("");
	const headerRow = `<div class="compare-cols-head" style="--cols:${models.length}"><div></div>${headerCols}</div>`;

	const bodyRows = rows
		.map((row) => {
			let bestIdx = -1;
			let worstIdx = -1;
			if (row.bestFn) {
				const vals = models.map((m) => row.bestFn(m));
				if (row.bestDir === "max") {
					const max = Math.max(...vals);
					const finite = vals.filter((v) => Number.isFinite(v) && v > 0);
					const min = finite.length ? Math.min(...finite) : max;
					bestIdx = vals.findIndex((v) => v === max && v > 0);
					worstIdx = vals.findIndex((v) => v === min && min < max);
				} else {
					const finite = vals.filter((v) => Number.isFinite(v));
					const min = finite.length ? Math.min(...finite) : Infinity;
					const max = finite.length ? Math.max(...finite) : 0;
					bestIdx = vals.findIndex((v) => v === min && v < Infinity);
					worstIdx = vals.findIndex((v) => v === max && max > min);
				}
			}
			const cells = models
				.map((m, i) => {
					const cls = i === bestIdx ? "compare-cell--best" : i === worstIdx ? "compare-cell--worst" : "";
					return `<div class="compare-row__value ${cls}">${row.pick(m)}${row.unit ? ` <span style="color:var(--text-faint);font-size:11px;">${row.unit}</span>` : ""}</div>`;
				})
				.join("");
			return `<div class="compare-row" style="--cols:${models.length}"><span class="compare-row__label">${row.label}</span>${cells}</div>`;
		})
		.join("");

	grid.innerHTML = headerRow + bodyRows;
	$("#compare").showModal();
}

function bindFilters() {
	$("#f-search").addEventListener("input", (e) => {
		STATE.filters.search = e.target.value;
		applyAndRender();
	});
	$("#f-plan-go").addEventListener("change", (e) => {
		togglePlan("go", e.target.checked);
		applyAndRender();
	});
	$("#f-plan-zen").addEventListener("change", (e) => {
		togglePlan("zen", e.target.checked);
		applyAndRender();
	});
	$("#f-plan-free").addEventListener("change", (e) => {
		togglePlan("free", e.target.checked);
		applyAndRender();
	});
	$("#f-active").addEventListener("change", (e) => {
		STATE.filters.showActive = e.target.checked;
		applyAndRender();
	});
	$("#f-legacy").addEventListener("change", (e) => {
		STATE.filters.showDeprecated = e.target.checked;
		applyAndRender();
	});
	$("#f-context-min").addEventListener("change", (e) => {
		STATE.filters.minContext = Number(e.target.value) || 0;
		applyAndRender();
	});
	$("#f-context-max").addEventListener("change", (e) => {
		const v = e.target.value;
		STATE.filters.maxContext = v ? Number(v) : null;
		applyAndRender();
	});
	$("#f-output-min").addEventListener("input", (e) => {
		const raw = e.target.value.trim();
		if (raw === "") {
			STATE.filters.minOutputPrice = 0;
		} else {
			const v = Number(raw);
			STATE.filters.minOutputPrice = Number.isFinite(v) && v >= 0 ? v : 0;
		}
		applyAndRender();
	});
	$("#f-output-max").addEventListener("input", (e) => {
		const raw = e.target.value.trim();
		if (raw === "") {
			STATE.filters.maxOutputPrice = MAX_OUTPUT_PRICE;
		} else {
			const v = Number(raw);
			STATE.filters.maxOutputPrice =
				Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_OUTPUT_PRICE) : MAX_OUTPUT_PRICE;
		}
		applyAndRender();
	});
	for (const id of ["reasoning", "tools", "structured", "attachment", "open"]) {
		const key = id === "tools" ? "tools" : id === "open" ? "openWeights" : id;
		$(`#f-${id}`).addEventListener("change", (e) => {
			STATE.filters[key] = e.target.checked;
			applyAndRender();
		});
	}

	bindSortHeaders();
	bindColumnsToggle();

	$$("[data-clear]").forEach((btn) => {
		btn.addEventListener("click", () => {
			clearFilter(btn.getAttribute("data-clear"));
			applyAndRender();
		});
	});

	$$("[data-pick]").forEach((btn) => {
		btn.addEventListener("click", () => {
			applyQuickPick(btn.getAttribute("data-pick"));
			applyAndRender();
		});
	});

	$$("[data-remove]").forEach((btn) => {
		btn.addEventListener("click", () => {
			STATE.selected.delete(btn.getAttribute("data-remove"));
			render();
		});
	});

	$("#cmp-clear").addEventListener("click", () => {
		STATE.selected.clear();
		render();
	});
	$("#cmp-open").addEventListener("click", openCompare);

	$("#cta-how").addEventListener("click", () => {
		$("#explainer-zen").hidden = true;
		$("#explainer").hidden = false;
		$("#explainer").scrollIntoView({ behavior: "smooth", block: "start" });
	});
	$("#cta-how-zen").addEventListener("click", () => {
		$("#explainer").hidden = true;
		$("#explainer-zen").hidden = false;
		$("#explainer-zen").scrollIntoView({ behavior: "smooth", block: "start" });
	});
	$("#explainer-close").addEventListener("click", () => {
		$("#explainer").hidden = true;
	});
	$("#explainer-zen-close").addEventListener("click", () => {
		$("#explainer-zen").hidden = true;
	});

	$("#f-reset").addEventListener("click", resetFilters);
	$("#empty-reset").addEventListener("click", resetFilters);
}

function resetFilters() {
	STATE.filters = {
		search: "",
		plans: new Set(["go", "zen", "free"]),
		showActive: true,
		showDeprecated: false,
		labs: new Set(),
		minContext: 0,
		maxContext: null,
		minOutputPrice: 0,
		maxOutputPrice: MAX_OUTPUT_PRICE,
		reasoning: false,
		tools: false,
		structured: false,
		attachment: false,
		openWeights: false,
		sort: { field: "requestsMonth", dir: "desc" },
		hiddenColumns: new Set()
	};
	$("#f-search").value = "";
	$("#f-plan-go").checked = true;
	$("#f-plan-zen").checked = true;
	$("#f-plan-free").checked = true;
	$("#f-active").checked = true;
	$("#f-legacy").checked = false;
	$("#f-context-min").value = "0";
	$("#f-context-max").value = "";
	$("#f-output-min").value = "";
	$("#f-output-max").value = "";
	$("#f-reasoning").checked = false;
	$("#f-tools").checked = false;
	$("#f-structured").checked = false;
	$("#f-attachment").checked = false;
	$("#f-open").checked = false;
	$$("[data-lab]").forEach((b) => b.setAttribute("aria-pressed", "false"));
	applyAndRender();
}

function togglePlan(plan, on) {
	if (on) STATE.filters.plans.add(plan);
	else STATE.filters.plans.delete(plan);
}

function clearFilter(k) {
	if (k === "search") {
		STATE.filters.search = "";
		$("#f-search").value = "";
	} else if (k === "plans") {
		STATE.filters.plans = new Set(["go", "zen", "free"]);
		$("#f-plan-go").checked = true;
		$("#f-plan-zen").checked = true;
		$("#f-plan-free").checked = true;
	} else if (k === "plan:go,plan:zen") {
		togglePlan("go", true);
		togglePlan("zen", true);
		$("#f-plan-go").checked = true;
		$("#f-plan-zen").checked = true;
	} else if (k === "plan:go,plan:free") {
		togglePlan("go", true);
		togglePlan("free", true);
		$("#f-plan-go").checked = true;
		$("#f-plan-free").checked = true;
	} else if (k === "plan:zen,plan:free") {
		togglePlan("zen", true);
		togglePlan("free", true);
		$("#f-plan-zen").checked = true;
		$("#f-plan-free").checked = true;
	} else if (k === "statuses") {
		STATE.filters.showActive = true;
		STATE.filters.showDeprecated = false;
		$("#f-active").checked = true;
		$("#f-legacy").checked = false;
	} else if (k.startsWith("status:")) {
		const s = k.slice(7);
		if (s === "active") {
			STATE.filters.showActive = false;
			$("#f-active").checked = false;
		} else if (s === "deprecated") {
			STATE.filters.showDeprecated = false;
			$("#f-legacy").checked = false;
		}
	} else if (k === "contextMin") {
		STATE.filters.minContext = 0;
		$("#f-context-min").value = "0";
	} else if (k === "contextMax") {
		STATE.filters.maxContext = null;
		$("#f-context-max").value = "";
	} else if (k === "outputPriceMin") {
		STATE.filters.minOutputPrice = 0;
		$("#f-output-min").value = "";
	} else if (k === "outputPrice") {
		STATE.filters.maxOutputPrice = MAX_OUTPUT_PRICE;
		$("#f-output-max").value = "";
	} else if (k.startsWith("lab:")) {
		const lab = k.slice(4);
		STATE.filters.labs.delete(lab);
		$(`[data-lab="${lab}"]`)?.setAttribute("aria-pressed", "false");
	} else {
		STATE.filters[k] = false;
		const el = $(`#f-${k}`);
		if (el) el.checked = false;
	}
}

function applyQuickPick(name) {
	const set = (patch) => {
		for (const [k, v] of Object.entries(patch)) STATE.filters[k] = v;
	};
	clearFilter("search");
	clearFilter("contextMin");
	clearFilter("contextMax");
	clearFilter("outputPriceMin");
	clearFilter("outputPrice");
	clearFilter("statuses");
	clearFilter("reasoning");
	clearFilter("tools");
	clearFilter("structured");
	clearFilter("attachment");
	clearFilter("openWeights");
	clearFilter("plans");
	STATE.filters.labs.clear();
	$$("[data-lab]").forEach((b) => b.setAttribute("aria-pressed", "false"));

	switch (name) {
		case "premium":
			set({
				showActive: true,
				showDeprecated: false,
				reasoning: true,
				openWeights: false,
				minOutputPrice: 0,
				maxOutputPrice: MAX_OUTPUT_PRICE,
				sort: { field: "score", dir: "desc" }
			});
			STATE.filters.minContext = 512000;
			$("#f-context-min").value = "512000";
			break;
		case "workhorse":
			set({
				showActive: true,
				showDeprecated: false,
				minOutputPrice: 0,
				maxOutputPrice: 1.5,
				sort: { field: "requestsMonth", dir: "desc" }
			});
			$("#f-output-max").value = "1.5";
			break;
		case "longctx":
			set({ showActive: true, showDeprecated: false, sort: { field: "context", dir: "desc" } });
			STATE.filters.minContext = 1000000;
			$("#f-context-min").value = "1000000";
			break;
		case "budget":
			set({ showActive: true, showDeprecated: false, sort: { field: "outputCost", dir: "asc" } });
			STATE.filters.maxOutputPrice = 1;
			$("#f-output-max").value = "1";
			break;
		case "allround":
			set({
				showActive: true,
				showDeprecated: false,
				reasoning: true,
				tools: true,
				sort: { field: "score", dir: "desc" }
			});
			break;
	}

	$("#f-active").checked = STATE.filters.showActive;
	$("#f-legacy").checked = STATE.filters.showDeprecated;
	$("#f-reasoning").checked = STATE.filters.reasoning;
	$("#f-tools").checked = STATE.filters.tools;
	$("#f-structured").checked = STATE.filters.structured;
	$("#f-attachment").checked = STATE.filters.attachment;
	$("#f-open").checked = STATE.filters.openWeights;
}

async function tryFetchLiveCatalog(url) {
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		const json = await res.json();
		const ids = Array.isArray(json?.data) ? json.data.map((m) => m?.id).filter(Boolean) : null;
		return ids ? new Set(ids) : null;
	} catch {
		return null;
	}
}

function isFreeModel(m) {
	const cost = m.cost || {};
	return (cost.input === 0 || cost.input == null) && (cost.output === 0 || cost.output == null);
}

async function fetchLiveSnapshot() {
	const [api, budgetsRes, liveGoIds, liveZenIds] = await Promise.all([
		fetch(LIVE.modelsDev).then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status} from ${LIVE.modelsDev}`);
			return r.json();
		}),
		fetch(budgetsUrl(), { cache: "no-store" }).then((r) => (r.ok ? r.json() : { models: {} })),
		tryFetchLiveCatalog(LIVE.goModels),
		tryFetchLiveCatalog(LIVE.zenModels)
	]);
	const goProvider = api["opencode-go"];
	const zenProvider = api["opencode"];
	if (!goProvider?.models) throw new Error("models.dev response missing opencode-go");
	const budgets = budgetsRes.models || {};

	const buildLiveModel = (id, m, plan, inLive) => {
		let status = m.status || null;
		if (plan === "go" || plan === "zen") {
			if (inLive === true) {
				status = "active";
			} else if (inLive === false) {
				status = status || "preview-or-removed";
			} else {
				status = status || "active";
			}
		} else {
			status = status || "active";
		}
		return {
			id,
			name: m.name || id,
			family: m.family || null,
			lab: labFromFamily(m.family, id),
			description: m.description || null,
			releaseDate: m.release_date || null,
			lastUpdated: m.last_updated || null,
			openWeights: !!m.open_weights,
			knowledgeCutoff: m.knowledge || null,
			modalities: {
				input: Array.isArray(m.modalities?.input) ? [...m.modalities.input].sort() : [],
				output: Array.isArray(m.modalities?.output) ? [...m.modalities.output].sort() : []
			},
			capabilities: {
				reasoning: !!m.reasoning,
				toolCall: !!m.tool_call,
				structuredOutput: !!m.structured_output,
				temperature: m.temperature !== false,
				attachment: !!m.attachment
			},
			context: m.limit?.context ?? null,
			outputLimit: m.limit?.output ?? null,
			cost: {
				input: m.cost?.input ?? null,
				output: m.cost?.output ?? null,
				cacheRead: m.cost?.cache_read ?? null,
				cacheWrite: m.cost?.cache_write ?? null
			},
			monthlyBudgetUsd: plan === "go" ? (budgets[id]?.monthlyBudgetUsd ?? null) : null,
			estimatedRequests: plan === "go" ? budgets[id]?.estimatedRequests || null : null,
			budgetNotes: plan === "go" ? budgets[id]?.notes || null : null,
			inLiveCatalog: inLive,
			plan,
			status
		};
	};

	const models = [];
	for (const [id, m] of Object.entries(goProvider.models)) {
		const inLive = liveGoIds ? liveGoIds.has(id) : null;
		models.push(buildLiveModel(id, m, "go", inLive));
	}
	if (zenProvider?.models) {
		for (const [id, m] of Object.entries(zenProvider.models)) {
			if (m.status === "deprecated") continue;
			const inLive = liveZenIds ? liveZenIds.has(id) : null;
			if (isFreeModel(m)) {
				models.push(buildLiveModel(id, m, "free", inLive));
			} else {
				models.push(buildLiveModel(id, m, "zen", inLive));
			}
		}
	}
	models.sort((a, b) => {
		const planOrder = { go: 0, zen: 1, free: 2 };
		if (planOrder[a.plan] !== planOrder[b.plan]) return planOrder[a.plan] - planOrder[b.plan];
		const order = { active: 0, legacy: 1, "preview-or-removed": 2, deprecated: 3 };
		if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
		return (b.releaseDate || "").localeCompare(a.releaseDate || "");
	});
	return { models, liveCatalogReached: liveGoIds !== null, zenLiveCatalogReached: liveZenIds !== null };
}

async function refreshFromNetwork() {
	const btn = $("#btn-refresh");
	btn.disabled = true;
	btn.classList.add("skeleton");
	try {
		const { models, liveCatalogReached, zenLiveCatalogReached } = await fetchLiveSnapshot();
		if (!liveCatalogReached || !zenLiveCatalogReached) {
			await loadSnapshot({ liveCatalogReached, zenLiveCatalogReached });
			toast(`Live catalog unavailable — using cached snapshot (${STATE.data.models.length} models)`, "warn");
			return;
		}
		STATE.data = {
			fetchedAt: new Date().toISOString(),
			sources: [
				{ name: "models.dev (api.json)", url: LIVE.modelsDev },
				{ name: "OpenCode Go catalog", url: LIVE.goModels, ok: liveCatalogReached },
				{ name: "OpenCode Zen catalog", url: LIVE.zenModels, ok: zenLiveCatalogReached },
				{ name: "data/budgets.json", url: "internal/curated" }
			],
			subscription: STATE.data.subscription,
			zen: STATE.data.zen,
			models
		};
		renderLabs();
		renderKpis();
		renderBrand();
		applyAndRender();
		toast(`Refreshed · ${models.length} models`, "ok");
	} catch (e) {
		console.error(e);
		toast(`Refresh failed: ${e.message}. Using cached snapshot.`, "error");
	} finally {
		btn.disabled = false;
		btn.classList.remove("skeleton");
	}
}

function showBootError(msg) {
	$("#boot-error-msg").textContent = msg;
	$("#boot-error").hidden = false;
	$("#boot-error-retry").onclick = () => {
		$("#boot-error").hidden = true;
		init();
	};
	$("#boot-error-network").onclick = async () => {
		$("#boot-error").hidden = true;
		const btn = $("#btn-refresh");
		btn.disabled = true;
		btn.classList.add("skeleton");
		try {
			const { models, liveCatalogReached, zenLiveCatalogReached } = await fetchLiveSnapshot();
			STATE.data = {
				fetchedAt: new Date().toISOString(),
				sources: [
					{ name: "models.dev (api.json)", url: LIVE.modelsDev },
					{ name: "OpenCode Go catalog", url: LIVE.goModels, ok: liveCatalogReached },
					{ name: "OpenCode Zen catalog", url: LIVE.zenModels, ok: zenLiveCatalogReached },
					{ name: "data/budgets.json", url: "internal/curated" }
				],
				subscription: {
					monthlyUsd: 10,
					limitUsd: { fiveHours: 12, weekly: 30, monthly: 60 }
				},
				zen: {
					billing: "Pay-as-you-go at the listed per-1M-token rates; optional monthly limits and auto-reload.",
					docs: "https://opencode.ai/docs/zen/"
				},
				models
			};
			boot();
		} catch (e) {
			showBootError(`Network refresh failed: ${e.message}`);
			btn.disabled = false;
			btn.classList.remove("skeleton");
		}
	};
}

function boot() {
	loadHiddenColumns();
	renderLabs();
	renderKpis();
	renderBrand();
	bindFilters();
	bindKpis();
	applyAndRender();
	$("#btn-refresh").addEventListener("click", refreshFromNetwork);
}

async function loadSnapshot(meta) {
	const url = snapshotUrl();
	const res = await fetch(url, { cache: "no-store" });
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
	const json = await res.json();
	if (!json?.models || !Array.isArray(json.models)) {
		throw new Error("snapshot is missing the models array");
	}
	if (meta) {
		json.sources = (json.sources || []).map((s) =>
			s.name === "OpenCode Go catalog"
				? { ...s, ok: meta.liveCatalogReached }
				: s.name === "OpenCode Zen catalog"
					? { ...s, ok: meta.zenLiveCatalogReached }
					: s
		);
	}
	STATE.data = json;
	renderLabs();
	renderKpis();
	renderBrand();
	applyAndRender();
}

async function init() {
	try {
		await loadSnapshot();
	} catch (e) {
		console.error(e);
		showBootError(`Could not load ${snapshotUrl()}: ${e.message}`);
		return;
	}
	boot();
}

init();
