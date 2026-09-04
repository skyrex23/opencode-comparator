#!/usr/bin/env node
/**
 * Fetch OpenCode Go model metadata from public sources and merge it with the
 * curated subscription-budget data in data/budgets.json. Output: data/models.json
 *
 * Sources:
 *   - https://models.dev/api.json                       (model specs, pricing, capabilities)
 *   - https://opencode.ai/zen/go/v1/models              (live Go catalog, created timestamps)
 *   - data/budgets.json                                 (Go per-model monthly allocations)
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "data", "models.json");

const MODELS_DEV_API = "https://models.dev/api.json";
const OPENCODE_GO_MODELS = "https://opencode.ai/zen/go/v1/models";
const BUDGETS_FILE = resolve(ROOT, "data", "budgets.json");

const FETCH_TIMEOUT_MS = 20000;

async function fetchJson(url) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			headers: { Accept: "application/json", "User-Agent": "opencode-go-comparator/0.1" }
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
		}
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
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

function cleanNumber(n) {
	if (n == null || Number.isNaN(n)) return null;
	return n;
}

function normalizeModalities(m) {
	if (!m) return { input: [], output: [] };
	return {
		input: Array.isArray(m.input) ? [...m.input].sort() : [],
		output: Array.isArray(m.output) ? [...m.output].sort() : []
	};
}

function buildSnapshot() {
	return {
		fetchedAt: new Date().toISOString(),
		sources: [
			{ name: "models.dev (api.json)", url: MODELS_DEV_API },
			{ name: "OpenCode Go catalog", url: OPENCODE_GO_MODELS },
			{ name: "data/budgets.json", url: "internal/curated" }
		],
		subscription: {
			monthlyUsd: 10,
			limitUsd: { fiveHours: 12, weekly: 30, monthly: 60 },
			billing: "Dollar-metered; per-model monthly allocation may be lower than the $60 cap.",
			docs: "https://opencode.ai/docs/go/"
		},
		models: []
	};
}

function isFree(m) {
	const cost = m.cost || {};
	return (cost.input === 0 || cost.input == null) && (cost.output === 0 || cost.output == null);
}

function buildModel(m, opts) {
	const { plan, inLiveCatalog, budget } = opts;
	const limit = m.limit || {};
	const cost = m.cost || {};
	const caps = {
		reasoning: !!m.reasoning,
		toolCall: !!m.tool_call,
		structuredOutput: !!m.structured_output,
		temperature: m.temperature !== false,
		attachment: !!m.attachment
	};
	const modalities = normalizeModalities(m.modalities);
	const estimatedRequests = budget.estimatedRequests || null;
	const monthlyBudgetUsd = budget.monthlyBudgetUsd ?? null;
	const budgetNotes = budget.notes || null;

	let status = m.status || null;
	if (plan === "go") {
		if (inLiveCatalog && status !== "deprecated") status = "active";
		else if (inLiveCatalog) status = "active";
		else status = status || "preview-or-removed";
	} else {
		status = status || "active";
	}

	return {
		id: m.id,
		name: m.name || m.id,
		family: m.family || null,
		lab: labFromFamily(m.family, m.id),
		description: m.description || null,
		releaseDate: m.release_date || null,
		lastUpdated: m.last_updated || null,
		openWeights: !!m.open_weights,
		knowledgeCutoff: m.knowledge || null,
		modalities,
		capabilities: caps,
		context: cleanNumber(limit.context),
		outputLimit: cleanNumber(limit.output),
		cost: {
			input: cleanNumber(cost.input),
			output: cleanNumber(cost.output),
			cacheRead: cleanNumber(cost.cache_read),
			cacheWrite: cleanNumber(cost.cache_write)
		},
		monthlyBudgetUsd,
		estimatedRequests,
		budgetNotes,
		inLiveCatalog,
		plan,
		status
	};
}

async function main() {
	const out = buildSnapshot();

	const [apiAll, ocCatalog, budgetsRaw] = await Promise.all([
		fetchJson(MODELS_DEV_API),
		fetchJson(OPENCODE_GO_MODELS),
		import(BUDGETS_FILE, { with: { type: "json" } }).then((m) => m.default)
	]);

	const goProvider = apiAll["opencode-go"];
	if (!goProvider || !goProvider.models) {
		throw new Error('models.dev api.json is missing the "opencode-go" provider.');
	}
	const freeProvider = apiAll["opencode"];
	const liveIds = new Set(ocCatalog.data.map((m) => m.id));

	const budgets = budgetsRaw.models || {};

	const models = [];
	for (const [id, m] of Object.entries(goProvider.models)) {
		models.push(buildModel(m, { plan: "go", inLiveCatalog: liveIds.has(id), budget: budgets[id] || {} }));
	}
	if (freeProvider && freeProvider.models) {
		for (const [id, m] of Object.entries(freeProvider.models)) {
			if (!isFree(m)) continue;
			if (m.status === "deprecated") continue;
			models.push(buildModel(m, { plan: "free", inLiveCatalog: false, budget: {} }));
		}
	}

	models.sort((a, b) => {
		const planOrder = { go: 0, free: 1 };
		if (planOrder[a.plan] !== planOrder[b.plan]) return planOrder[a.plan] - planOrder[b.plan];
		const statusOrder = { active: 0, legacy: 1, "preview-or-removed": 2, deprecated: 3 };
		const sa = statusOrder[a.status] ?? 9;
		const sb = statusOrder[b.status] ?? 9;
		if (sa !== sb) return sa - sb;
		const ar = a.releaseDate || "";
		const br = b.releaseDate || "";
		if (ar !== br) return br.localeCompare(ar);
		return a.id.localeCompare(b.id);
	});

	out.models = models;

	await mkdir(dirname(OUT), { recursive: true });
	await writeFile(OUT, `${JSON.stringify(out, null, "\t")}\n`, "utf8");

	const counts = models.reduce((acc, m) => ((acc[`${m.plan}:${m.status}`] = (acc[`${m.plan}:${m.status}`] || 0) + 1), acc), {});
	console.log(`Wrote ${OUT}\n` + `  models total: ${models.length}\n` + `  plan:status counts: ${JSON.stringify(counts)}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
