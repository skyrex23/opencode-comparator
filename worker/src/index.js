/**
 * CORS proxy + per-IP refresh cooldown for the OpenCode Comparator.
 *
 * Routes (only these — not an open proxy):
 *   GET /models-dev  -> https://models.dev/api.json
 *   GET /go/models   -> https://opencode.ai/zen/go/v1/models
 *   GET /zen/models  -> https://opencode.ai/zen/v1/models
 *
 * Each request is gated by a per-IP cooldown stored in the `LIMITS` KV namespace.
 * The cooldown mirrors the front-end policy (`REFRESH_COOLDOWN_OK_MS` /
 * `REFRESH_COOLDOWN_FAIL_MS` in src/app.js): 30 s after a successful upstream
 * fetch, 5 s after a failure. When a request hits the gate, the Worker returns
 * `429 Too Many Requests` with a `Retry-After` header so the browser can sync
 * its local countdown to the server's view.
 *
 * If the KV binding is missing (e.g. before the namespace is provisioned) the
 * gate is a no-op and the Worker still proxies the three routes normally.
 */

const COOLDOWN_OK_MS = 30_000;
const COOLDOWN_FAIL_MS = 5_000;
const KV_TTL_SECONDS = 120;

const ROUTES = {
	"/models-dev": "https://models.dev/api.json",
	"/go/models": "https://opencode.ai/zen/go/v1/models",
	"/zen/models": "https://opencode.ai/zen/v1/models"
};

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Max-Age": "86400",
	"Cache-Control": "public, max-age=300"
};

function cooldownMs(ok) {
	return ok ? COOLDOWN_OK_MS : COOLDOWN_FAIL_MS;
}

function clientIp(request) {
	return (
		request.headers.get("CF-Connecting-IP") ||
		request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ||
		"unknown"
	);
}

async function readCooldown(ip, env) {
	if (!env?.LIMITS) return null;
	try {
		const raw = await env.LIMITS.get(ip, { type: "json" });
		return raw && typeof raw.ts === "number" && typeof raw.ok === "boolean" ? raw : null;
	} catch {
		// KV unavailable — fail open. The front-end gate is still in place.
		return null;
	}
}

function gate(last) {
	if (!last) return { allowed: true };
	const cd = cooldownMs(last.ok);
	const msLeft = cd - (Date.now() - last.ts);
	if (msLeft <= 0) return { allowed: true };
	return { allowed: false, msLeft, ok: last.ok };
}

async function recordOutcome(ip, ok, env, ctx) {
	if (!env?.LIMITS) return;
	const payload = JSON.stringify({ ts: Date.now(), ok });
	const write = env.LIMITS.put(ip, payload, { expirationTtl: KV_TTL_SECONDS });
	// Best-effort, non-blocking. Even if the write never reaches KV (rare), the
	// front-end still gates the user and the next request will recreate the record.
	if (ctx?.waitUntil) ctx.waitUntil(write);
	else await write;
}

function jsonResponse(status, body, extraHeaders = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders }
	});
}

function tooManyRequests(msLeft) {
	const retryAfter = Math.max(1, Math.ceil(msLeft / 1000));
	return jsonResponse(
		429,
		{ error: "Refresh cooldown", msLeft, retryAfter },
		{ "Retry-After": retryAfter.toString() }
	);
}

export default {
	async fetch(request, env, ctx) {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		const target = ROUTES[url.pathname];
		if (!target) {
			return jsonResponse(404, {
				error: `Unknown route "${url.pathname}".`,
				available: Object.keys(ROUTES)
			});
		}

		const ip = clientIp(request);
		const last = await readCooldown(ip, env);
		const g = gate(last);
		if (!g.allowed) {
			return tooManyRequests(g.msLeft);
		}

		let upstream;
		try {
			upstream = await fetch(target, {
				headers: { Accept: "application/json", "User-Agent": "opencode-comparator-cors/1.0" }
			});
		} catch (e) {
			await recordOutcome(ip, false, env, ctx);
			return jsonResponse(502, { error: `Upstream fetch failed: ${e.message}` });
		}

		// Read the body, then record the outcome. We record `upstream.ok` so a 5xx
		// upstream counts as a failed refresh and locks the IP for the shorter window.
		const body = await upstream.text();
		await recordOutcome(ip, upstream.ok, env, ctx);

		return new Response(body, {
			status: upstream.status,
			headers: {
				...CORS_HEADERS,
				"Content-Type": upstream.headers.get("content-type") || "application/json"
			}
		});
	}
};
