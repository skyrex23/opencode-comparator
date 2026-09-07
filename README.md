# OpenCode Comparator

A single-page web app to compare the coding models available through [OpenCode Go](https://opencode.ai/docs/go/) (flat
$10/month), [OpenCode Zen](https://opencode.ai/docs/zen/) (pay-as-you-go) and the free tier: price per 1M tokens,
context window, capabilities and a value-for-money score.

The page loads a snapshot bundled in [`data/models.json`](./data/models.json), so it works offline; click **Refresh
data** in the header or run `npm run refresh` to pull fresh data from public sources.

## Features

- **Hero KPIs** with plan counts you can click to filter the table.
- **Sortable, filterable table** with some features like toggleable columns and quick-pick presets.
- **Detail drawer** for the full model breakdown and a **side-by-side comparison** for up to 4 models.

### Where the model data comes from

`data/models.json` is built by merging four sources:

- `models.dev/api.json` (provider `opencode-go`) — pricing, context, modalities, capabilities, release dates, weights.
- `models.dev/api.json` (provider `opencode`) — Zen gateway specs (Claude, Gemini, GPT, Grok, Muse, …).
- `opencode.ai/zen/go/v1/models` — live Go catalog, used to mark active vs legacy.
- `opencode.ai/zen/v1/models` — live Zen catalog, used to mark active vs legacy.
- [`data/budgets.json`](./data/budgets.json) — curated per-model monthly Go allocation (`$15` / `$30` / `$60`) and
  estimated request counts.

Edit `data/budgets.json` when the Go lineup changes (new model, new tier, new limits) and re-run `npm run refresh` to
rebuild the snapshot.

### How the Score works

The **Score** column combines three signals into a 0–100-ish number, with a `1.25x` bonus when the model supports
reasoning:

```
score = (1_000_000 / outputCost) * 0.0006
      + log10(context) / 6 * 30
      + log10(monthlyRequests) / 5 * 40
```

Lower output price, longer context and a bigger monthly request budget all raise the score.

Use it to spot outliers, not as a definitive ranking.

## Run locally

Requires Node.js >= 20.

```bash
npm run start     # refresh + serve in one go
npm run serve     # http://127.0.0.1:5173/
npm run refresh   # regenerate data/models.json from public sources
npm run format    # prettier over .md, .html, .css, .mjs, .js, .json
```

Open the page via the server URL — `fetch()` is blocked if you double-click `src/index.html`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). PR titles must follow Conventional Commits (enforced by CI).

## License

[MIT](./LICENSE).
