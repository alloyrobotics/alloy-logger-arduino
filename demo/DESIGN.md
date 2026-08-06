# AlloyLogger Live Demo — build contract

A try.usealloy.ai-style interactive demo, fully static, served from this repo at `/demo/`.
The pitch: pick a robot → watch its telemetry "ingest" → an AI analyst answers "why did my robot
fail?" → **the answer drives a synchronized 3D replay + chart to the exact failure window**, with
the failing part highlighted. Mobile-first (IG traffic lands on phones). Static front end, a short
listed set of narrow backend surfaces (see the non-negotiables).

This file is the single source of truth. Do not invent interfaces not specified here.
If something is ambiguous, pick the simplest thing consistent with this doc and note it in your report.

## Non-negotiables

- **Pure static ES modules. No build step, no framework, no CDN at runtime** except the Google Fonts
  link already used by the landing page (`Geist` + `Geist Mono`). Three.js is VENDORED into
  `demo/vendor/` (pin `three@0.166.1`, module build + `OrbitControls`, wired via an import map).
- **A fixed, listed set of network surfaces, all same-origin, all listed here.** The demo page
  itself is still static files, and adding a surface is a design change, not an implementation
  detail. The page calls exactly THREE of the list below (1, 4 and 6); everything else is entered
  from an email link or by the runner. The old "exactly four" wording is superseded by this list,
  which now states which of them are live and which the 2026-07-28 shelve closed.
  1. `POST /demo/api/chat` (`worker/chat.js`) the live analyst. Streams a Claude answer grounded in
     a facts pack; rate limited by the `CHAT_RL_*` bindings and fails closed (503) without them.
     LIVE, for canned and generated demos alike.
  2. `POST /api/demo-gen/submit` (`worker/demo-gen.js`) was the lead form. **SHELVED 2026-07-28**:
     a `410` tombstone with `Cache-Control: no-store`, returned before the content-type check, any
     body read, any DO lookup and any `ctx.waitUntil`, so it has zero side effects and sends no
     mail. Nothing in the demo posts to it any more; the tombstone is for whatever still does.
  3. `GET|POST /api/demo-gen/verify` **PAUSED 2026-07-28**: renders a "demo generation is paused"
     page and performs NO state transition, so an old verification link sitting in an inbox cannot
     move a job `unverified -> pending` and promise a build that no runner will claim.
     `GET|POST /api/demo-gen/{unsubscribe,approve,reject}` are UNCHANGED and live. All of these are
     self-contained dark HTML, inline styles, no fonts, so they work from a phone with nothing
     loaded.
  4. `GET /demo/js/robots/g-<slug>/def.json` the one servable file of a generated bundle. LIVE:
     every personalized link already sent keeps working, which is the point of shelving the entry
     rather than the whole feature.
  5. `/api/demo-gen/runner/*`, bearer `DEMOGEN_TOKEN`, never called by the page: `queue`, `claim`,
     `publish`, `status`, `review`, `debug`, plus two shelve-era routes. `GET runner/state` is
     read-only drain visibility (one count per state in the DO's enum, `review_total`,
     `next_claim_expiry_s`; no PII, and it deliberately neither reclaims an expired lease nor
     records `runner_seen`). `POST runner/shelf-purge` EXISTS only while `DEMOGEN_SHELF_PURGE=1`
     is set for the shelve deploy and 404s without it, so there is no standing bulk-delete surface.
  6. `POST /api/signup-lead` (`worker/signup-lead.js`) the signup popup's capture endpoint. **NEW
     2026-07-28**, and the only surface the page has ever posted a visitor's own data to since the
     lead form went. No auth, 8 KB cap, `Cache-Control: no-store`. It answers `202 {"ok":true}` to
     an accepted lead AND to every silent drop (filled honeypot, per-IP cap of 5 new leads a day,
     the global cap of 500 new leads a UTC day, either edge rate limiter, and an address already on
     the list, which bumps a `last_seen` column instead of inserting), so the endpoint is never an
     oracle for who is already on the list. `400 {"ok":false,"reason":...}`
     only for a body it could not parse (`bad_json`, which also covers over-cap bodies, read as a
     stream and cancelled the moment it passes 8 KB so a chunked post cannot be buffered whole) or
     an address that is not an address (`bad_email`); `405` for any other verb; `503` if the
     `LEAD_RL_IP` / `LEAD_RL_ALL` bindings are missing, because a public path to the DO fails
     closed. A row lands in a new
     `leads` table in the SAME DemoGenDO sqlite, and a Resend notification goes to Hugh per NEW
     lead inside `ctx.waitUntil` (budgeted at 25 a UTC day; past the budget the lead is still
     stored and only the mail is skipped), so a mail failure can never fail the `202`: storage is
     the source of truth. `GET /api/signup-lead/list`, bearer `DEMOGEN_TOKEN`, is the export path
     and the only way the list comes out; it pages 1000 at a time over the total ordering
     (created_at DESC, email DESC) with a COMPOUND cursor, `?before=<ISO created_at>` plus
     `?before_email=<email>`, echoed back as `next_before` / `next_before_email` (email is unique
     after dedupe, so a millisecond shared across a page boundary can never hide a row), and it
     never projects the keyed `ip_hash`.
  No third-party script is loaded at runtime, ever. **Turnstile is the one sanctioned escalation**:
  if the generator is un-shelved and the honeypot + dwell + per-IP/email limits stop holding,
  adding Cloudflare Turnstile to the entry form is pre-approved, and it is the only external script
  that may be added without revisiting this list.
- **The generated-demo contract is a PUBLISHED API.** `core/prng.js`'s exports, the interpreter
  behavior of `core/gendata.js` and `core/genscene.js`, and the RobotDefinition interface below are
  not internal. Every emailed demo link is a bare `def.json` on a Worker plus whatever these modules
  do to it at open time, forever, with no version of the interpreter pinned alongside it. So: no
  export is renamed or removed, no default changes value, no clamp tightens, no part id is
  respelled, and identical `(spec, seed)` keeps producing identical arrays. Breaking changes are
  gated behind a new `spec_version` and the v1 path stays; anything softer than that needs a compat
  shim in the interpreter, not a migration of the bundles (they are immutable and already sent).
  `demo/GENSPEC.md` is the contract; `demo/js/robots/gen-fixture/harness.mjs` is the regression test.
- **Deterministic data.** All synthetic telemetry comes from seeded PRNG (mulberry32). Two page
  loads produce identical data. `Math.random()` is banned in data generators.
- **One shared timeline** drives chat evidence, the 3D viewer, and the charts. This sync is the
  entire point of the demo — everything else is scaffolding around it.
- **No em dashes in any UI copy.**
- Works at 390 px wide (iPhone, IG in-app browser) AND ≥1280 px desktop. Test both.
- 60 fps target; charts render to canvas with downsampling; three.js scenes stay under ~50k tris.

## Brand (must match alloylogger.com landing)

```css
--canvas:#111111; --card:#181818; --elev:#1e1e1e;
--line:rgba(255,255,255,0.09); --line-hi:rgba(255,255,255,0.16);
--tx:#ffffff; --tx-body:rgba(255,255,255,0.66); --tx-mute:rgba(255,255,255,0.40);
--blue:#025DFE; --blue-hi:#2f78ff; --sage:#D3EEB6; --alert:#FF5F57; --warn:#f5a623;
```
Fonts: `Geist` (body, weights 300–600), `Geist Mono` (code, values, chips), same
`fonts.googleapis.com` link as the landing `index.html`. Aesthetic: dark, engineered, blueprint-grid
accents (the landing uses a subtle grid texture), generous whitespace, hairline borders. It should
feel like the landing page opened a cockpit. No gradients-soup, no glassmorphism.

Chart series palette (in order): `#2f78ff, #D3EEB6, #f5a623, #FF5F57, #9d7bff, #4dd0e1`.
Grid lines `--line`, axis text `--tx-mute` 11px Geist Mono. Anomaly window shading:
`rgba(255,95,87,0.10)` fill with 1px `--alert` edge lines. Playhead: 1px `--blue-hi` vertical line.

## File layout & ownership (one writer per path, ever)

```
demo/
  index.html            ← scaffold agent (all screens markup + all CSS, single file)
  js/app.js             ← scaffold agent (boot, hash router, robot registry, screen wiring)
  js/core/timeline.js   ← scaffold agent
  js/core/chart.js      ← scaffold agent
  js/core/chat.js       ← scaffold agent
  js/core/viewer.js     ← scaffold agent
  js/core/ingest.js     ← scaffold agent (retained, no longer routed: see screen 2)
  js/core/context.js    ← scaffold agent (the contextualization screen that replaced it)
  js/core/stage3d.js    ← scaffold agent (WebGL probe, stage light rig, hero pose, orbit-safe fit)
  js/core/preview.js    ← scaffold agent (the picker cards' one-canvas live previews)
  js/core/prng.js       ← scaffold agent (mulberry32 + gaussian + 1D value-noise helpers)
  js/core/markdown.js   ← scaffold agent (tiny renderer: bold, inline code, tables, lists, headings)
  js/core/matcher.js    ← scaffold agent (pure matchEntry(entries, text); chat.js AND the runner's validator consume it)
  js/core/gendata.js    ← scaffold agent (GENSPEC data_spec interpreter; isomorphic, no DOM; PUBLISHED API)
  js/core/genscene.js   ← scaffold agent (GENSPEC scene_spec interpreter; PUBLISHED API)
  js/core/signup.js     ← scaffold agent (post-engagement signup popup; POSTs the captured email to /api/signup-lead)
  js/robots/index.js    ← scaffold agent (registry; imports every canned robot def; registerRobot() for generated ones)
  js/robots/generated.js ← scaffold agent (fetch + gate + compose a g-<slug> def.json into a RobotDefinition)
  js/robots/gen-fixture/ ← DEV FIXTURE. A hand-written def.json + harness.mjs that proves interpreter
                           parity with the runner. Node-only, assetsignored, never registered.
  js/robots/g-*/        ← GENERATED DATA, not code, and not in this repo at all. Served from the
                           Durable Object by worker/demo-gen.js, one def.json per slug, only after
                           the validator and the worker's structural re-check have both passed it.
                           Nothing here is ever committed and no agent writes it.
  js/robots/stub/       ← scaffold agent (dev-only placeholder proving the loop; registry-excluded at the end)
  js/robots/sbr/{data.js,scene.js,script.js}     ← robot agent 1
  js/robots/arm6/{data.js,scene.js,script.js}    ← robot agent 2
  js/robots/drone/{data.js,scene.js,script.js}   ← robot agent 3
  js/robots/rescue/{data.js,scene.js,script.js}  ← robot agent 4
  js/robots/ssl/{data.js,scene.js,script.js,      ← robot agent 5 (the SSL match replay)
                 decode.js,patterns.js,            decode.js: int16 byte decoder + interpolation contract
                 match-data.js,preview-data.js}    patterns.js: the 16 ssl-vision patterns
                                                   match-data.js: GENERATED, ~700 KB, lazily imported
                                                   preview-data.js: GENERATED, 5.9 s slice for the picker
  js/robots/battle/{data.js,scene.js,script.js,   ← robot agent 6 (the 2v2 arena battle, fully synthetic)
                 decode.js,claims.mjs,              decode.js: int16 stream decoder per the generator's FORMAT.md
                 battle-data.js,preview-data.js}    claims.mjs: the claim ledger (cited constants vs data claims)
                                                   battle-data.js: GENERATED offline, ~63 KB gz, lazily imported
                                                   preview-data.js: GENERATED, 6 s slice for the picker
  js/robots/donna/{data.js,scene.js,script.js,    ← robot agent 7 (donna-team-v2: one real match, three onboard logs, Donna's telemetry + three-body replay)
                 decode.js,claims.mjs,              decode.js: donna-team-v2 decoder (multi-robot + mesh columns)
                 donna-data.js,preview-data.js}     claims.mjs: data-bound claim ledger
                                                   donna-data.js: GENERATED offline, lazily imported
                                                   preview-data.js: GENERATED, 6 s slice for the picker
  vendor/three.module.js, vendor/addons/OrbitControls.js  ← scaffold agent
```

Each robot dir exports one default object from `data.js`'s sibling `index.js`? No — keep it simple:
`script.js` is the robot's entry: `import` its own `data.js` + `scene.js` and
`export default robotDef`. `js/robots/index.js` imports every canned robot's `script.js`.

## RobotDefinition interface (exact)

```js
export default {
  id: 'sbr',                       // url slug, ?robot=sbr deep-links it
  deviceId: 'sbr',                 // OPTIONAL. The machine's own short name, never the URL slug: a
                                   // canned robot omits it and a generated one sets it to its own
                                   // device_id, so nothing on screen can ever read like the 20 char
                                   // slug the visitor's link happens to carry. Read as
                                   // `def.deviceId || def.id` by ingest.js (five places: the
                                   // alloy.begin path, the wifi line, the mission-open line, the
                                   // finalized `<dev>-01.mcap` and the card title) and by
                                   // context.js's brief. The brief does not RENDER it today: since
                                   // the 2026-07-28 simplification the only identifiers on screen
                                   // are `name` and `device`, both of which a generated def carries
                                   // from the visitor's own description. ingest.js is unrouted, so
                                   // this field is currently plumbing, kept because it is the only
                                   // slug-free identifier a def has.
  generated: false,                // OPTIONAL, true only on a g-<slug> demo. It suppresses
                                   // NOTHING as of 2026-07-28. It used to hide the lead form, and
                                   // the lead form is gone; the signup popup deliberately DOES
                                   // show on a generated demo, because a visitor looking at a demo
                                   // built for their own robot is the warmest lead there is.
                                   // Kept as the flag `generated.js` sets and the loader reads.
  name: 'Self-balancing robot',
  device: 'ESP32 · BNO055 IMU · 2x stepper',
  tagline: 'PID balancer, 73 s mission',   // picker card copy
  accent: '#2f78ff',               // per-robot accent used on its picker card icon
  duration: 73.0,                  // seconds
  rate: 50,                        // Hz of the telemetry arrays below
  channels: [                      // drives the chart channel picker + "schema" UI
    { path: '/balance', fields: [
        { key:'pitch', label:'pitch', unit:'deg' }, ...
    ]},
    ...
  ],
  buildData(prng) => data,         // called once at load; returns
                                   // { '/balance': { t: Float64Array, pitch: Float64Array, ... }, ... }
                                   // every field array same length as its channel's t
  findings: [                      // scrubber markers + what evidence chips reference
    { id:'fall', title:'Fall at 51.7 s', window:[50.5,58.5], t:51.7,
      severity:'alert'|'warn'|'info', // documents the viewer's existing three-tone extension;
                                    // Donna uses info for the added-time-finish finding
      focus:{ channel:'/balance', fields:['pitch','output'] },
      highlight:'body',            // part id passed to scene.setHighlight
      slowmo:true,                 // play the window at 0.4x
      healthState:'DEGRADED',      // OPTIONAL. A computed classification, never a wire field;
      healthStateNote:'...' }      // emitted in the facts pack, with its note, when present
  ],
  context: {                       // OPTIONAL. Authored copy for the contextualization screen.
    system: 'One sentence on what the machine is and what it logs.',  // the only field RENDERED today
    mission: 'One sentence on what this mission was.',                // authored + derived, currently unrendered
    fault: 'One or two sentences on what went wrong, in field-engineer voice.',  // ditto
    label: 'stall',                // ditto
    faultT: 48.4,                  // ditto
    provenance: '...'              // OPTIONAL, RENDERED under the system line as a quieter
                                   // footnote (`.ctx-prov`), and emitted verbatim at the top of
                                   // the facts pack. Where the mission's data came from and which
                                   // parts of it are synthesized. No fallback is ever derived: an
                                   // invented provenance line is worse than none.
  },
  // Every field above has a fallback derived from the def itself (device + channel paths + rate for
  // `system`, tagline + duration + row counts for `mission`, the first alert finding for `fault`,
  // `label` and `faultT`), so a generated robot that ships no `context` still reads correctly.
  // The 2026-07-28 simplification renders only `system`, the datapoint-volume line and the analyst
  // charge; the other fields stay authored/derived so a richer layout can return without new data.
  firstQuestion: 'Why does my robot keep falling over?',   // auto-asked after ingest
  suggested: ['...', '...', '...'],                        // chip row under input (3-4)
  script: [
    { id:'why-fall',
      matchers:['fall','fell','tip','why','crash','wrong','fail'],   // keyword OR-match, lowercase
      answer: `markdown string, may embed evidence tokens like {{ev:fall}} inline`,
      evidence:['fall'] }          // finding ids; each renders a chip in/under the answer
  ],
  buildScene(THREE, mount) => {    // mount = container div; returns
    // { update(tSec, data),      ← pose everything from data at tSec (interpolate between samples)
    //   setHighlight(partIdOrNull), ← pulse the named part emissive alert-red; null clears
    //   dispose(),
    //   cameraHome,              ← optional {position,target} for the reset-view button
    //   cameraFocus(tSec?),      ← optional; where the machine is. No argument = the posed moment
    //   followTuning,            ← optional {omega, lead, snap} for the viewer's follow spring
    //   hudState(tSec),          ← optional; see "Scene HUD strip"
    //   rendering }              ← optional {ground, grids, shadow, fog, anisotropy, env}
  },

  // ---- OPTIONAL: a scene payload that is not the telemetry (added for ssl) ----
  previewData,                     // a small, always-loaded slice of the scene payload. Its
                                   // presence is what tells the picker and the brief NOT to build
                                   // this robot's telemetry at all.
  loadSceneData() => Promise,      // cached, idempotent; a rejection with retryable:false means a
                                   // module evaluation failed and only a reload can retry.
                                   // EVERY route entry attaches its own generation-aware
                                   // continuation to it; see "Lazy scene payloads" below
  isSceneDataLoaded() => boolean,  // required alongside loadSceneData: app.js's ensureData
                                   // tripwire throws if buildData is reached before this is true
  getSceneData() => object,        // what update() gets as its 2nd argument: the full payload once
                                   // loaded, else previewData. Same shape either way
  heroTime() => seconds,           // optional; overrides stage3d's T_HERO table. For a def whose
                                   // payload can be one of several, seconds mean different things
                                   // in each, so the def resolves its own posed moment
  preview: { focus, envCull,       // optional per-def overrides for the framing solve, used by
             envRadius, distScale },// BOTH staged screens (picker card and brief hero)
  rates: { '<channel>': hz },      // optional; a genuinely mixed-rate mission. `rate` stays as a
  rateNotes: { '<channel>': str }, // summary, and the facts pack emits cadence per channel instead
  chatProvenance: str,             // optional; a standing line chat.js renders above the composer.
                                   // Client-written from the def, never from a model answer
}
```

`data.js` exports `{ channels, duration, rate, buildData, findings }`; `scene.js` exports
`buildScene`; `script.js` composes and exports the full def. Robot agents touch NOTHING outside
their own directory.

## Core module interfaces (scaffold agent implements, everyone else consumes)

`timeline.js` — `createTimeline(duration)` →
`{ t, playing, speed, loopWindow, play(), pause(), seek(t), setLoop([a,b]|null, {speed}), onTick(cb), onChange(cb), dispose() }`.
rAF-driven; `onTick(t)` fires every frame while playing and once on seek.

`viewer.js` — `createViewer(mount, robotDef, timeline)`; owns renderer/camera/lights/ground.
Scene chrome: dark ground with a subtle blueprint grid (GridHelper toned to `--line`), soft
hemisphere + key light with shadows, black fog fading the horizon, OrbitControls (damped,
zoom limits) with autorotate OFF. It subscribes to the timeline and calls `sceneApi.update(t, data)`, where `data` is
`def.getSceneData?.() ?? def.data`, resolved per call so a payload that lands after mount still
reaches its scene.

**Per-scene rendering treatment.** A scene may return `rendering: { ground, grids, shadow, fog,
anisotropy, env }`. `ground:false` / `grids:false` drop the viewer's 80 m plane and its two 60 m
grids (a scene with its own floor sits ON them otherwise); `shadow:false` disables the key light's
shadow and the renderer's shadow map outright, which is the right answer whenever the subjects are
smaller than a shadow texel; `shadow:{...}` retunes the frustum instead.

**Scene HUD strip.** A scene may expose `hudState(tSec)` and get a compact fixed strip across the
top of the stage: the scene returns STATE (`{version, clock, stage, state:{label,tone,note?},
teams:[{name,color,score,cards,reds,maxBots,keeper,timeouts}]}`)
and never markup, the viewer writes it with `textContent`, and the DOM is touched only when
`version` changes. This documents the viewer's existing optional `state.note` extension: a non-empty
note is rendered in the shared note slot, an empty or omitted note renders nothing, and its value
must be covered by `version`. Donna uses it for the penalty and goal callouts. It exists because a
follow-cam on a 46 dvh phone panel cannot show a legible in-world scoreboard. The viewer marks itself
`.has-shud` so the evidence banner opens BELOW the strip instead of on top of it.
Exposes `setHighlight(partId)` pass-through and a small overlay HUD: play/pause, speed (0.4x/1x/2x),
reset-view, and the scrubber with finding markers (colored ticks; hover shows title; click seeks).

`chart.js` — `createChart(mount, robotDef, timeline)`; renders the active channel's selected
fields; channel/field chips above; crosshair on hover with mono value readout; playhead synced from
timeline; `focus(finding)` animates x-domain to the finding window (with ~15% padding) and shades
the window; a "reset zoom" affordance appears when zoomed. A click seeks only when it lands inside
the plot area; one in the padded axis gutters is ignored. The seek path raises a `chart:seek`
`CustomEvent` on the canvas after seeking, which is what the signup popup arms off: a bare canvas
click would also fire for gutter clicks the chart itself dropped. Nothing in `chart.js` listens to
it and seek behaviour is unchanged by it.

Fields are grouped by UNIT and each group gets its own y-range; group 0 owns the left axis. Two
label modes follow from that. The instrument view (full chrome) prints a numeric axis for group 1
on the right. `setDirectLabels(true)` — the mode the flow's failure step and every inline evidence
block use — replaces the field chips with end-of-trace pills, and in that mode a second numeric
axis is NOT drawn: the right gutter is the pills', and the second group's unit rides on the pills
that name its traces instead. Both gutters and the x-tick COUNT are measured per frame off the real
label text against the real plot width, so a narrowed plot drops x stamps rather than printing them
through each other. Missions with two units on one finding today: donna (m/s^2 + deg), battle
(heat + HP).

`embeds.js`: `createEvidenceEmbeds({ def, timeline, park, scroller, icon })`. **ROUND 3.** The
inline evidence block, and the single-context virtualization behind it. An evidence-bearing answer
carries, inside its own bubble: an annotated chart of the finding's channels zoomed onto its window
and seekable; one short causal paragraph; and the 3D replay of those same seconds, live.

- `attach(row, findings)` mounts up to two blocks into a settled `.msg.bot` row; `play(finding)`
  scrolls to the newest block citing it and hands it the context.
- **One WebGL context per screen, never one per message.** The shared viewer element is physically
  MOVED into whichever block is nearest the reader's centre; reparenting a canvas does not disturb
  its context. Every other block shows a POSTER captured off that same renderer at handover
  (`viewer.capturePoster()`, which renders and reads the drawing buffer in one task because the
  renderer keeps no buffer between frames). No poster yet, or a lost context, falls back to the
  mission's line art plus a "replay here" tap target.
- `#viewer-mount` survives as the PARK the viewer lives in when no block owns it: a laid-out
  off-screen box, not a hidden one, because a renderer measured against `display:none` comes up
  0 x 0.
- The shared viewer is BUILT ONE FRAME AFTER THE SCREEN MOUNTS, parked, not on the frame a block
  first asks for it. The opener is asked at 420 ms and then types itself out, so the first block is
  seconds away; deferring the build put context creation, the scene and three.js's first shader
  compile on the one frame the reader arrives at the evidence. Warming it against the park makes
  activation a reparent plus a resize. It also stops "the demo screen is up" from depending on how
  long an answer takes to type, which is what the navigation-race and lazy-path probes read a canvas
  under `#viewer-mount` as proof of. Still exactly one context: this changes WHEN it is allocated,
  never how many.
- Charts are per block and their paint pumps follow VISIBILITY (`chart.setRunning`), so a
  transcript of thirty answers does not wake the tab at display rate for thirty plots.
- The causal paragraph prefers `finding.note`, then `def.evidenceNotes[id]` (how the size-gated
  missions supply theirs from a lazy side module), then a derived sentence naming the plotted
  fields, channel and window. Long notes are clamped to whole leading sentences; the splitter will
  not cut inside a number, because half a measurement beside a chart is a wrong number.
- Teardown order is load-bearing: the viewer is returned to the park BEFORE any block element is
  removed, because OrbitControls resolves the node holding its document-level `keydown` through
  `domElement.getRootNode()` at dispose time, and a detached canvas leaks it.

`chat.js`: `createChat(mount, robotDef, { onEvidence, onEvidenceBlock, onSettled })`; renders history, streams
answers (typewriter, ~3 chars per frame, instant-finish on click), parses the markdown subset,
renders evidence chips (`Geist Mono`, `▸ 51.7 s · Fall` style). Matching: lowercase the user input,
score each script entry by matcher hits, best score wins, tie → first; zero hits → canned fallback
that lists the suggested questions. When an answer containing evidence finishes streaming,
auto-fire `onEvidence(finding)` for the FIRST evidence item (chips re-fire it on click).

`onSettled()` fires when an answer is fully rendered (typewriter complete), with EXACTLY-ONCE
semantics per logical answer, keyed by request identity. It fires on every true terminal path
(evidence, no-evidence, scripted fallback, partial error, pre-token error) and NOT on the
intermediate `discard()` when a no-token live failure hands off to the scripted fallback (one
settle, on the fallback's completion), NOT for an answer that was superseded by a newer question,
and never after `dispose()`. It exists because the signup popup's quiet timer must start when the
visitor's action has ENDED: the SSE `done` frame is too early (the typewriter is still running) and
`onEvidence` only ever covers evidence-bearing answers.

`onEvidenceBlock(row, findings, entry)` is the round-3 hook: the host mounts the inline evidence
block into the settled answer and returns truthy, and `chat.js` then drops the trailing chip row
entirely. A chip was a POINTER at evidence living somewhere else, and there is nowhere else now.
Inline `{{ev:id}}` chips inside the prose stay: they are the answer's citation, and clicking one
scrolls to the block and hands it the context. A host that returns falsy (or throws) keeps the old
chip row, which is what makes the fallback path honest.

**`onEvidence(finding)` in app.js is still the money interaction, and it is still the same
sequence - it just happens INSIDE the message that cited the finding rather than in panels beside
it.** `embeds.play(finding)` scrolls the block to the reader, hands it the shared context, flashes
its marker, loops `finding.window` (`speed: finding.slowmo ? 0.4 : 1`) on the ONE mission timeline,
aims its chart at `finding.focus`, and pulses `finding.highlight` in the replay. Seeking any block's
chart moves the mission clock, which moves the live replay: a block is a window onto one mission,
not a private copy of it.

`ingest.js` — the faux connect sequence between picker and demo: a mono terminal card streaming
plausible lines (`alloy.begin("robots/sbr")`, `POST /v1/chunk 202 (14.2 KB)`, `mesh table
alloy.fleet.balance +3894 rows`, `mission finalized → sbr-01.mcap`), ~2.5 s total, then auto-advance.
Lines derive counts from the robot's actual channel row counts. Skippable via "skip".

## Screens (hash-routed: `#/`, `#/connect/:id[/robot|mission|failure]`, `#/demo/:id`)

**ROUND 3 route surgery.** The connect flow is THREE steps: robot, mission, failure. The fourth
(`/choose`, the three debug-comparison cards) is deleted, and its CTA moved onto the failure step:
"Ask Alloy" hands straight to `#/demo/:id`. `#/connect/:id/choose` is redirected there rather than
404ed, because real sessions have that hash in their history. The retired comparison-card copy,
styles and DOM helpers are deleted with the step.

1. **Picker** `#/`: header (AlloyLogger wordmark linking to `/`, "Live demo" chip), headline
   "Replay a mission.", sub "Pick a robot. Ask it why it failed." Seven cards (`repeat(7)`
   at >1000 px, `repeat(2)` below it with the odd last card centred at a normal card's width):
   inline-SVG
   line-art schematic of each robot (brand-styled, stroke `--tx-mute`, accent stroke per robot),
   name, device line, tagline, mono stats row (duration · channels · Hz). Hover lifts card.
   Footer CTA row: "Get the library" → https://github.com/alloyrobotics/alloy-logger-arduino ·
   "Set up your org" → https://www.usealloy.ai/setup-org?utm_source=alloylogger.com&utm_medium=referral&utm_campaign=alloylogger&utm_content=demo
2. **Contextualization** `#/connect/:id`: the mission brief, built by `js/core/context.js`. Two
   columns: a product-shot hero of the machine on the left (a live 3D canvas inside `.ctx-fly` over
   the SVG ghost placeholder), and three staged lines on the right: what the machine is
   (`context.system`), how much raw data the mission shipped (datapoint volume), and what the
   analyst is about to be handed. The CTA is the robot's own `firstQuestion` rendered as a
   card-shaped button (`.ctx-ask`, quoted question + "ask the analyst" hint) — clicking it advances
   to the demo, which opens by auto-asking that exact question. Owns no timer and never
   auto-advances. Clicking the copy lands every stage at once; "skip to the demo" also advances.
   The hero flies in from the clicked picker card: app.js captures the card's on-screen rect plus
   its preview camera phase and passes it as `handoff`, and the hero opens at the card's size and
   angle, then eases into the panel over 700 ms while its orbit ramps from the card's 14 s
   revolution to the hero's 30 s one. No hand-off (direct URL) = a plain scale-and-fade settle.
   `.ctx-stage` must never clip, since the entrance starts outside it.
   `js/core/ingest.js` (the faux ingest terminal this replaced) is retained in the tree but is no
   longer routed to by anything.
3. **Demo** `#/demo/:id`: **CHAT FIRST, and chat only (round 3).** One full-height scrolling
   transcript, centred at a reading measure (820 px), composer pinned to the bottom, at every
   viewport. The persistent 46 dvh replay stage and the telemetry pane that used to sit beside it
   are GONE, and so is the `chat -> proof -> follow-up` layout machine that arranged them: an
   answer carries its own chart, causal line and live 3D replay (`core/embeds.js`), and a follow-up
   question is just another message. `#screen-demo` still carries `data-mode="chat"` as one
   constant value, because `chat.js` hangs the wall's answer typography off it and analytics
   reports it; nothing branches on it. Header: back arrow to the mission library, robot name +
   device, the two acquisition CTAs on desktop, hidden on a phone where the header is one line.

The `?robot=<id>` query param on any load deep-links straight to `#/demo/<id>`.

## The canned robots (storylines are FIXED; hit these numbers)

Every robot: one headline failure with a beginning/failure/recovery arc, one systemic slow-burn
finding, one root-cause that needs cross-channel reasoning, plus a "how do I log this from my own
robot" script entry whose answer shows a REAL AlloyLogger Arduino snippet (API: `alloy.begin(key,
"robots/<id>")`, `alloy.describe(ch, field, unit, min, max, note)`, `alloy.log(ch).set(k,v)...`,
`alloy.end()` — see `examples/SelfBalancingRobot/SelfBalancingRobot.ino`).

### sbr (robot agent 1) — the real dataset, synthesized to match verified findings
73 s @ 50 Hz. Channels: `/balance` (pitch, setpoint, output, step_rate, motor_active, p, i, d,
rate, i2c_dt), `/sys` @ 10 Hz (heap, rssi, uptime_s), `/io` optional (skip if time-boxed).
MUST reproduce (these are real, measured numbers from the actual mission):
- Balancing oscillation around setpoint 0.5° that visibly grows (no derivative damping).
- **The fall**: pitch −2.00 → +7.12 → −10.06 within ~500 ms around t=51.7; output slams
  +228→−180→+120; step_rate peaks ±5366/−4225; robot down at 52.0 and 56.2, upright again 58.2.
- **Heap leak**: heap 112,172 → 67,020 B over the 73 s (~622 B/s), min 48,724.
- **d is 0.0 in every sample** (DEFAULT_KD=0). This is the root cause of the fall.
- **i2c_dt**: nominal ~10 ms with jitter, 16 samples over budget, max 801.9 ms.
- Motor saturation: |step_rate| pinned at 6000 ceiling for ~5.3% of samples.
Findings: `fall` (alert, window [50.5,58.5], slowmo, highlight `body`), `heap-leak` (warn, window
[0,73], focus /sys heap), `i2c-stall` (warn, spike windows, focus i2c_dt), root-cause script entry
correlating d=0 + growing oscillation. firstQuestion: "Why does my robot keep falling over?"
Scene: two-wheel stepper balancer (wheels, motor blocks, PCB stack body with tiny status LED),
pitches with data, wheels spin per step_rate, falls flat at the falls and recovers; highlight body.

### arm6 (robot agent 2) — 6-DOF arm, pick-and-place
80 s @ 50 Hz, 12 pick cycles between pad A and pad B. Channels: `/joints` (q0..q5 deg,
tau0..tau5 Nm), `/ee` (x, y, z, grip 0|1), `/ctl` (err2, err_max deg following error), `/sys`
(bus_v, drv3_temp).
Storyline: cycle 9 carries a heavier payload; shoulder J2 torque pins at its 12 Nm clamp at full
reach (t≈54 s), following error err2 grows past 6°, gripper loses the cube at **t=56.3 s** (grip
drops 1→0 mid-transfer, /ee z of payload... payload not logged — the tell is ee path continuing
while grip=0 early). Recovery: arm re-homes, next cycles fine at nominal payload. Slow-burn:
drv3_temp creeping 38→71 °C. Root cause: payload × reach exceeds J2's torque envelope; tau2
saturation + err2 spike prove it.
Findings: `drop` (alert, [52,60], slowmo, highlight `j2`), `overtemp` (warn, [0,80], focus
drv3_temp), plus root-cause entry. firstQuestion: "Why did the arm drop the payload?"
Scene: pedestal + 6 articulated links + parallel gripper, cube payload that attaches on grip,
detaches and falls with gravity at 56.3 s; two pads on the ground; highlight J2 joint capsule.
FK note: pose links directly from q0..q5 (author the generator IN joint space; derive /ee via the
same FK used by the scene so chat numbers and visuals agree).

### drone (robot agent 3) — quad survey flight
90 s @ 50 Hz, lawnmower survey pattern over a 20×14 m field at 6 m alt. Channels: `/att` (roll,
pitch, yaw deg), `/pos` (x, y, alt m), `/motors` (rpm1..4, pwm1..4 %), `/bat` (v, a).
Storyline: motor 3 bearing degrading: rpm3 oscillation amplitude grows from t≈40 s, controller
masks it with pwm3 climbing to 100% by t≈58 s; at **t=61.2 s** compensation runs out: 2.1 m
altitude dip + 18° yaw excursion + roll wobble; failsafe descends and lands at t≈70→78 s
(controlled, not a crash). Slow-burn: bat v sag steepens under the extra load (16.8→13.9 V,
inflection visible at 40 s). Root cause: rpm3/pwm3 divergence vs motors 1/2/4.
Findings: `dip` (alert, [58,66], slowmo, highlight `m3`), `motor-wear` (warn, [38,62], focus
rpm3+pwm3), `battery` (warn, focus /bat). firstQuestion: "What went wrong on the survey flight?"
Scene: X-quad (arms, spinning prop discs with blur-disc material, canopy) flying the actual /pos
path above a gridded ground with the survey lanes faintly drawn; wobble + dip from data; lands at
the end; highlight motor 3 arm+prop.

### rescue (robot agent 4) — tracked rescue robot on rubble
85 s @ 50 Hz. Channels: `/drive` (cmd_l, cmd_r, vel_l, vel_r m/s, i_l, i_r A), `/imu` (roll,
pitch deg), `/flipper` (front, rear deg), `/sys` (temp_l, temp_r °C, batt_v).
Storyline: traverse flat debris, then a 28° rubble incline at t≈44 s. Left track loses grip:
cmd_l steady but vel_l collapses (slip ratio >0.8), i_l spikes 8→22 A stall current at **t=48.4 s**,
temp_l jumps, robot yaws 15° off-line and slides back 0.6 m by t≈52 s. Operator drops front
flippers 0→−35° at t≈57 s, second attempt crests the incline at t≈65 s, finishes on top. Slow-burn:
temp_l 41→78 °C and still elevated at end. Root cause: slip (cmd vs vel mismatch) → stall current,
fixed by flipper geometry change, provable by comparing the two attempts.
Findings: `stall` (alert, [46,54], slowmo, highlight `track_l`), `thermal` (warn, focus temp_l),
`retry` (sage/success-flavored info finding, window [56,66], focus vel_l+flipper: "what fixed it").
firstQuestion: "Why did it stall on the rubble pile?"
Scene: tracked chassis with visible track loops + front/rear flipper arms, sensor mast, climbing an
inclined rubble ramp (irregular scattered boxes); track surfaces scroll per vel, slip = tracks
spinning without motion; slide-back; flippers articulate; highlight left track.

### ssl (robot agent 5) - a real RoboCup Small Size League match, replayed

The one mission on this page that is not synthetic all the way down, and the reason several of the
contracts above exist. 110 s window, 19 tracked robots, mixed cadence (`rates`, not `rate`).

**What is real.** Robot and ball tracks, yaw, the referee command timeline, the score, the cards,
the kick attributions and the tracker's own `visibility` numbers are replayed sample for sample out
of a professional SSL match log (2026 season). Field geometry, line set, goal dimensions and the
centre-circle radius come from that log's own `SSL_GeometryData` packet, never from rulebook
constants. The `/bot13/vision` channel and the whole `/match` channel are real data.

**What is not, and why it cannot be.** An SSL log carries vision, referee and tracker streams and
nothing else: no onboard packet, no radio statistic, no battery voltage has ever been in one. Every
other channel is a SYNTHETIC COUNTERFACTUAL OVERLAY whose names, units and ranges are taken from
the published TIGERs firmware, with faults invented for this demo. Fault timing is
anchored to real events (kicks, referee commands, ball contact) because a fault that ignores what
the robots were doing would be useless to reason about; that anchoring is correlation BY
CONSTRUCTION, and no finding claims a synthesized fault caused anything in the real match. That
holds in the COPY too, which is where it is easiest to lose: no answer says a modelled channel is
why the fleet did something, the opener asks what is wrong with a synthesized channel rather than
why a real behaviour happened, and the dribbler answer says outright that "the log alone cannot say
why the ball got away". `ssl-script.test.mjs` bans the phrasings that broke this before.

**De-identification.** Team display names, hull palette and the UI accent are fictional (Polaris
Robotics, Ferrum SSL). The referee colours and robot ids are the real ones and are never altered:
the vision-pattern centre dot stays blue or yellow. NOTHING in this repo or in anything it serves
identifies the source: no archive URL, no log hash, no event, match or window identifier, no tracker
`source_name` or producer UUID. The public metadata carries a dataset content hash, an opaque
tracker label ("tracker source A") and the phrase "a professional SSL match, 2026 season". The
identifying manifest lives only in the private clients/alloy scratch repo. Every planted fault is described
publicly as a counterfactual overlay unrelated to any real team's hardware, and that disclosure
appears in five places: the picker copy ("Five synthetic missions, one real match replay with
planted fault overlays, and one real match replayed from three robots' onboard logs"), the card tagline ("A real match replay,
three planted faults, one real
tracking loss"), the brief's `context.provenance` line, the scripted first answer (which bypasses
the facts pack entirely) and the facts pack's own preamble. A sixth is not copy at all:
`def.chatProvenance` ("Real match motion. Three faults are synthetic overlays; the bot 13 tracking
loss is real.") is rendered by `chat.js` as a standing line above the composer, so the disclosure
is on screen before the first question and does not depend on the model complying with anything.

**THREE planted, not four.** Of the four findings, `kicker-charge`, `radio-degraded` and
`dribbler-overheat` are synthesized overlays; `vision-confidence` is the log's own data, the shared
league vision losing an opponent robot, and calling it planted would be a false statement in the
visitor's favour AND against the league's infrastructure. Every disclosure surface says three plus
one, and `ssl-script.test.mjs` fails any surface that pairs "four" with "planted"/"synthetic".

**ROUND 3 removed the picker footer** (UX wall, "ML-footer"), which was the fifth surface and the
only one that counted synthetic MISSIONS rather than faults. The disclosure it carried is not lost:
the card tagline, `context.provenance` and `def.chatProvenance` each state it on the way into the
mission, which is where a visitor actually reads it, and the three script tests now pin the footer
as ABSENT so it cannot come back in a weaker form.

**Battle disclosure surfaces.** The battle mission is fully synthetic and needs no de-identification,
but it carries the same disclosure discipline: `context.provenance` ("A scripted, rules-faithful
simulated round..."), the scripted `provenance` answer, the facts-pack preamble (same sentence via
`provenanceSection`), and `def.chatProvenance` ("Simulated round. All telemetry in this mission is
synthetic..."), rendered above the composer before the first question. Battle copy never calls the
round recorded or real, never puts DJI marks on anything, and never mentions the other competition
or its teams (the leak gate enforces that mechanically in --repo mode).

The word "final" appears nowhere the site serves. The match is described as "a professional
Division A match" (the division is derivable from the rendered field, the round is not).
`demo/js/robots/gen-fixture/ssl-leak-check.mjs` is the gate, and four properties make it one:

- **It names nothing itself.** Every match-identifying needle is derived from the private manifest
  at run time. A de-identification checker with a list of real team names in it is a
  de-identification failure with an explanation attached, and this file is going to be public.
- **Default-forbid, on EXACT LEAVES.** `MANIFEST_SCHEMA` enumerates every leaf of the manifest by
  its full path, with the kind it is, the type it has and - where a value can be checked at all - a
  validator. A leaf that is not in it fails the run by name. There is no subtree wildcard: there
  were five (`emitted.`, `source.renameMap.`, `exporter.config.teams.`, `exporter.config.vision.`,
  `gates.`), and each certified as public not the leaves someone had read but every leaf that would
  ever land underneath it, so an `emitted.sourceLog` or a `teams.blue.originalName` would have
  arrived pre-cleared. The self-test plants an unknown leaf inside each of those five and requires
  all five to come back unclassified. The validators cover the case a text scan structurally cannot:
  the rename map has to carry the FICTIONAL names and never the real one, which is the whole
  de-identification written as two strings. `REQUIRED_MANIFEST_PATHS` fails the run if an identifier
  it derives from is renamed or dropped, so the forbidden list cannot shrink quietly. Whole values
  catch anything; the paths whose values are identifying TEXT are tokenised as well, so a real team
  name is caught inside a filename.
- **Fail-closed.** No manifest, no gate: the default invocation - the one `npm test` runs - exits
  non-zero when the manifest is not on disk. `--dev-partial` runs the generic rules alone, says so,
  and certifies nothing.
- **It scans what reaches a visitor, not what Cloudflare uploads.** Everything `.assetsignore`
  allows, PLUS `worker/facts.generated.js` and `worker/chat.js`: the facts pack is not a static
  asset, it is what the analyst is told, and a leak there is a leak on the page.

Citations are approved as EXACT OCCURRENCES - file plus the SHA-256 of the text around the hit -
never as keywords. Keyword allowlisting ("a line naming a team is fine if it also says kicker")
forgives every future line that happens to mention a kicker. Change an approved sentence and its
hash stops matching, so the approval is re-earned; the gate prints the hash of anything unapproved,
so adding a legitimate citation is a copy-paste and a sentence of justification.

**One definition of "ball in play".** `ssl/in-play.js` owns it and data.js, scene.js and the
self-tests all import it. A restart command does not put the ball in play; 0.05 m of real ball
travel off the restart point does, or the restart's own ceiling - ten seconds for a kick-off, five
for a Division A free kick. This existed three times and disagreed with itself, which armed the
synthesized kicker for seconds the renderer was still drawing a free-kick standoff over and put the
difference into the copy as fact. A `heldFromBeforeWindow` command is resolved off the stage clock,
never off the crop boundary: measuring 0.05 m from wherever the ball sat at t = 0 fabricates a
restart the match never had, and a state the clock cannot establish is UNKNOWN (no ring, no
countdown, no RUNNING). The dribbler is the one channel deliberately NOT gated on it - a dribbler
runs whenever its robot is working the ball, including carrying it to a placement point, which is
the same fact the placement corridor decal is drawn from.

**Eager payload budget: 57 KB, enforced.** `ssl-eager-size.test.mjs` gzips the eager module graph -
everything `script.js` imports STATICALLY, so the lazy match module drops out by construction - and
fails over 58,368 bytes. FUTURE SSL PAYLOAD GROWTH MUST MOVE BEHIND THE LAZY MATCH-DATA BOUNDARY
rather than raising that number: the eager half ships to every visitor who opens the picker.
Ceiling raised 2026-07-29 for review-mandated honesty copy; any non-copy growth must still move
behind the lazy match-data boundary.

Channels: `/bot8/kicker`, `/bot8/power`, `/bot7/radio`, `/bot3/dribbler` (synthesized),
`/bot13/vision`, `/match` (real). `/bot13/vision`'s `visibility` is REAL_TRACKER /
DERIVED_ABSENCE_ZERO_FILL, not a raw wire value: the robot is in no tracked frame for 72.9 % of the
window and the channel carries 0 there. Those zeros are an absence marker, so the facts pack
computes the field's statistics over the PRESENT samples only and states the absent fraction on its
own line - averaging the filler in would report a confidence nobody measured.

`detections` on the same channel is masked too, by its own `detectionsPresent`, and for a sharper
reason. The VISION_2014 cross-check used to be exported CROPPED to the neighbourhood of the
visibility dip - a window that opens after the camera-0 stretch and after the two-camera overlap -
and every bin outside the crop was zero-filled and plotted as a measured zero. The copy read the
crop as the whole: "detected by ONE camera only for its whole life". The export now carries a
flagged robot's whole tracked lifetime with a per-bin coverage mask, the mask says which bins the
export holds a count for, and an uncovered bin reads `absent` rather than 0. Ferrum #13's real
story is a HANDOFF: camera 0 alone for 76 bins, both cameras for 7, then camera 1 alone for 28
while the rate falls from 18 to 19 per bin to single readings. 1887 detections across 111 covered
bins.

It does NOT fall to zero, and no surface may say it does. The covered camera-1 bins end at 1 and 2
(bins 105 to 108 read 1, 2, 1, 2), bin 109 carries no count, bin 110 reads 1, bins 111 to 126 carry
no count, bin 127 reads 1, and the evidence stops. "Decays to zero" and "decays to nothing" both
read those gaps as measurements of zero, which is the exact thing the coverage mask exists to
prevent, so the uncovered tail is described as unknown everywhere: the scripted answer, the finding
note, the facts pack. `ssl-data.test.mjs` rejects `/to zero|to nothing/` in any masked-detection
claim and pins that late chronology bin by bin.

`ssl-data.test.mjs` checks the shipped bins against `ssl-vision-cache.fixture.json`, the exporter's
own pre-publication extract, so a re-crop fails a test instead of rewriting a sentence.
The per-camera frame totals (8058 / 8052) are window aggregates and never evidence that a camera
was up at a given instant: no surface says "throughout".

Every field carries two-dimensional provenance
`{origin: REAL_TRACKER|REAL_GAME_CONTROLLER|REAL_VISION|SYNTHETIC, transform: WIRE|
FIRMWARE_FLAG_DECODE|DERIVED_<X>|NONE}`, and both dimensions are emitted into the facts pack.
Findings: `kicker-charge` (alert), `radio-degraded` (warn), `dribbler-overheat` (warn),
`vision-confidence` (info, REAL). firstQuestion: "What is wrong with bot 8's kicker?"

Scene: the field from the geometry packet, robots as 180 x 147 mm cylinders with the flat dribbler
face and the correct 16 ssl-vision patterns, ball at true 43 mm. Cubic Hermite on exported tracker
velocities, never across a presence gap; continuous yaw; tracking loss renders as a held ghost and
never as a robot leaving the field. `rendering.shadow === false` (a 1024^2 map over an 18 m frustum
is ~18 mm/texel, which on a 180 mm robot is a smear); grounding is baked contact discs. `hudState`
drives the DOM strip, and derives RUNNING from the real ball track once a restart is in play.

Referee state reaches the visitor two ways and only two. The DOM strip carries the TeamInfo
semantics whole: names, score, stage, stage_time_left, yellow/red cards, max_allowed_bots, timeouts
remaining, and the registered goalkeeper id as a `K<id>` chip beside its team. The keeper is a chip
and NOT a decal on the robot, because a real SSL robot carries no keeper marking at all: the id is
game-controller state, so painting it on a hull would be a fiction the league does not have. On the
felt, three decals in the same honest-UI language as the ball marker (additive light, never
leaving the ground plane), and each is the affordance its own command actually imposes:

- the 0.5 m **ring on the ball**, under STOP and under a free kick until the ball is in play (the
  in-play moment derived from the real ball track, not a fixed delay);
- the 0.5 m **placement corridor**, a stadium from the LIVE ball to the command's
  `designatedPosition`, rebuilt every frame as the placing robot dribbles the ball there, because
  that is the shape the opponents owe the distance to during a ball placement;
- the **placement target** at that `designatedPosition`.

There is deliberately NO decal under HALT, under a timeout, or under kickoff/penalty preparation.
HALT is "stop within 2 s", not a standoff; the two preparation commands have formation rules that
are neither a ring nor a corridor. The HUD state chip carries all three.

The strip never `display:none`s Tier S16 state. Below 1000 px it wraps into a compact second row
(stage, stage clock, cards, timeouts) under the identity row (dots, names, keeper chips, score,
state chip), and stays at two rows down to 360 px. `max_allowed_bots` is the one field that folds
below 700 px, because it is the one field on the strip S16 does not require and it is a permitted
maximum rather than an observed count.

### battle (robot agent 6) - a scripted 2v2 arena battle, fully synthetic

A rules-faithful simulated 180 s round of the ICRA 2019 RoboMaster AI Challenge ruleset (DJI Rules
Manual V1.1), generated OFFLINE by the battle-sim generator in the private clients/alloy scratch
repo and shipped as `battle-data.js` (int16 streams + a typed event ledger; format in the
generator's FORMAT.md, decoded by `battle/decode.js`). Fictional teams: Halcyon Labs (blue, the
instrumented team) vs Redline Dynamics (red). Wire ids red 3/4, blue 13/14.

The storyline is the fault chain, and the numbers are FROZEN in `battle/claims.mjs` (every number
in copy is either a cited manual constant or a data claim bound to an exact sample):

- t=72.0: Blue 1 is tracking Red 2 when it slips behind obstacle O7. The track layer keeps
  republishing the last pose, fresh-stamped, so the fire gate's age check never trips.
- t=72.6 to 74.457: the chassis rotates to the held bearing (outside the gimbal's +/-90 deg
  window) and fires 14 shots at 23.0 m/s into the obstacle.
- Heat first passes 180 on shot 12 at 74.171. Eight referee ticks (74.2 to 75.0) deduct
  24/68/136/112/88/64/40/16 = 548 HP; peak heat 214; the stale track times out after 2.55 s.
- Blue 1 survives on 1452, ends the round on 1102. Redline wins on deduction 1448 to 1150, and the
  548 is the margin: remove it and Halcyon wins 1150 to 900 (the counterfactual is a test).

Findings: `stale-track`, `frozen-goal`, `blind-burst`, `overheat-self-damage` (the chain), plus
`buff-halved-damage` (the 25-vs-50 defense-zone explainer; deliberately pointed at Blue 1's FLAT
referee line, because the referee bus never reports another robot's health) and `uwb-yaw-residual`
(magnetometer yaw noise, an info beat, not a fault). Six channels, all `/blue1/*`, at most two unit
groups each; per-shot muzzle speeds live in the event ledger, never as an isolated masked series.

Two core extensions exist BECAUSE of this mission, both backward-compatible and regression-tested:

1. **Viewer HUD extension**: `hudState().teams[].color` may be `'red'`; discipline fields (cards,
   keeper, timeouts) render only when defined; optional `state.note` line (buff/supplier callouts);
   `version` MUST cover every rendered field (clock, scores, label, tone, note). The SSL strip is
   proven unchanged by re-derivation in `test:battle-hud`.
1b. **`def.loadingCopy`** (grew out of the same review): the lazy-route loading card renders
   def-owned `{line, cap}` copy; app.js falls back to a truthful generic line for defs without it.
   A shared sentence was quietly claiming every lazy payload was a match replay with a ball.

2. **`def.eventLines` facts hook**: a function, callable only after `loadSceneData()` resolves,
   returning typed rows `{t, source, kind, detail}`. `build-facts.mjs` renders them under a def-owned
   `eventsSection {title, preamble}` when provided. The default remains `## Round events` with the
   existing referee-visible preamble, so battle's rendered event section stays byte-identical.
   Defs without the hook emit nothing. A def may also pin `factsSeriesPoints` (clamped 40..80) as its
   facts-table budget knob; battle pins 40.

### donna (robot agent 7) - a real three-robot humanoid match replay

The mission replays the closing 250 s of one RoboCup German Open 2025 match from three independently
recorded onboard ROS 2 rosbag2 logs. Donna, Jack and Rory are the Hamburg Bit-Bots' Wolfgang-OP
humanoids. An offline extractor aligns Jack and Rory to Donna's clock and emits `donna-team-v2`; the
browser decodes and replays the resulting static payload rather than simulating the telemetry.

The frozen attribution is verbatim: "Three Wolfgang-OP humanoids of the Hamburg Bit-Bots (Universitat
Hamburg), recorded at RoboCup German Open 2025."

The role split is mandatory and verbatim on both provenance surfaces: "recorded independently on each
robot by its onboard rosbag2 logger; converted offline for this demo; replayed here."
`context.provenance` reaches the analyst facts pack. `chatProvenance` is client-rendered above the
composer. Both explicitly say the AlloyLogger Arduino library did not capture the logs and no
AlloyLogger production pipeline ingested or produced the replay.

Donna remains the telemetry protagonist. Her six chart groups are torso IMU, command and motion
odometry, servo diagnostics, game-controller state, filtered ball estimates and onboard compute.
Jack and Rory do not contribute chart series. They contribute their own scene tracks, presence,
robot-state events, penalty state and speech rows. Every chart field is `REAL_MCAP` with a composite
transform token such as `DERIVED_MAGNITUDE+RESAMPLED_NEAREST_20HZ`,
`DERIVED_DIAGNOSTIC_AGGREGATE+ZOH_2HZ` or `DERIVED_RATIO+RESAMPLED_NEAREST_2HZ`, so a derived value is
never presented as raw wire data. The analyst smoke matrix separately probes this chart-source split.

The storyline is team-shaped. Jack falls 3 times and returns to WALKING after each fall while Donna
and Rory record 0 falls in the window. During the last recovery Jack's recorded `/speak` row says,
"This was definitely a foul." Rory re-enters from penalty at 28.072 s and gets her first live pose at
28.269 s. Donna serves 37.071 s off-field. Goals move the score to 5-0 with 162 s on the clock and to
6-0 at -31 s in added time; FINISHED arrives at -33 s. All teammate times are post-alignment on
Donna's clock and every quoted number is claim-ledger bound.

The scene uses the official Wolfgang-OP CAD body for all three robots. Each body is driven by that
robot's recorded joints, yaw-free torso tilt and segmented field pose. Presence is disclosed rather
than filled in. Jack's root pose is held at its last observed field position during each fall outage
while his recorded joints, torso attitude and state continue. Donna is hidden during her off-field
penalty outage. Rory is hidden before her first map fix. Consumers interpolate only within one live
pose segment and never across an unobserved gap.

The ball marker comes only from Donna's validated filtered estimate in the `map` frame. An exact
`(0,0,0)` pose, covariance trace at least 1500, stale nearest sample or clear `ballSeen` mask hides the
marker. Numeric zero in a masked ball column is filler, not an observation. `heroTime()` is 187.6 s,
strictly inside the healthy interval with all three robots present, live, upright and unpenalized,
Donna WALKING, the ball seen, and no fall within 5 s.

**FORMAT-V2 Amendment 2, eager preview.** Inspection of `core/preview.js`, `core/context.js` and the
Donna scene proves the picker and connect hero each pose the scene exactly once at 187.6 s. The picker
has no telemetry chart. `preview-data.js` therefore carries only one hero sample for each uniform
scene series, the two native localization samples bracketing the hero for each pose, one LIVE presence
row per robot, the Donna ball-field sample, and the CAD-derived proxy mesh. It removes all six chart
series, event rows, robot-state series, HUD series and non-runtime audit metadata. The unchanged scene
binder receives inert state and HUD adapters from `decode.js`; neither eager surface calls
`hudState()`.

The proxy retains all 52 part names, 133 visual placements and 21 driven buckets, with 645 vertices
and 1,072 unique triangles. It renders DoubleSide because the audited proxy has boundary and
non-manifold edges; the full mesh remains FrontSide. The full `donna-data.js` is byte-unchanged at
410,559 B gzip and remains behind the dynamic import. The current staged eager graph measures 57,265 B
gzip. Gzip output varies slightly across zlib and Node versions, so its frozen ceiling is the measured
graph plus 10 percent rounded up, 62,992 B; the margin absorbs that variation while keeping provenance
re-derivable, under the 86,016 B hard cap. The three-robot CAD justification and commit `1a0357a`, which
raised SSL and battle ceilings for the guided aha-flow copy, are cited in `donna-eager-size.test.mjs`.
Donna's facts pack measures 29,074 characters under the 31,500-character ceiling. The synchronous
decode gate runs three independently warmed batches of 50 decodes and requires the minimum batch p95
below 80 ms, removing transient machine load while a genuinely slow decode still fails all batches.

`eventsSection` is "Aligned match and onboard events" and identifies Donna-clock rows from Donna,
Jack and Rory. `context.oldwaySample` is re-derived from the new window: 40 consecutive Donna chart
lines around the first goal, including the 4-0 to 5-0 transition. Its authored row-times-field volume
is 28,515 values.

**Presence and licensing.** The redistributed CAD comes from `bit-bots/wolfgang_robot` under MIT.
The repository root `THIRD_PARTY_NOTICES` carries the upstream notice verbatim, and
`test:donna-notice` asserts its presence. The global footer says exactly: "Five synthetic missions,
one real match replay with planted fault overlays, and one real match replayed from three robots'
onboard logs. Runs entirely in your browser." The card title is "Donna, Jack & Rory", the fallback
icon carries three figures, and the global headline remains "Replay a mission."

## Chat scripts (per robot, 5-6 entries)

1. The firstQuestion (the headline failure): a confident, numerate diagnosis. Structure: one-line
   verdict, then a short mono "evidence table" (3-4 rows: metric, value, budget/expected), then the
   causal chain in 2-3 sentences, then the evidence chip(s). This is the wow answer; write it like
   a sharp field engineer, not a chatbot. No filler ("Great question!" is banned).
2. "Show me exactly where it failed" (matchers: show, where, see, replay, watch) → 1-2 lines +
   the alert evidence chip (re-fires the replay).
3. Root cause deep-dive (why/cause/root/fix) → cross-channel reasoning + concrete fix advice
   (gains, hardware, geometry), cites numbers.
4. The slow-burn/system question (heap/battery/temp/health) → its warn finding.
5. "How do I log this from my own robot?" (log, arduino, sketch, code, library, esp32, own robot)
   → real Arduino snippet in a code block. Synthetic missions say their fields came from
   `alloy.log()` calls. Real-log missions use the honest inversion: show how a visitor would log the
   same fields from their own robot, and never claim the replayed fields came from `alloy.log()`.
6. Optional flavor entry per robot (e.g. drone: "was the landing a crash?").
Fallback: "I have this mission's data loaded. Try one of these:" + suggested chips.

## Verification bar (integration/QA phase)

**The test run is `npm test`**, and it is the whole suite in dependency order:

| # | script | what it holds |
| --- | --- | --- |
| 1 | `test:harness` | the two generated-demo interpreters, against the runner's own gendata |
| 2 | `test:ssl-data` | the decoder, the provenance, the quoted values, the vision cross-check |
| 3 | `test:ssl-script` | the def: matchers, house format, non-causality, keeper, decisive kick |
| 3a | `test:battle-decode` | the battle decoder: ABI, preview/full parity, corruption, retry split |
| 3b | `test:battle-data` | battle: referee arithmetic re-derived, the claim ledger, the frozen incident table, the anachronism ban list |
| 3c | `test:battle-script` | the battle def: matchers, natural phrasing, disclosure, correct causality, every number against the claim ledger |
| 3d | `test:donna-decode` | Donna ABI, preview/full parity, corruption, retry split, module gzip ceiling and Node decode ceiling |
| 3e | `test:donna-data` | Donna channels, transforms, masks, events, fixtures and claim-ledger bindings |
| 3f | `test:donna-scene-pose` | recorded upright/fallen attitudes and joint-angle fidelity |
| 3g | `test:donna-hud` | score, state and whistle seeks with version completeness |
| 3h | `test:donna-script` | Donna matchers, evidence, attribution, role split, phrase bindings and banned product claims |
| 3i | `test:donna-facts-size` | Donna facts pack stays within 31,500 characters |
| 3j | `test:donna-deident` | generic identifiers plus private-manifest needles, fail-closed by default |
| 3k | `test:donna-notice` | redistributed Wolfgang-OP CAD retains its upstream MIT notice |
| 4 | `test:ssl-eager-size` | the eager payload budget, so the match module stays lazy |
| 4a | `test:battle-eager-size` | the same budget for the battle round: 46,900 B gz, the generated round module stays lazy |
| 4b | `test:donna-eager-size` | Donna's trimmed eager graph stays within 62,992 B gz and the 86,016 B hard cap |
| 5 | `test:ssl-leak:self` | the leak gate's own adversarial fixtures |
| 6 | `test:ssl-leak` | de-identification over the DEPLOYMENT SURFACE |
| 7 | `test:ssl-leak:repo` | de-identification over EVERY TRACKED FILE (`git ls-files`) |
| 8 | `test:nav-race` | browser: the lazy-payload navigation race |
| 8a | `test:battle-lazy-path` | browser: battle's own routes: the race, a corrupt round module, a corrupt preview |
| 8b | `test:donna-lazy-path` | browser: Donna's own routes: the race, a corrupt recorded module, a corrupt preview |
| 9 | `test:preview-fallback` | browser: a preview slice that will not decode |
| 10 | `test:preview-roster` | browser: a preview roster the scene cannot pose |
| 11 | `test:chart-absence` | browser: a masked series draws a break, not a zero |
| 12 | `test:corrupt-meta` | browser: five failure fixtures, below |
| 12a | `test:battle-hud` | browser: the HUD extension, SSL regression by re-derivation, version completeness |
| 13 | `facts:fresh` | `node worker/build-facts.mjs && git diff --exit-code worker/facts.generated.js` |

The browser-gated suites cover the SSL navigation race, battle and Donna lazy paths, preview
fallback and roster behavior, chart absence, corrupt metadata and the battle HUD regression. Both
leak modes run, and 6 and 7 are not the same surface. 6 scans what Cloudflare uploads; 7 scans what
anyone can clone and includes this document, the whole `gen-fixture/` directory and the worker. Both
FAIL on a machine without the private manifest, by design.

`test:corrupt-meta` drives five fixtures against the real app in Chromium. The first two are about
a payload that will not build:

- **A, pre-route.** `match-data.js` with the yellow-8 roster entry renumbered to yellow 88. The blob
  is untouched, so it decodes perfectly and the robot the kicker finding is about is simply not
  there; `validateSceneData()` rejects the LOAD rather than resolving into a doomed route.
- **B, post-route.** `visionCrossCheck.robots.blue13.bins` replaced by a scalar. Everything
  `validateSceneData()` inspects is intact, so the load RESOLVES and the throw happens inside
  `buildData()`, inside the synchronous `route()` the load continuation calls.

The other three are about a build that fails after resources exist, which is what A and B cannot
reach (`ensureData()` runs first, so both throw before a single component is constructed):

- **C.** `scene.js` patched to throw at the top of `buildScene()`, which `createViewer()` calls
  twenty lines after it mounts the WebGL renderer.
- **D.** `chart.js` patched to throw in `createChart()` for this def only, which is the line after
  `createViewer()` returned.
- **E.** a def whose `sceneApi.update()` throws on the first frame, the only point at which both
  timeline subscriptions, the ResizeObserver, the animation frame and the renderer are all live.
  Its timeline is a proxy counting subscribe against unsubscribe.

C, D and E each repeat three times against a probe installed before any application code runs, and
assert that the WebGL context count GROWS while the LIVE count does not, plus no leftover canvas or
viewer DOM, no connected observer, no queued frame and no held subscription.

The browser tests resolve playwright from an npx cache and SKIP loudly when there is none;
everything else runs on a bare checkout. `worker/smoke.mjs` is separate because it spends API
credit, and one of its calls is an ADVERSARIAL probe: it asks the causal question the def is
forbidden to ask ("why did bot 8 stop taking shots"), and grades the answer for naming the overlay
as synthetic and for containing no construction making the modelled kicker the reason for a real
behaviour.


Playwright against a local static server of the REPO ROOT (so `/demo/` paths match production).
For each robot: picker → card click → connect finishes → auto-question streams → evidence fires →
screenshot at (a) picker, (b) demo idle, (c) evidence moment (loop banner + highlight + zoomed
chart visible). Repeat (c) at 390×844. Assert via page state, not pixels: `timeline.loopWindow`
set, highlight part emissive > 0, chart domain ≈ finding window. WebGL runs headless (swiftshader);
screenshots must show an actual rendered robot, not a black canvas — check pixel variance on the
canvas. Save screenshots to the scratchpad dir given in your brief.

**Generated-demo smoke test** (the runner's `smoke.mjs`, run on every candidate before it can be
published). Same harness, one bundle: a local `node:http` server over the runner's `runtime/`
snapshot of this directory plus the candidate `def.json`, then `#/connect/g-<slug>` end to end.
Assert console and pageerror clean, the mission brief reads back the visitor's own robot, evidence
sets `timeline.loopWindow` and lights the highlight, and the canvas is really rendering. The brief
does not auto-advance, so the smoke clicks its CTA (`.ctx-ask`, or `.ctx-go` on a def with no first
question) rather than waiting. Repeat at 390x844 and keep the screenshots for the approval DM.

The canvas check is **pixel variance between two different timestamps**, not one frame against
black: a scene that builds but never moves passes a single-frame check and is exactly the failure
this gate exists to catch. Read the pixels through the compositor (screenshot the canvas element),
never `gl.readPixels`. A WebGL back buffer is cleared after every composite unless the context was
created with `preserveDrawingBuffer: true`, which this app deliberately does not set, so a direct
read gets a black or torn buffer and the test fails on a demo that is perfectly fine.

## Picker previews

`js/core/preview.js` replaces the picker cards' static line art with a live, slowly orbiting 3D
preview of each robot's real `buildScene()` model.

`createPickerPreviews(entries, host)` takes `[{ el: <.rcard-art>, def: robotDef }]` and returns
`{ phaseFor(id), dispose() }`. `app.js` collects the entries in `buildPicker()`, mounts on entering
`#/` and calls `dispose()` on leaving it, so the picker's context is released before the demo viewer
opens its own.

`phaseFor(id)` reports where that card's camera is RIGHT NOW as `{ az, elev, dist, fov, fill }`, or
`null` before the card has been built and framed and while the context is down. The contextualization
screen's hero uses it to open on the same shot the card was showing, so the hand-off does not jump.

**The one-context rule.** There is exactly ONE `WebGLRenderer` for all the cards, never one per
card. Its canvas is a transparent `position: fixed; inset: 0; pointer-events: none` overlay, and
every rendered frame each card's `getBoundingClientRect()` becomes a `setViewport` + `setScissor`
pair (`setScissorTest(true)`, `devicePixelRatio` capped at 1.5). That is the three.js
multiple-elements pattern: previews stay glued to their cards through scrolling, resizing and the
card's hover lift, with no per-card context and no layout coupling. The whole canvas is cleared
before the per-card passes so a card that scrolls away leaves nothing smeared behind it.

**Perceived performance.** The inline SVG is the instant placeholder AND the no-WebGL fallback, and
it is only faded out (400 ms opacity, `.rcard-art.preview-live`) once its robot has rendered a real
frame. `buildPicker()` still never calls `ensureData`; telemetry generation and scene construction
happen after first paint, one robot at a time on `requestIdleCallback` (`setTimeout` fallback), and
the renderer itself is created lazily inside that first idle slice. Measured cold boot: FCP 36 ms
with all the SVG placeholders visible, first `buildData` at 59 ms, all previews live at 109 ms.

**Framing.** Each preview scene gets its own hemisphere plus key and fill lights (brighter than the
viewer's, since there is no lit ground plane behind a 92 px card), a transparent background and no
ground grid. The model is posed ONCE at a healthy hero moment, never the failure:
`{ sbr: 20, arm6: 30, drone: 30, rescue: 22, ssl: 60.44 }` seconds, falling back to `duration * 0.3`
(rescue is posed before its thermal build-up: its `update()` drives a heat glow, so a late pose
reads as a red robot). A def may override the table with its own `heroTime()`, which is how ssl
poses correctly against whichever payload is in hand: the preview slice's clock is its own, so the
same instant is 60.44 s in the match export and 2.765 s in the slice.

**Framing overrides.** `fitOrbit` takes optional `{ focus, envCull, envRadius, distScale }`, and a
def supplies them once as `def.preview` for BOTH staged screens, so a card and the hero it flies
into are culled and centred identically. Defaults are unchanged for a def that ships none. ssl needs
them: the solve's defaults are tuned for a machine on a table and on a 12 x 9 m pitch they keep the
carpet and lose the robots, so its block pulls the cull in to a cluster around the ball.

**Neither staged screen builds telemetry for a def with a lazy scene payload.** `ensureData` is a
tripwire for those defs (see the RobotDefinition interface): the picker and the brief run entirely
off `previewData`, and only the demo route awaits `loadSceneData()`. The test is the CAPABILITY,
never the payload - `previewData` is null whenever the preview slice failed to decode, and reading
that null as "legacy robot, build its telemetry" walks straight into the tripwire on a route with
no error handling. A def whose payload will not decode keeps its SVG line art on both staged
screens, exactly like the no-WebGL and context-lost paths, and its demo route is unaffected.
`ssl-preview-fallback.test.mjs` serves a mangled `preview-data.js` and drives all three screens.

### Lazy scene payloads and the route

`resolveSceneData()` in `app.js` parks a loading card, awaits the payload and hands the route back
to `route()`. **Every entry into that route gets its own continuation**, even while an earlier load
of the same robot is in flight: the LOAD is already deduplicated inside the def, so a second entry
costs a `.then` and nothing else, while a second entry that returned early instead would leave the
route with no continuation at all - and the first continuation, tied to a navigation generation two
navigations old, correctly refuses to touch the screen. Nothing then renders, and the hash sits on
`#/demo/<id>` over whatever screen happened to be showing, permanently. Ordinary browsing reaches
it: demo -> back to the picker -> the same demo, and demo -> that robot's brief -> demo, both
inside one load. Staleness is the generation captured at ENTRY; when it still holds, the route is
re-entered against the CURRENT hash rather than the one that started the load.
`ssl-nav-race.test.mjs` throttles the import and drives both sequences.

Scenery
markedly bigger than the shot or far from the machine (drone's survey field and flown track,
rescue's rubble ramp and scattered debris) is hidden, then the camera orbits the remaining
subject's centre at its `cameraHome` azimuth and elevation, 14 s per revolution, at a
bounding-box fit distance capped at `0.9 x` the robot's own `cameraHome` distance.

**Budget.** One rAF for all previews, throttled to ~30 fps, cards outside the viewport skipped
via `IntersectionObserver`, and rendering stops entirely while `document.hidden`. Under
`prefers-reduced-motion` each card renders a single static frame and only re-renders when a rect
actually moves, so the 3D is still there but nothing orbits.

## Personalized demo generator

A visitor who has played with a canned robot can ask for the same demo built for THEIR robot. They
describe it, verify their email, a headless Opus job on Hugh's MBP authors a `def.json`, Hugh
approves it, and they get an unguessable link. Email capture is the point; the demo is the bait.

**URL shape.** `#/connect/g-<slug>`, slug `^[a-z2-7]{20}$` (100 bits, unguessable, the only access
control there is). Same two screens a canned robot uses: the mission brief, then `#/demo/g-<slug>`.

**The bundle.** ONE document, `GET /demo/js/robots/g-<slug>/def.json`, resolved by the Worker out of
the Durable Object rather than from disk. 404 until the job is `approved`; `?preview=<approve token>`
serves it earlier to whoever holds Hugh's signed approval link, `no-store`. A slug the DO does not
know falls through to the asset handler, so a committed fixture directory stays addressable. No
other file under a slug is servable. **No generated JavaScript, ever.**

**Load path.** `app.js` `route()` sees an id matching `GEN_ID_RE` that is not in the registry, parks
a loading state on the connect screen (route state `gen`, its own teardown) and calls
`loadGeneratedRobot(id)` in `robots/generated.js`. Both that state and the dead-link state are
rendered by `renderGenCard`, in the mission brief's own frame: the same `.ctx` two-column layout,
the same hero panel standing the generic line art in for a machine there is no def for yet, and the
same `.ctx-go` button in the CTA slot. It is built by hand rather than through `createContext`
because at that point there is nothing to brief and no `buildScene` to stage. That fetches, runs a
structural gate, hands
`scene_spec` to `buildSceneFromSpec` and `data_spec` to `buildDataFromSpec`, composes a normal
RobotDefinition with `deviceId` + `generated: true`, then `registerRobot(def)` and re-enters
`route()`. Any failure at any step is null, logged once with its reason, and renders "This demo link
is not available. It may have expired." rather than bouncing to the picker: a visitor who followed a
personal link deserves to be told the link is dead. In-flight and navigated-away guards both apply.
The def contract, including what the interpreters guarantee, is `demo/GENSPEC.md`.

**Entry: SHELVED 2026-07-28.** The lead-form module, its header button and the
`POST /api/demo-gen/submit` call are all deleted from this app (git history has them). Nothing in
the demo asks a visitor for a demo any more. What is described below the fold here still serves
every link already sent.

**State machine** (owned by `DemoGenDO`, `worker/do.js`; the runner drives only the transitions it
is allowed to). The machine itself is UNCHANGED by the shelve. What changed is that the two things
that drive it are off: no new job can enter, and the LaunchAgent that walked jobs along it is
disabled, so every edge marked PAUSED only moves under a supervised manual runner tick.

```
unverified --(visitor clicks the verify link)--> pending      CLOSED: verify renders a paused page
pending    --(runner claim, 30 min lease)-----> claimed       PAUSED: manual tick only
claimed    --(generate, validate, smoke, publish)--> generated PAUSED: manual tick only
generated  --(Hugh taps the signed approve link)--> approved  LIVE
generated  --(AUTO_APPROVE_AFTER_H, ships unset)--> approved  PAUSED: no timer runs
approved   --(runner review sweep sends the ready mail)--> emailed  PAUSED: manual tick only

terminals
  refused          model returned the refusal shape -> refusal email (PAUSED)
  error            3 failed attempts, or publish failed -> apology email (PAUSED)
  delivery_failed  the mailer rejected the address. Retryable: the runner records the mail KIND in
                   a persisted intent marker that survives the failure, so a retry makes a real
                   second provider call (see worker/runner-patches/)
  expired          unverified 7 d, or generated and stale 48 h -> apology email (PAUSED)
  rejected         Hugh tapped reject; the bundle is deleted and the origin 404s. LIVE
```

Draining that queue at shelve time is what `GET /api/demo-gen/runner/state` exists for: it reports
one count per state above (plus `unknown`), `review_total` and `next_claim_expiry_s`. The queue is
drained when `pending`, `claimed`, `generated`, `approved`, `delivery_failed`, `unknown` and
`review_total` are all zero and `next_claim_expiry_s` is `null`; terminal `emailed`/`rejected`
rows remain by design, and `unverified` rows are removed by the one-time shelf purge afterwards. A `pending` or `delivery_failed` job Hugh declines to finish is ended with
the allowlisted `POST /api/demo-gen/runner/shelf-purge`, per job, because the machine has no
`pending -> rejected` edge and `delivery_failed` can only ever go to `emailed`.

No cache purge is implemented. The def.json response carries `Cache-Tag: demogen-<slug>` so
one can be wired later, but nothing calls the purge API today: rejecting a demo that was
already approved leaves an edge-cached copy servable for up to the one hour `max-age`. That is
an accepted residual, because a reject lands minutes after generation and before the link has
been sent to anyone.

**Approval gate.** Nothing is emailed to a visitor that Hugh has not seen. The approve and reject
links are per-job single-use HMAC tokens sent in a Slack DM, NOT the runner bearer, and the GET only
renders a confirm page (robot, email summary, their use case, recipient, bundle size and hash, plus
a preview link into the real demo). The POST is what commits, so a link scanner following the GET
cannot approve anything. Auto-approve exists behind `AUTO_APPROVE_AFTER_H` and ships unset.

**Chat.** A generated demo uses the same live analyst as a canned one, `POST /demo/api/chat`. Its
facts pack is built by the runner from this repo's own `worker/build-facts.mjs` and published beside
the def; `chat.js` fetches it per request out of the DO by slug. `def.chat.script` stays in the
bundle as the offline fallback and is still fully validated. See `worker/README.md` for that path
and for everything operational (deploy, the facts freshness gate, which states answer).

## Signup popup (`core/signup.js`)

What replaced the lead form. It sells the product instead of the demo: after a visitor has
MEANINGFULLY engaged with a dataset, one modal drives straight to signup. It CAPTURES the address
in the dialog rather than handing the visitor off to another page: an email field, a submit, and a
confirmed pane in the same card. **There is no redirect anywhere in this flow**, and the earlier
"no form, no email field, no network call of any kind" description is superseded by this section.
The one call it makes is `POST /api/signup-lead` (surface 6 in the non-negotiables).

**Copy** (no em dashes): headline "Let's analyse your robot data now", body "Sign up and get 100GB
free. First 100 users only.", field placeholder "Work email", submit "Claim 100GB free", and a
close X (no secondary dismiss button). Confirmed pane: heading "You're in.", body "We'll set
you up and email your access shortly." Inline errors: "That email doesn't look right." under the
input for a rejected address, "Something broke. Try again." for a failed round trip.

**Submit.** The client validates non-empty plus a deliberately loose email pattern BEFORE posting
(the server is the authority; a client regex that argues with a real address is a lost lead), then
disables the control into a `sending` state and posts
`{ email, hp, dwell_ms, robot, src }` as JSON, same origin.

- `202` swaps the card to the confirmed pane. It is the ONLY success the client admits to, and it
  deliberately covers the server's silent drops (honeypot, per-IP cap, duplicate), because
  distinguishing them here would leak on the client what the endpoint refuses to leak on the wire.
- `400` with `reason: 'bad_email'` shows the inline hint under the input and refocuses it. The
  typed value is preserved.
- Anything else, including a transport failure, shows the generic inline error. The typed value is
  preserved, and the visitor can submit again.

`hp` is the honeypot: a hidden field a human never fills, sent as the empty string. `dwell_ms` is
time since the dialog opened. `robot` is the demo being viewed (`getRobot()`, a `g-<slug>` demo
included) and `src` is the boot `?src=` attribution the header CTA already forwards, so a lead can
be traced to the campaign that produced it without a redirect carrying UTM parameters.

**Size.** Near fullscreen, not a card. Desktop is a `min(1560px, 100vw - 64px)` by `88dvh` panel
(uncapped heights and the wide max so it still covers >=80% of a 1920px monitor) with the copy
block vertically centred (auto margins, so an overflowing card can still scroll to its top) and
hero-scale type: headline
`clamp(34px, 4.6vw, 62px)`, body `clamp(16px, 1.5vw, 22px)`, buttons up to 18px. At 899px and below
(`@media (max-width: 899px)`, the same breakpoint the chart drawer and the demo shell use) it is
a `100dvh` takeover with safe-area padding on all four sides, no radius and no border, actions
stacked full width. Same colours, blur and rounding language as the rest of the demo, just at
panel scale. Zero horizontal scroll at 390px.

**Dismissal.** Explicit controls only: the close X and Escape, in every state including mid-send.
Clicking or tapping the scrim does NOT dismiss, deliberately: at this size the scrim is a
thin margin around the panel and a mis-click there would throw away the session's single ask. The
focus trap (Tab/Shift-Tab cycling inside the card, focus restored to the previously focused node on
close) and the space-key stopPropagation that keeps the demo from pausing under the dialog are
unchanged.

**Trigger.** An explicit `idle -> armed -> timerPending -> shown` machine owned by the module and
wired in `buildDemo`/`teardownDemo`. Arming signals are USER-ORIGINATED events only, never
`timeline.onChange` (autoplay and programmatic seeks fire it) and never `chat.onAsk` (the
auto-opener fires it): pointer/touch on the 3D viewer's actual render surface (the canvas, not all
of `#viewer-mount`), viewer wheel zoom, keyboard arrow scrub, pointer/touch on the scrub UI
controls (not wheel over `.v-scrub`, which does nothing and would arm on ordinary page scrolling),
chart seeks (the `chart:seek` event, not a bare canvas click, so a click in the chart's padded
gutters that the chart itself ignored does not arm), evidence and suggestion chip clicks, and a
composer submit that is both `isTrusted` and carries a non-empty captured value.

**Quiet period.** A 6 s timer that starts only once the arming action has ENDED and resets on any
further activity: a pointer interaction counts as active until `pointerup`/`pointercancel` (a held
10 s orbit never fires mid-drag), and composer focus with text, a keystroke inside the window or an
open IME composition (`compositionstart` until `compositionend`/blur) all suppress.

A typed question is a HOLD, not a restart. A qualifying submit raises a pending-answer hold before
it arms, so the timer does not merely start again from the submit, it does not run at all until
`chat.onSettled` says that answer is on screen. `isStreaming()` alone cannot cover this: when a
live answer dies before its first token, `chat.js` discards the shell (clearing `streaming`) and
only then schedules the scripted fallback on a 220 ms think beat, so for 220 ms the panel reads as
idle with the visitor's answer unwritten, and a timer expiring in that gap would open the dialog
mid handoff. One settle drops the hold entirely rather than decrementing it, because a superseded
answer never settles (see the core interfaces) and a per-settle decrement would strand the hold the
first time a visitor asked twice in a row. A settle with no hold outstanding (the auto-opener's) is
a no-op, never an underflow.

Fire-time guards: `currentRoute.name === 'demo'`, no pending answer, not streaming, no pointer
down, no active composition, and the storage gate re-checked immediately before opening.

**Gating.** localStorage `alloy_signup_seen` is written ON OPEN (impression-based), 7 day cooldown,
re-checked immediately before open, with a `storage` listener that disarms when another tab shows
it first. An impression requires visibility: never open while `document.visibilityState ===
'hidden'`, hold until visible, so a background tab cannot silently consume the cooldown. A
module-scope `everShown` flag makes it one-shot per page load and `teardownDemo()` NEVER resets it
(distinct from the resettable trigger machine), so a browser with localStorage unavailable still
sees it at most once. The old lead form's set-on-SCHEDULE bug is explicitly not copied: clearing a
pending timer re-arms.

**Teardown.** `teardownDemo()` closes an open popup, cancels timers, resets the machine to `idle`
(but not `everShown`) and removes every listener it installed. Route churn is QA'd by counting
listeners on persistent mounts, not only WebGL contexts.

**Generated demos.** It shows on `g-<slug>` demos too. `def.generated` suppresses nothing.

**Analytics.** `data-analytics-todo` markers only, per Out of scope: `signup_popup_shown`,
`signup_popup_submitted`, `signup_popup_failed`, `signup_popup_dismissed`. The old
`signup_popup_clicked` is gone with the CTA link it named: the conversion event is now a submit
that the server accepted, not a click that left the page.

## Out of scope

Real auth, PostHog wiring (add a `data-analytics-todo` comment where events would go), deploy (Hugh
gates), changes to landing `index.html`, service workers. There is no user auth and there are no
accounts; the only backend surfaces are the ones listed in the non-negotiables, and a generated
demo's slug is the entire access-control story.
