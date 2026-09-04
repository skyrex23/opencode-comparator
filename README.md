# OpenCode Go Comparator

A static web app to compare every model in the [OpenCode Go](https://opencode.ai/docs/go/) $10/month subscription, with
pricing, context window, capabilities and value-for-money metrics for coding tasks.

The app ships with a snapshot of the current catalog under `data/models.json` so it works offline, and pulls a fresh
snapshot from public sources on demand (the `Refresh data` button) or via `npm run refresh`.

## What it shows

- **Hero & KPI cards.** Subscription price, active models count, reusable usage, and cheapest output price at a glance.
- **"How OpenCode Go works" explainer.** Collapsible panel that explains the dollar caps, per-model tiers and what
  request counts really mean.
- **Two views.** Sortable/filterable table for at-a-glance comparison, and a card grid for browsing.
- **Per-model tier.** Each row is tagged with its OpenCode Go monthly allocation (`$15` premium, `$30` mid, `$60`
  standard) plus the official request counts per 5-hour, weekly and monthly windows.
- **Filters.** Search by name/lab, filter by subscription (Go models vs free tier), lab, status, capability (reasoning,
  tool calls, structured output, attachments, open weights), minimum context, and maximum output price.
- **Quick picks.** One-click presets: `Premium quality`, `High-volume workhorse`, `Long context (1M+)`,
  `Cheapest per request`, `Balanced all-rounder`.
- **Detail drawer.** Click any model for description, modalities, capabilities, release date and a value score.
- **Side-by-side comparison.** Tick up to 4 rows to pin them in the comparison bar; the comparison view highlights
  best/worst values across pricing, context, requests and capabilities.
- **Boot error screen.** If the snapshot fails to load, you get a clear error message and a "try again" / "refresh from
  network" button instead of a blank page.
- **Dark UI.** Single static page, vanilla JS, no framework. Easy to deploy on GitHub Pages, Cloudflare Pages, Netlify
  or any static host.

## Run locally

Requires Node.js >= 20 (only for the refresh and serve scripts).

```bash
npm run refresh   # regenerate data/models.json from public sources
npm run serve     # serve at http://127.0.0.1:5173/
```

Open `http://127.0.0.1:5173/` in your browser. The page loads `data/models.json` first; the `Refresh data` button
re-fetches from the network.

If the page shows "Could not load the snapshot", make sure you opened it via the server URL (`http://127.0.0.1:5173/`)
and not by double-clicking `src/index.html` — browsers block `fetch()` from `file://`.

## Update the data

The snapshot is the merge of three sources:

| Source                                                 | What it provides                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `https://models.dev/api.json` (provider `opencode-go`) | Pricing per 1M tokens, context/output limits, modalities, capabilities, release dates, weights |
| `https://opencode.ai/zen/go/v1/models`                 | Live Go catalog (used to mark active vs legacy)                                                |
| `data/budgets.json`                                    | Per-model OpenCode Go monthly allocation and official estimated request counts                 |

Edit `data/budgets.json` when the OpenCode Go lineup changes (new model, new tier, new limits). Re-run `npm run refresh`
to rebuild `data/models.json`.

## Repository layout

```
.
├── data/
│   ├── budgets.json         curated per-model tiers + request estimates
│   └── models.json          snapshot used by the web (generated)
├── scripts/
│   ├── fetch-models.mjs     regenerates data/models.json from the public APIs
│   └── serve.mjs            tiny static file server for local dev
├── src/
│   ├── index.html           page markup (hero, KPIs, filters, table, cards)
│   ├── styles.css           dark dashboard theme
│   └── app.js               table/cards, filters, detail drawer, comparison
├── package.json
├── README.md
└── ...
```

## How the value score works

`valueScore = (1_000_000 / outputCost) * 0.0006 + log10(context) / 6 * 30 + log10(monthlyRequests) / 5 * 40`

with a `1.25x` boost when the model supports `reasoning`. It is a rough heuristic designed to fit on a 0-100-ish scale;
it favours models with low output price, long context and a high monthly request budget. Use it to spot outliers, not as
a definitive ranking.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). PR titles must follow Conventional Commits (enforced by CI).

## License

[MIT](./LICENSE).
