/**
 * OpenCode Go Comparator
 *
 * Loads the snapshot from data/models.json, renders a sortable/filterable table
 * (and an alternate card grid) of every Go model with its price, context,
 * capabilities and value for coding. Up to 4 rows can be pinned for a
 * side-by-side comparison.
 *
 * The header "Refresh data" button re-fetches the live OpenCode Go catalog and
 * models.dev metadata in the browser and rebuilds the UI without a reload.
 */

const ORIGIN = typeof window !== "undefined" ? window.location.origin : "";

function snapshotUrl() {
	return `${ORIGIN}/data/models.json`;
}

function budgetsUrl() {
	return `${ORIGIN}/data/budgets.json`;
}

const LIVE = {
	models: "https://opencode.ai/zen/go/v1/models",
	modelsDev: "https://models.dev/api.json"
};

const STATE = {
	data: null,
	view: "table",
	filtered: [],
	selected: new Set(),
	filters: {
		search: "",
		activeOnly: true,
		includeLegacy: false,
		labs: new Set(),
		minContext: 0,
		maxOutputPrice: 15,
		reasoning: false,
		tools: false,
		structured: false,
		attachment: false,
		openWeights: false,
		sort: "requestsMonth-desc"
	}
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmt = {
	money(n) {
		if (n == null) return "—";
		if (n === 0) return "$0";
		if (n < 0.01) return `$${n.toFixed(4)}`;
		if (n < 1) return `$${n.toFixed(3)}`;
		return `$${n.toFixed(2)}`;
	},
	tokens(n) {
		if (n == null) return "—";
		const r = Math.round(n / 50000) * 50000;
		if (r >= 1_000_000) return `${(r / 1_000_000).toFixed(r % 1_000_000 === 0 ? 0 : 2)}M`;
		if (r >= 1000) return `${Math.round(r / 1000)}K`;
		return String(r);
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

function valueScore(m) {
	if (m.cost?.output == null) return 0;
	const outCost = m.cost.output;
	const requests = m.estimatedRequests?.monthly ?? 0;
	const context = m.context ?? 0;
	const reasoningBoost = m.capabilities?.reasoning ? 1.25 : 1;
	const outputTokensPerDollar = 1_000_000 / Math.max(outCost, 0.0001);
	const contextBonus = Math.log10(Math.max(context, 1000)) / 6;
	const requestBonus = requests > 0 ? Math.log10(requests) / 5 : 0;
	const score = (outputTokensPerDollar / 1000) * 0.6 + contextBonus * 30 + requestBonus * 40;
	return score * reasoningBoost;
}

function valueTier(score) {
	if (score >= 80) return "high";
	if (score >= 40) return "mid";
	return "low";
}

function labFromFamily(family, modelId) {
	const f = (family || "").toLowerCase();
	if (f.startsWith("kimi")) return "Moonshot AI";
	if (f.startsWith("qwen")) return "Alibaba";
	if (f.startsWith("glm")) return "Zhipu AI";
	if (f.startsWith("mimo")) return "Xiaomi";
	if (f.startsWith("minimax")) return "MiniMax";
	if (f.startsWith("deepseek")) return "DeepSeek";
	if (f.startsWith("longcat")) return "Meituan";
	if (f.startsWith("hy")) return "Tencent";
	if (f.startsWith("grok")) return "xAI";
	if (f.startsWith("gpt") || modelId.includes("gpt-")) return "OpenAI";
	if (f.startsWith("muse")) return "Meta";
	if (f.startsWith("ox")) return "xAI";
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

function valueCell(m) {
	const score = valueScore(m);
	const tier = valueTier(score);
	const pct = Math.min(100, (score / 120) * 100);
	return `<div class="value-cell">
		<span class="value-cell__score value-cell__score--${tier}">${score.toFixed(0)}</span>
		<span class="value-cell__bar"><span class="value-cell__bar-fill value-cell__bar-fill--${tier}" style="width:${pct}%"></span></span>
	</div>`;
}

function rowHTML(m) {
	const req = m.estimatedRequests || {};
	const selected = STATE.selected.has(m.id) ? "is-selected" : "";
	const legacyCls = m.status === "legacy" ? "is-legacy" : m.status === "deprecated" ? "is-deprecated" : "";
	return `
		<tr class="${selected} ${legacyCls}" data-id="${m.id}">
			<td class="th-check"><input type="checkbox" data-cmp="${m.id}" ${STATE.selected.has(m.id) ? "checked" : ""} /></td>
			<td class="th-model">
				<div class="model-cell">
					<span class="model-cell__name" data-detail="${m.id}">${m.name}</span>
					<span class="model-cell__meta">
						${statusTag(m)} ${weightsTag(m)}
						<span class="dot">·</span>
						<span>${m.lab || "—"}</span>
						${m.releaseDate ? `<span class="dot">·</span><span>${fmt.date(m.releaseDate)}</span>` : ""}
					</span>
				</div>
			</td>
			<td class="num ${m.cost?.input != null ? "" : "num--dim"}">${fmt.money(m.cost?.input)}</td>
			<td class="num ${m.cost?.output != null ? "" : "num--dim"}">${fmt.money(m.cost?.output)}</td>
			<td class="num ${m.cost?.cacheRead != null ? "" : "num--dim"}">${fmt.money(m.cost?.cacheRead)}</td>
			<td>${contextBar(m)}</td>
			<td>${tierTag(m)}</td>
			<td class="num ${req.monthly ? "num--strong" : "num--dim"}">${req.monthly?.toLocaleString() ?? "—"}</td>
			<td><div class="caps">${capabilityIcons(m)}</div></td>
			<td>${valueCell(m)}</td>
		</tr>`;
}

function cardHTML(m) {
	const req = m.estimatedRequests || {};
	const selected = STATE.selected.has(m.id) ? "is-selected" : "";
	const legacyCls = m.status === "legacy" ? "is-legacy" : m.status === "deprecated" ? "is-deprecated" : "";
	const score = valueScore(m);
	return `
		<article class="card ${selected} ${legacyCls}" data-id="${m.id}">
			<div class="card__head">
				<div>
					<div class="card__title" data-detail="${m.id}">${m.name}</div>
					<div class="card__lab">${m.lab || "—"} · ${m.id}</div>
				</div>
				<div class="card__tags">${statusTag(m)} ${weightsTag(m)}</div>
			</div>
			${m.description ? `<p class="card__desc">${m.description}</p>` : ""}
			<div class="card__metrics">
				<div class="card__metric">
					<span class="card__metric-label">In $ / 1M</span>
					<span class="card__metric-value">${fmt.money(m.cost?.input)}</span>
				</div>
				<div class="card__metric">
					<span class="card__metric-label">Out $ / 1M</span>
					<span class="card__metric-value card__metric-value--accent">${fmt.money(m.cost?.output)}</span>
				</div>
				<div class="card__metric">
					<span class="card__metric-label">Context</span>
					<span class="card__metric-value">${fmt.tokens(m.context)}</span>
				</div>
				<div class="card__metric">
					<span class="card__metric-label">Req / mo</span>
					<span class="card__metric-value">${req.monthly?.toLocaleString() ?? "—"}</span>
				</div>
			</div>
			<div class="card__metrics-row">
				<div class="card__caps">${capabilityIcons(m)}</div>
				<div class="value-cell">
					<span class="value-cell__score value-cell__score--${valueTier(score)}">Value ${score.toFixed(0)}</span>
				</div>
			</div>
			<div class="card__actions">
				${tierTag(m)}
				<button class="btn btn--ghost btn--small" data-detail="${m.id}" type="button" style="margin-left:auto">Details</button>
			</div>
		</article>`;
}

function applyFilters() {
	const f = STATE.filters;
	const q = f.search.trim().toLowerCase();
	let arr = STATE.data.models.filter((m) => {
		if (f.activeOnly && m.status !== "active") return false;
		if (!f.activeOnly && !f.includeLegacy && m.status === "legacy") return false;
		if (!f.includeLegacy && m.status === "deprecated") return false;
		if (f.includeLegacy && m.status === "deprecated") return true;
		if (q) {
			const hay = `${m.name} ${m.id} ${m.lab} ${m.family || ""}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		if (f.labs.size > 0 && !f.labs.has(m.lab)) return false;
		if (f.minContext > 0 && (m.context || 0) < f.minContext) return false;
		if (f.maxOutputPrice < 15 && (m.cost?.output ?? 0) > f.maxOutputPrice) return false;
		if (f.reasoning && !m.capabilities?.reasoning) return false;
		if (f.tools && !m.capabilities?.toolCall) return false;
		if (f.structured && !m.capabilities?.structuredOutput) return false;
		if (f.attachment && !m.capabilities?.attachment) return false;
		if (f.openWeights && !m.openWeights) return false;
		return true;
	});

	const [field, dir] = f.sort.split("-");
	const sign = dir === "asc" ? 1 : -1;
	arr.sort((a, b) => {
		let va, vb;
		switch (field) {
			case "outputCost":
				va = a.cost?.output ?? Infinity;
				vb = b.cost?.output ?? Infinity;
				break;
			case "inputCost":
				va = a.cost?.input ?? Infinity;
				vb = b.cost?.input ?? Infinity;
				break;
			case "context":
				va = a.context ?? 0;
				vb = b.context ?? 0;
				break;
			case "releaseDate":
				va = a.releaseDate || "";
				vb = b.releaseDate || "";
				break;
			case "requestsMonth":
				va = a.estimatedRequests?.monthly ?? 0;
				vb = b.estimatedRequests?.monthly ?? 0;
				break;
			case "valueScore":
				va = valueScore(a);
				vb = valueScore(b);
				break;
			default:
				va = a.id;
				vb = b.id;
		}
		if (va < vb) return -1 * sign;
		if (va > vb) return 1 * sign;
		return a.id.localeCompare(b.id);
	});

	STATE.filtered = arr;
}

function renderTable() {
	const body = $("#models-body");
	body.innerHTML = STATE.filtered.map(rowHTML).join("");
}

function renderCards() {
	const host = $("#cards-wrap");
	host.innerHTML = STATE.filtered.map(cardHTML).join("");
}

function render() {
	const empty = STATE.filtered.length === 0;
	$("#empty").hidden = !empty;
	$("#table-wrap").hidden = empty || STATE.view !== "table";
	$("#cards-wrap").hidden = empty || STATE.view !== "cards";

	if (!empty) {
		if (STATE.view === "table") renderTable();
		else renderCards();
	}

	$("#result-count").textContent = `${STATE.filtered.length} of ${STATE.data.models.length} models`;
	renderPills();
	renderCompareBar();
	updateSortHeader();
	bindRowEvents();
}

function updateSortHeader() {
	const current = STATE.filters.sort;
	$$("th[data-sort]").forEach((th) => {
		const v = th.getAttribute("data-sort");
		th.classList.toggle("is-sorted", v === current);
		th.classList.toggle("is-asc", v === current && v.endsWith("-asc"));
	});
}

function renderPills() {
	const f = STATE.filters;
	const pills = [];
	if (f.search) pills.push({ k: "search", label: `q: ${f.search}` });
	if (!f.activeOnly) pills.push({ k: "activeOnly", label: "show all" });
	if (f.includeLegacy) pills.push({ k: "includeLegacy", label: "+ deprecated" });
	for (const lab of f.labs) pills.push({ k: `lab:${lab}`, label: lab });
	if (f.minContext > 0) pills.push({ k: "context", label: `ctx ≥ ${fmt.tokens(f.minContext)}` });
	if (f.maxOutputPrice < 15) pills.push({ k: "outputPrice", label: `out ≤ ${fmt.money(f.maxOutputPrice)}` });
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
	const totalReqMonth = active.reduce((sum, m) => sum + (m.estimatedRequests?.monthly || 0), 0);
	const cheapest = active
		.filter((m) => m.cost?.output != null)
		.reduce((min, m) => (m.cost.output < min.cost.output ? m : min), active[0] || {});
	const monthlyUsd = STATE.data.subscription.monthlyUsd;
	const usageUsd = STATE.data.subscription.limitUsd.monthly;

	const kpis = [
		{
			label: "Subscription",
			value: `$${monthlyUsd}`,
			sub: `${usageUsd / monthlyUsd}× value in included usage`,
			accent: true
		},
		{ label: "Active models", value: String(active.length), sub: `${STATE.data.models.length} total in catalog` },
		{
			label: "Reusable usage",
			value: `$${usageUsd}`,
			sub: "of OpenCode Go credit per month"
		},
		{
			label: "Cheapest output",
			value: cheapest?.cost?.output != null ? fmt.money(cheapest.cost.output) : "—",
			sub: cheapest?.name || "—"
		}
	];
	const host = $("#hero-kpis");
	host.innerHTML = kpis
		.map(
			(k) => `
			<div class="kpi">
				<div class="kpi__label">${k.label}</div>
				<div class="kpi__value ${k.accent ? "kpi__value--accent" : ""}">${k.value}</div>
				${k.sub ? `<div class="kpi__sub">${k.sub}</div>` : ""}
			</div>`
		)
		.join("");
}

function renderBrand() {
	const active = STATE.data.models.filter((m) => m.status === "active").length;
	$("#brand-sub").textContent =
		`${active} active models · $${STATE.data.subscription.monthlyUsd}/mo · updated ${fmt.datetime(STATE.data.fetchedAt)}`;
	$("#footer-time").textContent = fmt.datetime(STATE.data.fetchedAt);
}

function applyAndRender() {
	applyFilters();
	render();
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
				<h3>Value score</h3>
				<div class="num-big">${valueScore(m).toFixed(0)}</div>
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
		${m.status === "deprecated" || m.status === "legacy" ? `<p style="margin-top:12px;font-size:12px;color:var(--text-dim);">This model is not in the curated "active" lineup — it may still work via the API but is not promoted on the official Go docs.</p>` : ""}
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
		{ label: "Value score", pick: (m) => valueScore(m).toFixed(0), bestFn: (m) => valueScore(m), bestDir: "max" }
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
	$("#f-active").addEventListener("change", (e) => {
		STATE.filters.activeOnly = e.target.checked;
		applyAndRender();
	});
	$("#f-legacy").addEventListener("change", (e) => {
		STATE.filters.includeLegacy = e.target.checked;
		applyAndRender();
	});
	$("#f-context").addEventListener("input", (e) => {
		STATE.filters.minContext = Number(e.target.value);
		$("#f-context-out").textContent = STATE.filters.minContext ? fmt.tokens(STATE.filters.minContext) : "any";
		applyAndRender();
	});
	$("#f-max-output-price").addEventListener("input", (e) => {
		const v = Number(e.target.value);
		STATE.filters.maxOutputPrice = v >= 15 ? 15 : v;
		$("#f-max-output-price-out").textContent = v >= 15 ? "any" : `$${v.toFixed(2)}`;
		applyAndRender();
	});
	for (const id of ["reasoning", "tools", "structured", "attachment", "open"]) {
		const key = id === "tools" ? "tools" : id === "open" ? "openWeights" : id;
		$(`#f-${id}`).addEventListener("change", (e) => {
			STATE.filters[key] = e.target.checked;
			applyAndRender();
		});
	}
	$("#f-sort").addEventListener("change", (e) => {
		STATE.filters.sort = e.target.value;
		applyAndRender();
	});

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

	$$("[data-view]").forEach((btn) => {
		btn.addEventListener("click", () => {
			STATE.view = btn.getAttribute("data-view");
			$$("[data-view]").forEach((b) => {
				const active = b.getAttribute("data-view") === STATE.view;
				b.classList.toggle("is-active", active);
				b.setAttribute("aria-pressed", String(active));
			});
			render();
		});
	});

	$$("th[data-sort]").forEach((th) => {
		th.addEventListener("click", () => {
			const v = th.getAttribute("data-sort");
			const [field, dir] = v.split("-");
			const newDir = dir === "asc" ? "desc" : "asc";
			STATE.filters.sort = `${field}-${newDir}`;
			$("#f-sort").value = STATE.filters.sort;
			applyAndRender();
		});
	});

	$("#cmp-clear").addEventListener("click", () => {
		STATE.selected.clear();
		render();
	});
	$("#cmp-open").addEventListener("click", openCompare);

	$("#cta-explore").addEventListener("click", () => {
		$("#lineup").scrollIntoView({ behavior: "smooth", block: "start" });
	});
	$("#cta-how").addEventListener("click", () => {
		$("#explainer").hidden = false;
		$("#explainer").scrollIntoView({ behavior: "smooth", block: "start" });
	});
	$("#explainer-close").addEventListener("click", () => {
		$("#explainer").hidden = true;
	});

	$("#f-reset").addEventListener("click", resetFilters);
	$("#empty-reset").addEventListener("click", resetFilters);
}

function resetFilters() {
	STATE.filters = {
		search: "",
		activeOnly: true,
		includeLegacy: false,
		labs: new Set(),
		minContext: 0,
		maxOutputPrice: 15,
		reasoning: false,
		tools: false,
		structured: false,
		attachment: false,
		openWeights: false,
		sort: "requestsMonth-desc"
	};
	$("#f-search").value = "";
	$("#f-active").checked = true;
	$("#f-legacy").checked = false;
	$("#f-context").value = 0;
	$("#f-context-out").textContent = "any";
	$("#f-max-output-price").value = 15;
	$("#f-max-output-price-out").textContent = "any";
	$("#f-reasoning").checked = false;
	$("#f-tools").checked = false;
	$("#f-structured").checked = false;
	$("#f-attachment").checked = false;
	$("#f-open").checked = false;
	$("#f-sort").value = STATE.filters.sort;
	$$("[data-lab]").forEach((b) => b.setAttribute("aria-pressed", "false"));
	applyAndRender();
}

function clearFilter(k) {
	if (k === "search") {
		STATE.filters.search = "";
		$("#f-search").value = "";
	} else if (k === "activeOnly") {
		STATE.filters.activeOnly = true;
		$("#f-active").checked = true;
	} else if (k === "includeLegacy") {
		STATE.filters.includeLegacy = false;
		$("#f-legacy").checked = false;
	} else if (k === "context") {
		STATE.filters.minContext = 0;
		$("#f-context").value = 0;
		$("#f-context-out").textContent = "any";
	} else if (k === "outputPrice") {
		STATE.filters.maxOutputPrice = 15;
		$("#f-max-output-price").value = 15;
		$("#f-max-output-price-out").textContent = "any";
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
	clearFilter("context");
	clearFilter("outputPrice");
	clearFilter("activeOnly");
	clearFilter("includeLegacy");
	clearFilter("reasoning");
	clearFilter("tools");
	clearFilter("structured");
	clearFilter("attachment");
	clearFilter("openWeights");
	STATE.filters.labs.clear();
	$$("[data-lab]").forEach((b) => b.setAttribute("aria-pressed", "false"));

	switch (name) {
		case "premium":
			set({ activeOnly: true, reasoning: true, openWeights: false, maxOutputPrice: 15, sort: "valueScore-desc" });
			STATE.filters.minContext = 500000;
			$("#f-context").value = 500000;
			$("#f-context-out").textContent = "500K";
			break;
		case "workhorse":
			set({ activeOnly: true, maxOutputPrice: 1.5, sort: "requestsMonth-desc" });
			break;
		case "longctx":
			set({ activeOnly: true, sort: "context-desc" });
			STATE.filters.minContext = 1000000;
			$("#f-context").value = 1000000;
			$("#f-context-out").textContent = "1M";
			break;
		case "budget":
			set({ activeOnly: true, sort: "outputCost-asc" });
			STATE.filters.maxOutputPrice = 1;
			$("#f-max-output-price").value = 1;
			$("#f-max-output-price-out").textContent = "$1.00";
			break;
		case "allround":
			set({ activeOnly: true, reasoning: true, tools: true, sort: "valueScore-desc" });
			break;
	}

	$("#f-active").checked = STATE.filters.activeOnly;
	$("#f-legacy").checked = STATE.filters.includeLegacy;
	$("#f-reasoning").checked = STATE.filters.reasoning;
	$("#f-tools").checked = STATE.filters.tools;
	$("#f-structured").checked = STATE.filters.structured;
	$("#f-attachment").checked = STATE.filters.attachment;
	$("#f-open").checked = STATE.filters.openWeights;
	$("#f-sort").value = STATE.filters.sort;
}

async function tryFetchLiveCatalog() {
	try {
		const res = await fetch(LIVE.models);
		if (!res.ok) return null;
		const json = await res.json();
		const ids = Array.isArray(json?.data) ? json.data.map((m) => m?.id).filter(Boolean) : null;
		return ids ? new Set(ids) : null;
	} catch {
		return null;
	}
}

async function fetchLiveSnapshot() {
	const [api, budgetsRes, liveIds] = await Promise.all([
		fetch(LIVE.modelsDev).then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status} from ${LIVE.modelsDev}`);
			return r.json();
		}),
		fetch(budgetsUrl(), { cache: "no-store" }).then((r) => (r.ok ? r.json() : { models: {} })),
		tryFetchLiveCatalog()
	]);
	const provider = api["opencode-go"];
	if (!provider?.models) throw new Error("models.dev response missing opencode-go");
	const budgets = budgetsRes.models || {};
	const curatedActive = new Set(Object.keys(budgets));

	const models = [];
	for (const [id, m] of Object.entries(provider.models)) {
		const inLive = liveIds ? liveIds.has(id) : true;
		const curatedA = curatedActive.has(id);
		const status =
			curatedA && inLive ? "active" : curatedA ? "preview-or-removed" : inLive ? "legacy" : "deprecated";
		models.push({
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
			monthlyBudgetUsd: budgets[id]?.monthlyBudgetUsd ?? null,
			estimatedRequests: budgets[id]?.estimatedRequests || null,
			budgetNotes: budgets[id]?.notes || null,
			inLiveCatalog: inLive,
			curatedActive: curatedA,
			status
		});
	}
	models.sort((a, b) => {
		const order = { active: 0, legacy: 1, "preview-or-removed": 2, deprecated: 3 };
		if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
		return (b.releaseDate || "").localeCompare(a.releaseDate || "");
	});
	return { models, liveCatalogReached: liveIds !== null };
}

async function refreshFromNetwork() {
	const btn = $("#btn-refresh");
	btn.disabled = true;
	btn.classList.add("skeleton");
	try {
		const { models, liveCatalogReached } = await fetchLiveSnapshot();
		STATE.data = {
			fetchedAt: new Date().toISOString(),
			sources: [
				{ name: "models.dev (api.json)", url: LIVE.modelsDev },
				{ name: "OpenCode Go catalog", url: LIVE.models, ok: liveCatalogReached },
				{ name: "data/budgets.json", url: "internal/curated" }
			],
			subscription: STATE.data.subscription,
			models
		};
		renderLabs();
		renderKpis();
		renderBrand();
		applyAndRender();
		const note = liveCatalogReached ? "" : " · live catalog unavailable, trusted models.dev provider";
		toast(`Refreshed · ${models.length} models${note}`, "ok");
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
			const { models, liveCatalogReached } = await fetchLiveSnapshot();
			STATE.data = {
				fetchedAt: new Date().toISOString(),
				sources: [
					{ name: "models.dev (api.json)", url: LIVE.modelsDev },
					{ name: "OpenCode Go catalog", url: LIVE.models, ok: liveCatalogReached },
					{ name: "data/budgets.json", url: "internal/curated" }
				],
				subscription: {
					monthlyUsd: 10,
					limitUsd: { fiveHours: 12, weekly: 30, monthly: 60 }
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
	renderLabs();
	renderKpis();
	renderBrand();
	bindFilters();
	applyAndRender();
	$("#btn-refresh").addEventListener("click", refreshFromNetwork);
}

async function init() {
	const url = snapshotUrl();
	try {
		const res = await fetch(url, { cache: "no-store" });
		if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
		const json = await res.json();
		if (!json?.models || !Array.isArray(json.models)) {
			throw new Error("snapshot is missing the models array");
		}
		STATE.data = json;
	} catch (e) {
		console.error(e);
		showBootError(`Could not load ${url}: ${e.message}`);
		return;
	}
	boot();
}

init();
