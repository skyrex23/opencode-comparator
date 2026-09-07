/**
 * Tiny CORS proxy for the OpenCode catalogs the comparator uses to mark
 * active vs legacy models. opencode.ai does not send Access-Control-Allow-Origin
 * headers, so the browser blocks those fetches from any third-party origin
 * (including GitHub Pages). This Worker mirrors the two endpoints and adds the
 * CORS headers the browser needs.
 *
 * Routes:
 *   GET /go/models  -> https://opencode.ai/zen/go/v1/models
 *   GET /zen/models -> https://opencode.ai/zen/v1/models
 *
 * Anything else returns 404.
 */

const ROUTES = {
	"/go/models": "https://opencode.ai/zen/go/v1/models",
	"/zen/models": "https://opencode.ai/zen/v1/models"
};

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Max-Age": "86400",
	"Cache-Control": "public, max-age=300"
};

export default {
	async fetch(request) {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		const target = ROUTES[url.pathname];
		if (!target) {
			return jsonResponse(404, `Unknown route "${url.pathname}". Available: ${Object.keys(ROUTES).join(", ")}`);
		}

		let upstream;
		try {
			upstream = await fetch(target, {
				headers: { Accept: "application/json", "User-Agent": "opencode-comparator-cors/1.0" }
			});
		} catch (e) {
			return jsonResponse(502, `Upstream fetch failed: ${e.message}`);
		}

		const body = await upstream.text();
		return new Response(body, {
			status: upstream.status,
			headers: {
				...CORS_HEADERS,
				"Content-Type": upstream.headers.get("content-type") || "application/json"
			}
		});
	}
};

function jsonResponse(status, message) {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
	});
}
