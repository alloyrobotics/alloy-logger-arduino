# /demo/api/chat worker

The live analyst behind the demo's chat panel: `site-worker.js` routes `POST /demo/api/chat` to
`chat.js`, which streams a Claude Haiku answer grounded in a facts pack for the mission being
asked about. The pack is the only thing the model is told, so every number it quotes is a number
the page is plotting.

Two kinds of mission reach it:

| robot id | pack comes from | built by |
| --- | --- | --- |
| `sbr` `arm6` `drone` `rescue` `ssl` | `facts.generated.js`, imported at build time | `build-facts.mjs`, run by hand, committed |
| `g-<20 char slug>` | the `DemoGenDO` bundle for that slug, fetched per request | the demo generator's runner, published alongside the def |

## Generated missions

A `g-` robot is a personalized demo (`demo-gen.js`): one visitor described their robot, the
runner generated a `def.json` for it and emailed them an unguessable link. Those demos are
created long after this Worker was deployed, so their packs cannot be compiled in. `chat.js`
falls through to the DO when, and only when, the posted id is not a canned robot AND matches
`^g-[a-z2-7]{20}$`; anything else is the same `400 Unknown robot.` as before. Everything after
the lookup, including the `cache_control` breakpoint, is identical for both kinds. Each generated
pack is simply its own cache prefix.

The runner builds those packs by importing THIS repo's `build-facts.mjs` out of a snapshot
(`sync-template.sh` there), so a generated mission is described to the model in exactly the
format every canned mission is. Two sections differ, both because a private mission is not a canned
one: `## Analyst context` carries the def's `facts_notes` (its numbers cross-checked against the
built arrays by the runner's validator), and `## Other missions on this page` points at the
public demo page instead of enumerating siblings.

### Which states answer

`DemoGenDO.factsPack()` serves `generated`, `approved` and `emailed`. That is one state wider
than the `def.json` gate, which starts at `approved`: a demo Hugh is previewing from the confirm
page sits in `generated`, and a preview whose chat panel 400s is not a preview of anything.
It leaks nothing, because the slug is 100 bits of unguessable secret, the pack says only what
the bundle already says, and `reject` deletes the bundle, so a rejected demo stops answering at
the same moment it stops serving.

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

Running `build-facts.mjs` writes every canned robot in its `ROBOT_IDS` list. IMPORTING it writes nothing and touches
nothing under `demo/` - it just exports the builders, which is how the generator runner reuses
them. Keep that split intact: any new top level side effect in that file would fire inside the
runner too.

After changing `build-facts.mjs`, re-run the runner's `sync-template.sh` as well, or generated
demos keep being described by the old builder.

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
are fine but rewrite the cache for every canned robot (and for every generated demo, which each
carry their own suffix).

## Visitor role (2026-08-03)

A chat POST may carry an optional `role`. It changes the ALTITUDE of the answer and never the
facts: the grounding rules, the evidence citations and the em-dash scrub are identical for all of
them.

| posted `role` | what the model gets |
| --- | --- |
| absent, or `engineer` | nothing extra. Byte-for-byte the request this route sent before roles existed |
| `operator` (or `support`, the id the picker posts) | a plain-language, what-to-do-next register |
| `lead` | a consequence-and-pattern register, with an explicit ban on extrapolating a fleet rate |
| anything else | treated as absent. An unrecognised role never costs a visitor their answer |

`worker/roles.js` holds the vocabulary, and it is the only path from a posted string to a register
key, so nothing a caller sends can reach the system prompt as text. `signup-lead.js` stores the
same normalized value on the lead row.

**The register does not break the prompt cache, and that is deliberate.** It is a SECOND system
block placed after the cache breakpoint, so block 0 (`PERSONA + facts`) stays byte-identical and
all three roles share ONE cache entry per robot. Interpolating the register into the persona is the
obvious way to write it and would give every role its own entry, tripling cache writes for the same
answers. `npx wrangler tail` shows `role=` beside `cache_read=` on each usage line, so a regression
here is visible rather than merely expensive: if `cache_read` were 0 for `operator` and `lead` while
staying high for `engineer`, the breakpoint has moved.
