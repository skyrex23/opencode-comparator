#!/usr/bin/env node
/**
 * Tiny static file server for local development.
 *
 * Routing:
 *   GET /                  -> src/index.html
 *   GET /styles.css        -> src/styles.css
 *   GET /app.js            -> src/app.js
 *   GET /data/models.json  -> data/models.json
 *   GET /data/budgets.json -> data/budgets.json
 *
 * Anything under /src/ is served from src/; anything under /data/ is served
 * from data/. This way the HTML can use relative paths like "./styles.css"
 * while we still keep the project organised.
 */

import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "127.0.0.1";

const TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8"
};

function resolveFile(path) {
	const cleaned = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, "");
	let rel;
	if (cleaned === "") {
		rel = "src/index.html";
	} else if (cleaned.startsWith("data/") || cleaned.startsWith("scripts/") || cleaned.startsWith("src/")) {
		rel = cleaned;
	} else {
		rel = `src/${cleaned}`;
	}
	const full = resolve(join(ROOT, rel));
	if (!full.startsWith(ROOT + sep) && full !== ROOT) return null;
	return full;
}

function send(res, status, body, headers = {}) {
	res.writeHead(status, { "Cache-Control": "no-store", ...headers });
	res.end(body);
}

const server = createServer((req, res) => {
	if (req.method !== "GET" && req.method !== "HEAD") {
		return send(res, 405, "Method Not Allowed");
	}
	const path = req.url.split("?")[0] || "/";
	const file = resolveFile(path);
	if (!file) return send(res, 400, "Bad path");

	try {
		const st = statSync(file);
		const target = st.isDirectory() ? join(file, "index.html") : file;
		const st2 = statSync(target);
		const type = TYPES[extname(target).toLowerCase()] || "application/octet-stream";
		res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
		if (req.method === "HEAD") return res.end();
		createReadStream(target).pipe(res);
	} catch {
		send(res, 404, "Not Found");
	}
});

server.listen(PORT, HOST, () => {
	console.log(`Serving ${ROOT}`);
	console.log(`Open http://${HOST}:${PORT}/ in your browser.`);
});
