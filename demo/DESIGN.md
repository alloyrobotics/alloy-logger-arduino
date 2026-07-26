# AlloyLogger Live Demo — build contract

A try.usealloy.ai-style interactive demo, fully static, served from this repo at `/demo/`.
The pitch: pick a robot → watch its telemetry "ingest" → an AI analyst answers "why did my robot
fail?" → **the answer drives a synchronized 3D replay + chart to the exact failure window**, with
the failing part highlighted. Mobile-first (IG traffic lands on phones). Zero backend.

This file is the single source of truth. Do not invent interfaces not specified here.
If something is ambiguous, pick the simplest thing consistent with this doc and note it in your report.

## Non-negotiables

- **Pure static ES modules. No build step, no framework, no CDN at runtime** except the Google Fonts
  link already used by the landing page (`Geist` + `Geist Mono`). Three.js is VENDORED into
  `demo/vendor/` (pin `three@0.166.1`, module build + `OrbitControls`, wired via an import map).
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
  js/core/ingest.js     ← scaffold agent
  js/core/prng.js       ← scaffold agent (mulberry32 + gaussian + 1D value-noise helpers)
  js/core/markdown.js   ← scaffold agent (tiny renderer: bold, inline code, tables, lists, headings)
  js/robots/index.js    ← scaffold agent (registry; imports the four robot defs)
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
the window; a "reset zoom" affordance appears when zoomed.

`chat.js` — `createChat(mount, robotDef, { onEvidence })`; renders history, streams answers
(typewriter, ~3 chars per frame, instant-finish on click), parses the markdown subset, renders
evidence chips (`Geist Mono`, `▸ 51.7 s · Fall` style). Matching: lowercase the user input, score
each script entry by matcher hits, best score wins, tie → first; zero hits → canned fallback that
lists the suggested questions. When an answer containing evidence finishes streaming, auto-fire
`onEvidence(finding)` for the FIRST evidence item (chips re-fire it on click).

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
2. **Connect** `#/connect/:id`: the ingest terminal, centered card.
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

## Out of scope

Real auth, real backend, real LLM calls, PostHog wiring (add a `data-analytics-todo` comment where
events would go), deploy (Hugh gates), changes to landing `index.html`, service workers.
