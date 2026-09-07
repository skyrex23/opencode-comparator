#!/usr/bin/env node
/**
 * Assemble the GitHub Pages deployable artifact.
 *
 * The local dev server (`scripts/serve.mjs`) maps `/` to `src/index.html`, `/data/models.json`
 * to `data/models.json`, etc. GitHub Pages serves whatever is uploaded as-is, so we copy the
 * files into the layout the static host expects:
 *
 *   <artifact>/
 *     index.html      <- from src/index.html
 *     styles.css      <- from src/styles.css
 *     app.js          <- from src/app.js
 *     data/
 *       models.json   <- from data/models.json
 *       budgets.json  <- from data/budgets.json
 *
 * The HTML already references `./styles.css` and `./app.js`, and `app.js` reads the data files
 * from `./data/...`, so the result is identical to what the dev server would have produced.
 *
 * The artifact is written to `dist/`. Pass `--out <dir>` to override.
 */

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = resolve(ROOT, outIdx !== -1 ? args[outIdx + 1] : "dist");

const ENTRIES = [
	{ from: "src/index.html", to: "index.html" },
	{ from: "src/styles.css", to: "styles.css" },
	{ from: "src/app.js", to: "app.js" },
	{ from: "data/models.json", to: "data/models.json" },
	{ from: "data/budgets.json", to: "data/budgets.json" }
];

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	if (await exists(OUT)) {
		await rm(OUT, { recursive: true, force: true });
	}
	await mkdir(OUT, { recursive: true });

	for (const { from, to } of ENTRIES) {
		const src = resolve(ROOT, from);
		const dst = resolve(OUT, to);
		if (!(await exists(src))) {
			throw new Error(`Missing source file: ${from}`);
		}
		await mkdir(dirname(dst), { recursive: true });
		await cp(src, dst);
		console.log(`  ${from} -> ${to}`);
	}

	console.log(`\nWrote GitHub Pages artifact to ${OUT}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
