# CORS proxy (Cloudflare Worker)

`opencode.ai` does not send `Access-Control-Allow-Origin` headers, so the browser blocks direct fetches to its catalog
endpoints (`/zen/go/v1/models`, `/zen/v1/models`) from any origin other than `127.0.0.1`. The page solves this by
routing those calls — plus the public `models.dev/api.json` snapshot — through a tiny Cloudflare Worker that mirrors the
endpoints and adds the CORS headers.

The Worker source lives at [`../worker/src/index.js`](../worker/src/index.js). It only exposes three routes and only
proxies to `opencode.ai` and `models.dev` — it is not an open proxy.

| Route         | Upstream                               |
| ------------- | -------------------------------------- |
| `/models-dev` | `https://models.dev/api.json`          |
| `/go/models`  | `https://opencode.ai/zen/go/v1/models` |
| `/zen/models` | `https://opencode.ai/zen/v1/models`    |

## Per-IP refresh cooldown

The Worker enforces the same refresh cooldown the front-end applies — 30 s after a successful upstream fetch, 5 s after
a failure — keyed by the client IP. State lives in the `LIMITS` KV namespace; every gated request either reads an
existing record (and returns `429 Too Many Requests` with a `Retry-After` header if still in window) or proceeds and
records the outcome. The browser reads `Retry-After` on `429` and adopts the server's view, so the two clocks stay
aligned even if localStorage was cleared.

The `LIMITS` KV namespace is already bound in `wrangler.toml`, so the gate is active in production. If a deployment runs
without the binding (e.g. local `wrangler dev` before the namespace is provisioned), the gate short-circuits and the
Worker still proxies the three routes normally. To bind the cooldown in a new environment:

```bash
cd worker
npx wrangler kv namespace create LIMITS            # production
npx wrangler kv namespace create LIMITS --preview  # local dev
```

Then paste the returned IDs into `wrangler.toml` under `[[kv_namespaces]]`.

> KV reads are eventually consistent (typically sub-second across an edge, but up to ~60 s in the worst case). For a
> cooldown layer that's acceptable — a hot read can briefly under-count, never over-count.

## One-time setup

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) (free tier covers this — 100k requests/day).
2. Pick how you want to deploy. Both options below work without installing anything globally.

### Option A — Manual deploy from your machine

Open a terminal and run (the first invocation of `npx wrangler` will download the CLI into a temporary cache; later ones
reuse it):

```bash
cd worker
npx wrangler login      # opens browser to authorize; one-time per machine
npx wrangler deploy     # prints the worker URL on the last line
```

You will see something like:

```
Published opencode-comparator-cors (1.23 sec)
   https://opencode-comparator-cors.<your-subdomain>.workers.dev
```

> [!NOTE]
>
> If you deploy often and want to skip the per-invoke download, install wrangler once globally with
> `npm install -g wrangler`. Then you can drop the `npx ` prefix. Same behaviour either way.

### Option B — Automatic deploy via GitHub Actions

1. Create an [API token](https://dash.cloudflare.com/profile/api-tokens) with the **Edit Cloudflare Workers** template.
2. Add it as the `CLOUDFLARE_API_TOKEN` secret in this repo's settings (**Settings → Secrets and variables → Actions →
   New repository secret**).
3. Commit the files under `worker/` and `.github/workflows/deploy-worker.yml`. The workflow redeploys on every push to
   `main` that changes `worker/**`, and you can also trigger it manually from the Actions tab.

## Wire the URL into the app

Whatever option you picked, copy the deployed worker URL and replace the `YOUR-SUBDOMAIN` placeholder in
`CORS_PROXY_BASE` at the top of [`../src/app.js`](../src/app.js):

```js
const CORS_PROXY_BASE = "https://opencode-comparator-cors.<your-subdomain>.workers.dev";
```

Commit that change and push. The page now reaches `opencode.ai` and `models.dev` via the Worker from any origin.

## Local development

`npm run serve` works without the Worker — `127.0.0.1` is treated as a secure context and the browser permits the
request to fail without blocking the rest of the page. You only need the Worker for remote origins (GitHub Pages, custom
domain, etc.).

## Quota and abuse

Free tier is 100k requests/day. If you publish the Worker URL publicly (which you must, for the app to use it), bots
will find and probe it. The per-IP cooldown caps normal users at ~2 requests / minute but does not stop a determined
attacker with a botnet. To further protect the quota:

- Add a [Cloudflare Rate Limiting rule](https://developers.cloudflare.com/waf/rate-limit-rules/) in the dashboard scoped
  to `/models-dev`, `/go/models` and `/zen/models` (recommended: ~100 requests / 10 seconds per IP).
- Or add `Origin`-based allow-listing in `worker/src/index.js` if you only serve from one domain.

The Comparator page falls back to the bundled snapshot if the Worker is unreachable, so a quota exhaustion never breaks
the UI — it just stops updating the live "active vs legacy" info until the quota resets.
