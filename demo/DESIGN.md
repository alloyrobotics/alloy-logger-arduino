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
  detail. The page calls exactly TWO of the list below (1 and 4); everything else is entered from
  an email link or by the runner. The old "exactly four" wording is superseded by this list, which
  now states which of them are live and which the 2026-07-28 shelve closed.
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
  js/core/signup.js     ← scaffold agent (post-engagement signup popup; makes NO network call)
  js/robots/index.js    ← scaffold agent (registry; imports the four robot defs; registerRobot() for generated ones)
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
  vendor/three.module.js, vendor/addons/OrbitControls.js  ← scaffold agent
```

Each robot dir exports one default object from `data.js`'s sibling `index.js`? No — keep it simple:
`script.js` is the robot's entry: `import` its own `data.js` + `scene.js` and
`export default robotDef`. `js/robots/index.js` imports the four `script.js` entries.

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
      severity:'alert'|'warn',
      focus:{ channel:'/balance', fields:['pitch','output'] },
      highlight:'body',            // part id passed to scene.setHighlight
      slowmo:true }                // play the window at 0.4x
  ],
  context: {                       // OPTIONAL. Authored copy for the contextualization screen.
    system: 'One sentence on what the machine is and what it logs.',  // the only field RENDERED today
    mission: 'One sentence on what this mission was.',                // authored + derived, currently unrendered
    fault: 'One or two sentences on what went wrong, in field-engineer voice.',  // ditto
    label: 'stall',                // ditto
    faultT: 48.4                   // ditto
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
    //   cameraHome }              ← optional {position,target} for the reset-view button
  }
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
zoom limits) with autorotate OFF. It subscribes to the timeline and calls `sceneApi.update(t, data)`.
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

`chat.js` — `createChat(mount, robotDef, { onEvidence, onSettled })`; renders history, streams
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

**`onEvidence(finding)` in app.js is the money interaction, in this exact order:**
1. viewer scrubber flashes the finding marker; timeline `setLoop(finding.window, {speed: finding.slowmo ? 0.4 : 1})` and `seek(window[0])`, `play()`.
2. chart switches to `finding.focus` channel/fields and calls `focus(finding)`.
3. `viewer.setHighlight(finding.highlight)` pulses the part.
4. A dismissible "evidence banner" over the viewer: `● {title} · looping {a}–{b} s · tap to exit`.
Dismissing (or asking the next question) clears loop + highlight + zoom back to full domain.

`ingest.js` — the faux connect sequence between picker and demo: a mono terminal card streaming
plausible lines (`alloy.begin("robots/sbr")`, `POST /v1/chunk 202 (14.2 KB)`, `mesh table
alloy.fleet.balance +3894 rows`, `mission finalized → sbr-01.mcap`), ~2.5 s total, then auto-advance.
Lines derive counts from the robot's actual channel row counts. Skippable via "skip".

## Screens (hash-routed: `#/`, `#/connect/:id`, `#/demo/:id`)

1. **Picker** `#/`: header (AlloyLogger wordmark linking to `/`, "Live demo" chip), headline
   "Replay a real mission.", sub "Pick a robot. Ask it why it failed." Four cards: inline-SVG
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
3. **Demo** `#/demo/:id`: desktop = chat left (420 px), right column = viewer (~58 vh) over chart.
   Mobile (<900 px) = viewer top (~42 vh, sticky), chart collapsible beneath it, chat fills the rest,
   input pinned to bottom. Header: back arrow to picker, robot name + device, the two CTAs as
   compact buttons.

The `?robot=<id>` query param on any load deep-links straight to `#/demo/<id>`.

## The four robots (storylines are FIXED; hit these numbers)

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
   → real Arduino snippet in a code block + one line: free tier, `alloy.begin()` and every field
   in this demo came from `alloy.log()` calls.
6. Optional flavor entry per robot (e.g. drone: "was the landing a crash?").
Fallback: "I have this mission's data loaded. Try one of these:" + suggested chips.

## Verification bar (integration/QA phase)

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

**The one-context rule.** There is exactly ONE `WebGLRenderer` for all four cards, never one per
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
with all four SVG placeholders visible, first `buildData` at 59 ms, all four previews live at 109 ms.

**Framing.** Each preview scene gets its own hemisphere plus key and fill lights (brighter than the
viewer's, since there is no lit ground plane behind a 92 px card), a transparent background and no
ground grid. The model is posed ONCE at a healthy hero moment, never the failure:
`{ sbr: 20, arm6: 30, drone: 30, rescue: 22 }` seconds, falling back to `duration * 0.3` (rescue is
posed before its thermal build-up: its `update()` drives a heat glow, so a late pose reads as a red
robot). Scenery
markedly bigger than the shot or far from the machine (drone's survey field and flown track,
rescue's rubble ramp and scattered debris) is hidden, then the camera orbits the remaining
subject's centre at its `cameraHome` azimuth and elevation, 14 s per revolution, at a
bounding-box fit distance capped at `0.9 x` the robot's own `cameraHome` distance.

**Budget.** One rAF for all four previews, throttled to ~30 fps, cards outside the viewport skipped
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
MEANINGFULLY engaged with a dataset, one modal drives straight to signup. No form, no email field,
no network call of any kind.

**Copy** (no em dashes): headline "Let's analyse your robot data now", body "Sign up and get 100GB
free. First 100 users only.", primary CTA "Start streaming free", secondary "Keep exploring" plus a
close X.

**CTA.** The boot-computed `setupHref` (the same `SETUP_URL` constant and `?src=` forwarding the
header CTA uses) with `utm_content=<src>-demo-popup`, or bare `utm_content=demo-popup` with no
`?src`, so PostHog can separate popup clicks from header-CTA clicks. Opens in a new tab.

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
`signup_popup_clicked`, `signup_popup_dismissed`.

## Out of scope

Real auth, PostHog wiring (add a `data-analytics-todo` comment where events would go), deploy (Hugh
gates), changes to landing `index.html`, service workers. There is no user auth and there are no
accounts; the only backend surfaces are the ones listed in the non-negotiables, and a generated
demo's slug is the entire access-control story.
