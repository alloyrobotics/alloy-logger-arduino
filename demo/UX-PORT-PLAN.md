# UX wall port plan (branch ux-wall-port)

Port of the approved UX wall (alloylogger-ux-wall revision e577865) into the live demo.
DESIGN.md remains the base contract; this plan governs where the two differ for the four
active missions. The wall supplies information architecture, interaction sequence, copy
hierarchy and responsive layout. Its placeholder SVG robot art is NOT ported: every robot
visual is the production Three.js scene, telemetry, motion and evidence.

## 1. Existing architecture map (discovery summary)

- Hash routes today: `#/` (doorway), `#/start` (role fork), `#/missions` (picker),
  `#/connect/:id` (brief), `#/demo/:id`. Router in `app.js` with navGen staleness,
  per-route teardown, transactional buildDemo, lazy `loadSceneData` continuations.
- Role model in `core/role.js`: hobbyist/engineer/lead/marketing, persisted in
  `alloy_demo_role`, super-property in PostHog, sent to `/demo/api/chat` and
  `/api/signup-lead`. Worker normalizes via `worker/roles.js`; role registers in
  `worker/chat.js` change answer altitude, never facts.
- Guided flow v1 (`core/guide.js` + `def.choreo.beats`) was superseded by the inline-evidence
  chat surface and removed in round 3. Mission role openers remain behind their existing lazy
  boundaries without carrying guide beats.
- Core surfaces: timeline (loop/speed/seek), viewer (sceneApi contract: update,
  setHighlight, cameraHome, cameraFocus, followTuning, hudState, rendering; no projection
  or label machinery today), chart (channel/field chips, focus(finding) with
  failure-toned shading, no inline labels today), chat (streaming, script matching,
  inline evidence hydration, role-aware live calls),
  signup (engagement trigger machine, 7-day cooldown, `/api/signup-lead`).
- Registry: `ROBOTS` array is BOTH picker order and route registry (7 missions).
  Facts packs for all 7. Eager gzip gates for ssl/battle/donna static graphs.
- Generated demos: GENSPEC v1 def.json is a published API; unknown top-level fields are
  rejected by the runner and dropped by `generated.js` composition. Canned
  RobotDefinitions accept new optional fields safely.

## 2. Route and flow state machine

New public route table (parseHash):

| Hash | Screen |
| --- | --- |
| `#/` | doorway: stored role -> `#/connect/<roleMission>/robot`; else `#/start` |
| `#/start` | seat fork |
| `#/missions` | mission library (4 cards) |
| `#/connect/:id` | legacy brief for non-experience defs (sbr, rescue, battle, g-*); experience defs redirect (location.replace) to `#/connect/:id/robot` |
| `#/connect/:id/robot` | step 1/3 Understand the robot |
| `#/connect/:id/mission` | step 2/3 Understand the mission |
| `#/connect/:id/failure` | step 3/3 See the failure; its CTA ("Ask Alloy") hands straight to the demo |
| `#/connect/:id/choose` | RETIRED (round 3). `location.replace` to `#/demo/:id` |
| `#/demo/:id` | the chat surface. ONE transcript, no internal modes |

**ROUND 3 (2026-08-06 UX wall).** Two structural changes to this section:
- The fourth step is deleted. It asked "how do you want to debug it?" and answered it with three
  comparison cards, one screen before a demo whose whole job is to answer that by doing it. The
  hash is redirected rather than 404ed because real sessions have it in their history.
- The demo's internal modes are deleted. Evidence now renders INSIDE the answer that cites it
  (`core/embeds.js`: annotated seekable chart, causal line, live 3D replay), so there are no panels
  left to arrange and a follow-up is just another message.

Rules:
- Step routes are real hash routes: Back/Forward walk the steps; reload re-enters a step.
- A step route for a def without `experience` redirects to `#/connect/:id` (legacy).
- Unknown ids keep today's behavior (missions redirect / g-* load path).
- `?robot=` deep link keeps its semantics; for experience defs the "brief" destination is
  `#/connect/:id/robot`, and `alloy_brief_seen_<id>` keeps gating brief vs demo.
- navGen staleness and the loading-card pattern extend to step routes: entering
  mission/failure (or demo) for a lazy def parks the loading card and awaits
  `loadSceneData()` with a generation-aware continuation. `robot` step runs on
  previewData when the full payload is not yet loaded (kick the load off in background).
- Teardown: one flow module owns all three step screens and disposes viewer/labels/RAF/
  listeners on exit; `show()` gains the new screen container; `screenState()` fixture
  helper updated to include it.

The demo surface (round 3; supersedes the chat/proof/followup modes this section described):
- ONE full-height transcript at every viewport, centred at a reading measure, composer pinned
  to the bottom. No fixed replay stage, no telemetry pane, no `Show why`.
- An evidence-bearing answer (scripted opener, scripted suggestion, or a live streamed answer
  carrying an evidence chip) mounts an inline block into its own bubble: annotated seekable
  chart, then the short causal paragraph, then the live 3D replay.
- ONE WebGL context for the whole screen. The shared viewer element is moved into the block
  nearest the reader's centre; every other block shows a poster captured off that renderer at
  handover. `#viewer-mount` survives as the off-screen park the viewer lives in between blocks,
  and BEFORE the first one: the renderer is built there a frame after the screen mounts rather
  than on the frame a block first asks for it, so activation is a reparent and a resize.
- The shared TimelineStore is unchanged: seeking any block's chart moves the mission clock,
  which moves the live replay. Taking the context is what makes a block's finding the active
  loop.
- `#screen-demo` still carries `data-mode="chat"` as one constant value (chat.js keys the wall's
  answer typography off it, analytics reports it); nothing branches on it.

## 3. Mission experience schema (backward compatible)

Optional per-def block, canned defs only. Never added to GENSPEC v1 or def.json.

```js
experience: {
  anatomy: {
    camera: { position:{x,y,z}, target:{x,y,z} } | null,  // default cameraHome
    rotation: 'orbit',            // slow deliberate orbit; reduced-motion = static pose
    heroT: <seconds> | undefined, // default stage3d heroTime(def)
    parts: [ { id, anchor, label, description } ]         // exactly 4
    // anchor resolves through sceneApi.anchors() (below)
  },
  success: {
    window: [a, b],               // real healthy passage; never overlaps failure finding
    camera: {...} | null,
    loopLabel: '...',             // e.g. "success loop"
    contextualLabels: [ { label, note? } ]  // mission-truth labels, role-invariant
  },
  failure: {
    findingId: '...',             // MUST resolve in def.findings
    camera: {...} | null,
    plottedFields: { channel, fields } | undefined  // default finding.focus
  }
}
```

- arm6/drone: `experience` set statically in `script.js` (no eager gate on them).
- ssl/donna: attached by their existing lazy side-module pattern (`applyRoleOpeners` or
  `applyExperience`, loaded with `loadSceneData`) so eager gzip gates stay green. A tiny static stub flag
  (`hasExperience: true`) marks them for routing before the payload lands.
- Generated g-* defs and sbr/rescue/battle have no `experience`: legacy flow, untouched.
- Facts builder does not read `experience`; facts:fresh stays byte-identical.

Scene anchor interface (optional, additive):
```js
sceneApi.anchors?.() -> { [partId]: () => THREE.Vector3 /* world position, posed NOW */ }
```
Backward compatible: viewer treats absence as "no anatomy support". update/setHighlight/
cameraHome/cameraFocus/dispose signatures unchanged. Viewer gains an anatomy overlay
(HTML cards + SVG leader lines) projected via `Vector3.project(camera)` every render
frame, so labels stay attached while the camera orbits or the robot moves; anchors
behind the camera or off-frustum hide their leader line. Wall layout keeps the four
cards in corner slots (2x2 rows on mobile); the leader lines tie each card to its
projected anchor per the build contract (wall art had none; task requires them).

## 4. File ownership (exclusive, one writer per path)

| Lane | Model | Paths |
| --- | --- | --- |
| SOL-A flow+shell | GPT-5.6 Sol | `demo/js/app.js`, `demo/js/core/flow.js` (new), `demo/js/core/start.js`, `demo/js/core/role.js`, `demo/index.html`, `demo/js/core/analytics.js`, `demo/js/robots/index.js` |
| SOL-B surfaces | GPT-5.6 Sol | `demo/js/core/chart.js`, `demo/js/core/chat.js`, `demo/js/core/signup.js`, `demo/js/core/flow-copy.js` (new) |
| OPUS-V viewer | Opus 5 | `demo/js/core/viewer.js`, `demo/js/core/stage3d.js` |
| OPUS-M1 | Opus 5 | `demo/js/robots/arm6/**` |
| OPUS-M2 | Opus 5 | `demo/js/robots/drone/**` |
| OPUS-M3 | Opus 5 | `demo/js/robots/ssl/**` |
| OPUS-M4 | Opus 5 | `demo/js/robots/donna/**` |
| SOL-T tests | GPT-5.6 Sol | `demo/js/robots/gen-fixture/*` (new gates + updates), `package.json` scripts |
| Fable | inline | this plan, arbitration, synthesis, final review |

CSS ownership: page and layout CSS (screens, steps, grids, breakpoints) lives in
`demo/index.html` (SOL-A). Component-scoped styles for surfaces owned by other lanes
(chart direct labels, chat modes, viewer anatomy overlay) are injected by their owning
module, following the existing `#v-shud-css` precedent in viewer.js. No lane edits
another lane's file for styling.

Worker files (`worker/*`) are NOT owned by any lane: no interface change was found that
requires touching worker or Durable Object code. `worker/roles.js` registers already
cover all four roles. If a lane believes it needs a worker change it must stop and
escalate to the orchestrator.

## 5. Anatomy definitions (4 parts each, real geometry only)

Copy below is the approved wall copy where the wall authored it (ssl); other missions
follow the same register. No em dashes anywhere.

### ssl (mandated set; anchors are real hull positions)
| id | anchor | label | description |
| --- | --- | --- | --- |
| omni | hull base ring of bot_y8 | Omni drive | Four wheels move in any direction without turning first. |
| imu | top plate centre | IMU | Tracks orientation while the controller closes the motion loop. |
| kicker | forward hull behind the dribbler mouth | Kicker bank | A 240 V capacitor bank stores the energy for each shot. |
| dribbler | dribbler face local point (DRIB_OFF) | Dribbler | A 25k rpm roller keeps the ball under control. |

The subject is one real robot (bot_y8, the mission's protagonist); anchors are computed
from its posed group transform. No wheel/kicker meshes are invented; anchors point at
the real hull regions those subsystems occupy, matching the channels the mission logs.

### arm6
| id | anchor | label | description |
| --- | --- | --- | --- |
| j2 | shoulder joint housing | J2 shoulder servo | Lifts the whole arm; the joint that saturates at 12 Nm. |
| gripper | roll group / TCP | Parallel gripper | Grips the part at the tool centre point; grip state is logged 0 or 1. |
| drv3 | drvBay electronics bay | J2 servo driver | The drive electronics whose temperature creeps during the run. (Drive boards are numbered 1..6, so J2 runs on drv3; see arm6/data.js header.) |
| base | turret | Base turret | Rotates the arm between the two stations on q0. |

### drone
| id | anchor | label | description |
| --- | --- | --- | --- |
| m3 | motor 3 bell (rear-left) | Motor 3 | One of four brushless motors; each reports rpm and throttle. |
| battery | battery box | Battery | The 4S pack; voltage and current are logged at 25 Hz. |
| camera | gimbal lens | Survey camera | The mapping camera the lawnmower pattern exists to serve. |
| imu | body centre plate | Flight controller | Closes the attitude loop from roll, pitch and yaw. |

### donna
| id | anchor | label | description |
| --- | --- | --- | --- |
| head | donna:head | Stereo head | Two Basler cameras on the head pan-tilt find the ball. |
| imu | donna:torso | Torso IMU | Records the accelerations that tell a fall from a walk. |
| servos | donna:l_knee region (leg chain) | Leg servos | MX-106 servos drive the legs; diagnostics log their temperature and bus voltage. |
| compute | torso (lower) | Onboard compute | Each robot logs its own mission on the computer it carries. |

## 6. Success windows (real, authored, non-overlapping with failure)

| Mission | Window | Why |
| --- | --- | --- |
| arm6 | [26.0, 32.0] | Complete nominal cycle 5 (A to B and back), spans the hero pose at 30 s. Cycles are 6 s; fault cycle 9 starts at 50.0. |
| drone | [18.6, 27.7] | Full survey lane 1, before bearing wear begins at 32 s. |
| ssl | [0.5, 7.5] | First real live-play interval [0, 7.857] from kick-off; before every finding window (vision 22.5, dribbler 26, radio 30, kicker 46.3). |
| donna | [184.0, 190.0] | All three robots present, upright, unpenalized; Donna WALKING with a valid ball estimate; hero 187.6 inside; no fall within 5 s. |

Success screens show only the working mission: no error log, failure card, anomaly
shading, or failure-window chart treatment.

## 7. Failure findings (existing IDs, real windows)

| Mission | findingId | Chart window | Replay loop (round 5) | Lap | Plotted fields (direct-labeled) |
| --- | --- | --- | --- | --- | --- |
| arm6 | drop | [52, 60] | [55.8, 57.3] @ 0.4x | 3.8 s | /joints tau2, tau1, tau3 |
| drone | dip | [58, 66] | [60.7, 62.9] @ 1x | 2.2 s | /pos alt |
| ssl | kicker-charge | [46.3376, 62.74] | [53.477, 54.627] @ 0.4x | 2.9 s | /bot8/kicker kickerLevel, kickerMax |
| donna | jack-falls-foul-line | [145.878, 150.147] | [145.378, 147.398] @ 1x | 2.0 s | /imu accelMagMps2, pitchDeg, rollDeg |

Failure step: synchronized replay (finding camera/highlight) + chart focused on the
finding window. ROUND 5 split the two columns above: the replay loops `finding.loop`
(~0.5 s healthy, the failure, ~0.5 s of the settled fail state, capped at a 4 s wall-clock
lap) while the chart keeps plotting and shading the wider `finding.window` so the trace
still has its context. Missions with no `loop` loop their window, unchanged. Removed on this screen: timestamp readouts and the generic
reading/channel summary cards. Every plotted line gets a direct end-of-line pill label
with a short leader tick (chart.js addition), matching the wall.

## 8. Role x mission personalization contract

- Role routing (role.js): hobbyist -> arm6, engineer -> ssl, lead -> ssl,
  marketing -> donna, unknown/default -> arm6. Legacy aliases unchanged.
- The flow itself is identical for all roles; role changes COPY ONLY:
  step intro framing, failure implication line, first question phrasing, follow-up phrasing,
  and signup headline/body where the signup module already supports it. Mission truth
  (anatomy, windows, findings, telemetry, physics, scenes) is role-invariant.
- `core/flow-copy.js` holds all 16 mission x role variants:
  `flowCopy[mission][role] -> { missionIntro, failureIntro, firstQuestion, followUp }` with a
  `base` fallback per mission. Every variant must exist and be non-empty (gated).
- Analyst register stays worker-side (`worker/chat.js` registers, unchanged).
- Banned in all UI copy: meta-output labels ("Plain-language version", "Summary",
  "Analysis" as labels), em dashes.
- Disclosure discipline: ssl and donna card taglines and provenance surfaces keep their
  disclosure copy verbatim. The mission-library footer is removed; its honesty claims remain on
  the card tagline, robot-stage `context.provenance` and standing `chatProvenance`. The chat
  answers keep their claim-ledger-tested numbers; wall placeholder numbers are not ported.

## 9. Roster archive

- `robots/index.js` splits `ROBOTS_BY_ID` (all seven + generated) from a new
  `PICKER_ROBOTS = [arm6, drone, ssl, donna]` used by the picker and previews.
- sbr, rescue, battle: no picker card, no role routing, files/data/tests intact,
  direct routes `#/connect|demo/:id` still work through the legacy path.
- Generated g-* demos unchanged: legacy brief + legacy demo layout end to end.

## 10. Lifecycle and teardown contract

- One WebGL viewer context at a time on step/demo screens (picker previews keep their
  one-context rule). Steps robot/mission/failure reuse ONE flow-owned viewer instance
  across steps of the same mission (no context churn per step); it is disposed on
  leaving the connect-flow family or changing mission id.
- Timeline: flow owns a timeline for step screens (loop set to success/failure windows);
  demo route builds its own as today. No timeline leaks across routes (dispose on exit).
- Anatomy overlay: RAF-driven projection runs only while the robot step is live; it is
  removed with the viewer. Route churn leaves zero contexts, RAFs, observers, listeners
  (existing corrupt-meta leak harness extended to the step screens).
- Reduced motion: anatomy renders a static hero pose with labels attached (single
  projection pass, re-projected only on resize); success step renders a posed frame
  with a play affordance instead of auto-looping; step transitions drop animation.
- No WebGL: steps fall back to the SVG line art (existing picker fallback assets) with
  the same copy and CTAs; flow remains completable.

## 11. Verification matrix

New gates (SOL-T), following the browser-fixture pattern:

| Gate | Asserts |
| --- | --- |
| test:flow-roster (node) | PICKER_ROBOTS exactly [arm6, drone, ssl, donna]; ROBOTS_BY_ID retains all seven; role map matches Section 8 |
| test:flow-copy (node) | 16/16 variants exist, non-empty, with no retired debug-card field; no meta-output labels; no em dashes in any flow/step/UI copy including experience blocks |
| test:experience (node) | per active mission: exactly 4 anatomy parts whose anchors resolve against the scene anchor map; success window inside [0,duration], non-overlapping the selected failure finding window; failure findingId resolves; plottedFields subset of the finding channel fields; direct labels match plotted fields |
| test:flow-walk (browser) | full walk seat -> missions -> 3 steps -> chat surface at 1440x900 and 390x844; one primary CTA per step (DOM count); role variants via DOM assertions for all 16 combos (localStorage role x mission); success step shows no failure UI (no .evidence-on, no alert shading, no overlay banner); failure step has no timestamp/summary cards; the settled answer's inline block is a child of that answer, holds chart + causal line + the ONE live replay, shares the TimelineStore, and replaced the trailing chip row; a typed follow-up stays in the same transcript with no mode switch and no second context; the retired `/choose` hash redirects into the demo; generated-demo fixture falls back to legacy brief; reduced-motion and no-WebGL walks (block keeps chart + causal line, replay slot falls back to line art); no horizontal overflow at 390x844; console clean |
| test:flow-leaks (browser) | step/route churn AND demo churn: WebGL context live count flat, an inline block's context + chart + observers + listeners all released on route exit, no orphan RAF (corrupt-meta probe pattern) |
| visual captures (script, not in npm test) | 24 captures: 4 missions x {anatomy, success, failure} x {390x844, 1440x900}; per capture: pixel-variance frame difference across two timestamps (motion proof), timeline window assert, highlight assert, chart domain assert, console clean |

Existing suite: full `npm test` + `facts:fresh` must pass. Known updates required:
`ssl-preview-fallback` (7 -> 4 cards), frozen footer strings in ssl/battle/donna script
tests (footer pinned absent), `role-registers.test.mjs` (experience/flow-copy contract and
no retired choreo data), and `ssl-chart-absence` (inline evidence chart driver). Any other
test that fails must be
understood before it is edited; data/claim/deident/eager-size gates must pass unmodified
(experience config for ssl/donna rides the lazy side modules).

Baseline note: on clean main, 1657/1658 checks pass; the single failure is the donna
decode p95 perf gate under heavy parallel machine load; re-verified on a quiet machine
before delivery.

## 12. Assumptions recorded (no pause needed)

1. Wall's seat-fork "Continue" pattern replaces tap-to-advance: radio select + one
   Continue CTA. Escape link ("Just exploring...") is retained beneath as a secondary,
   non-primary affordance, consistent with "one primary action".
2. Wall's signup takeover frame shows a ghosted CTA and no dismissal; that state is a
   mock artifact and is NOT ported. The existing signup module (copy, close X, Escape,
   focus trap, cooldown, endpoint, analytics) is reused as-is; role headline variants
   only where signup.js already supports them.
3. Wall's ssl mission-library tagline ("Six autonomous robots playing a live soccer
   match") would delete a disclosure surface and misstate the replay as live; the card
   keeps its disclosure tagline. Wall titles are adopted ("6-axis pick and place",
   "Survey quadcopter", "SSL soccer fleet", "Donna, Jack & Rory").
4. Wall answer-card voltages (236/179/21 V) are placeholder; production keeps the
   claim-tested script copy.
5. The deleted "Choose how to debug" comparison durations and per-role card copy are removed
   from `flow-copy.js`; no dormant UI string keeps promising a separate proof screen.
6. The old guide engine, guide CTAs and `def.choreo` beat copy are removed. Role opener modules
   remain lazy and attach only the register and experience data the chat surface still uses.
7. Step screens live in one new static container `#screen-flow` (renaming avoided:
   existing four containers keep their ids).
8. `?robot=` continues to honor `alloy_brief_seen_<id>`; a seen brief goes straight to
   `#/demo/:id` (chat mode), matching current behavior.

## 12b. Post-review arbitrations (Fable, recorded after the adversarial pass)

- Drone success honesty: the scene's full-mission ghost trail carried alert-red future
  vertices onto the success step; fixed scene-side (neutral ghost, red only on the live
  trail once the playhead has actually crossed T_FAIL). Applies to every route.
- SSL IMU anatomy card: KEPT despite the reviewer's objection. The callout is mandated
  by the approved wall with verbatim copy, and the sentence describes the robot platform
  (consistent with the published-firmware-derived platform description in context.system's
  register), not the logged channels. The anchor is the top-plate centre of the real
  hull. arm6 drv3 card reads "J2 servo driver" per arm6/data.js (drive boards 1..6, J2
  runs on drv3); the plan's earlier J3 wording was wrong.
- Donna anatomy copy: the mission lane shipped conservative part descriptions without
  the Basler / MX-106 part numbers. The CAD manifest does carry those mesh names, so the
  specific copy is available if wanted later; the conservative copy is truthful and
  stands.
- Flow provenance: `context.provenance` is rendered on the three-step flow's robot stage for
  defs that carry it, before the mission and failure claims. Donna also keeps it on the failure
  step; SSL deliberately avoids repeating it below the failure evidence.
- Header acquisition CTAs no longer move with a layout mode, because there is no layout mode:
  both show on desktop for the whole session and the phone header stays one line. `Show why`
  is gone with the modes; the evidence it pointed at is already inside the answer.
- Failed lazy experience side modules clear the routing flag and fall back to the legacy
  brief instead of dead-ending the flow.

## 13. Sequencing

1. SOL-A lands the flow skeleton: routes, `#screen-flow`, flow.js state machine, picker
   4-card roster, role remap, redirects, analytics events, with arm6 static
   `experience` stub wired end to end (placeholder anchors OK).
2. In parallel after the skeleton commit: OPUS-V (viewer anchor overlay + camera modes +
   neutral banner), SOL-B (chart direct labels + focusWindow + chat/signup mode
   plumbing), OPUS-M1..M4 (per-mission experience + anchors + side modules).
3. SOL-A integrates, SOL-T writes gates, full suite + browser QA + captures.
4. Adversarial review, fixes, delivery.
