# /demo/api/chat worker

The live analyst behind the demo's chat panel: `site-worker.js` routes `POST /demo/api/chat` to
`chat.js`, which streams a Claude Haiku answer grounded in `facts.generated.js`.

## Fresh checkout

```
npm ci        # wrangler + @anthropic-ai/sdk (repo root package.json)
```

Local dev secrets live in `.dev.vars` (git-ignored): `ANTHROPIC_API_KEY` plus `DEV=1` so the
missing rate-limit bindings don't fail closed outside Cloudflare.

## Facts pack freshness gate

`facts.generated.js` is generated; never hand-edit it. After ANY change to a robot's `data.js`
or `script.js` (or to `build-facts.mjs` itself), this must be clean before deploying:

```
node worker/build-facts.mjs && git diff --exit-code worker/facts.generated.js
```

A dirty diff means the model was about to quote numbers the page no longer plots.

## Testing

`wrangler dev` has a watcher reload loop in this repo; use the direct-Node harness instead:

```
ANTHROPIC_API_KEY=$(pass show anthropic/alloylogger-demo) node worker/smoke.mjs
```

Guard-rail checks are free; the grounded/persona checks spend ~8 Haiku calls.

## Deploy

```
pass show anthropic/alloylogger-demo | npx wrangler secret put ANTHROPIC_API_KEY   # once
npx wrangler deploy
npx wrangler tail   # look for `chat usage ... cache_read=` lines
```

`chat.js` fails closed (503) if the `ratelimits` bindings in `wrangler.jsonc` are missing.
The PERSONA string in `chat.js` plus the facts pack is the prompt-cache prefix; edits to either
are fine but rewrite the cache for all four robots.
